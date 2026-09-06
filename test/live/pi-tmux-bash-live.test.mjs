import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { PiRpcClient } from "../../dist/runtime/pi-rpc-client.mjs";
import {
  commandMatchesTaskBash,
  extractTimedOutBackground,
  findAutonomousCompletionTurn,
  gradePiTmuxBashTrace,
  loadPiTmuxBashEval,
  summarizePiTmuxBashEval,
} from "../support/pi-tmux-bash-grader.mjs";
import {
  assertHeadlessExtensionFixtureArgs,
  assertRequestedModelUsed,
  assertUserPiSettingsUnchanged,
  buildPiRpcArgs,
  buildTimedCommand,
  childEnvForIsolatedPi,
  createIsolatedTmuxWorkspace,
  inspectRunningTmuxChild,
  INTENDED_EVAL_COMMAND,
  INTENDED_EVAL_SCRIPT,
  LOCAL_PI_MODELS,
  killIsolatedTmuxSession,
  listIsolatedTmuxWindows,
  parseCommandRuntime,
  piSessionIdFromState,
  prepareIsolatedTmuxBashPackage,
  requireExplicitEvalModel,
  requireTmuxBashPackagePath,
  selectedPiModel,
  snapshotUserPiSettings,
  spawnPiRpc,
  standingPromptFile,
  UPSTREAM_NON_GIT_ERROR,
  waitFor,
  windowIdFromBashResult,
  windowsOwnedBy,
} from "../support/pi-tmux-bash-live-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET = loadPiTmuxBashEval(path.join(ROOT, "evals/pi-tmux-bash/scenarios.json"));
const evalEnabled = process.env.LARKIN_RUN_PI_TMUX_BASH_EVAL === "1";
const liveEnabled = process.env.LARKIN_RUN_PI_TMUX_BASH_LIVE === "1";
const repetitions = Number.parseInt(process.env.LARKIN_PI_TMUX_BASH_EVAL_REPETITIONS || "1", 10);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) {
  throw new Error("LARKIN_PI_TMUX_BASH_EVAL_REPETITIONS must be an integer from 1 to 3");
}
const scenarioFilter = new Set((process.env.LARKIN_PI_TMUX_BASH_EVAL_SCENARIOS || "")
  .split(",").map((item) => item.trim()).filter(Boolean));
const threshold = Number.parseFloat(process.env.LARKIN_PI_TMUX_BASH_EVAL_THRESHOLD || String(DATASET.threshold));
const requestedModel = (evalEnabled || liveEnabled) ? requireExplicitEvalModel() : null;

const workspaces = [];
afterAll(() => {
  for (const workspace of workspaces) {
    killIsolatedTmuxSession(workspace.sessionName);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

function subscribeTrace(client, trace) {
  client.subscribe((event) => trace.push(event));
}

function agentEndCount(trace) {
  return trace.filter((event) => event?.type === "agent_end").length;
}

async function waitUntilIdle(session, timeoutMs = 180_000) {
  const before = agentEndCount(session.trace);
  const last = [...session.trace].reverse().find((event) => event?.type === "agent_end" || event?.type === "tool_execution_start");
  if (last?.type === "agent_end" && !session.trace.slice(session.trace.indexOf(last) + 1).some((event) => event?.type === "tool_execution_start")) {
    return last;
  }
  return waitFor(session.trace, (event) => event?.type === "agent_end" && agentEndCount(session.trace) > before, timeoutMs);
}

async function promptWhenIdle(session, message) {
  try {
    await waitUntilIdle(session, 30_000);
  } catch {
    // 仍在处理则走 followUp，避免写入用户设置或重启进程
  }
  const before = agentEndCount(session.trace);
  try {
    await hostPrompt(session, message);
  } catch (error) {
    if (!/already processing/i.test(String(error))) throw error;
    await hostPrompt(session, message, { streamingBehavior: "followUp" });
  }
  return waitFor(session.trace, (event) => event?.type === "agent_end" && agentEndCount(session.trace) > before, 180_000);
}

async function startIsolatedPi({ appendPrompt = true, git = true, workspace } = {}) {
  const snapshot = snapshotUserPiSettings();
  const source = requireTmuxBashPackagePath();
  const loadMode = "extension";
  if (!workspace) {
    workspace = createIsolatedTmuxWorkspace({
      prefix: git ? "larkin-tmux-eval-" : "larkin-tmux-nongit-",
      git,
    });
    workspaces.push(workspace);
  }
  let packagePath = source;
  if (loadMode === "extension") {
    packagePath = prepareIsolatedTmuxBashPackage(source, workspace.packageDir);
  }
  const extraArgs = [];
  if (appendPrompt) {
    const standing = new ContextPromptBuilder().build({ agentId: "cli_tmux_eval", runtime: "pi" });
    extraArgs.push("--append-system-prompt", standingPromptFile(workspace, standing.content));
  }
  const model = requireExplicitEvalModel();
  const args = buildPiRpcArgs({ packagePath, loadMode, model, extraArgs });
  const child = spawnPiRpc({ args, cwd: workspace.workDir, env: childEnvForIsolatedPi(workspace) });
  const trace = [];
  const client = new PiRpcClient(child, { requestTimeoutMs: 30_000, inputTimeoutMs: 180_000, inputMaxTimeoutMs: 600_000 });
  subscribeTrace(client, trace);
  const state = await client.request("get_state");
  const selected = selectedPiModel(state);
  const modelRecord = assertRequestedModelUsed(model, selected);
  if (loadMode === "extension") assertHeadlessExtensionFixtureArgs(args, packagePath);
  console.log(`[live] pi ${loadMode} gitFixture=${workspace.gitFixture} package=${packagePath || "discovery"} requested=${modelRecord.requested} actual=${modelRecord.actual} session=${workspace.sessionName} args=${args.join(" ")}`);
  return {
    snapshot, workspace, child, client, trace, loadMode, packagePath, state,
    requestedModel: model, selectedModel: selected, args, hostPromptCount: 0,
    piSessionId: piSessionIdFromState(state),
  };
}

async function hostPrompt(session, message, extra = {}) {
  session.hostPromptCount += 1;
  return session.client.request("prompt", { message, ...extra });
}

async function stopIsolatedPi(session, { keepSession = false } = {}) {
  try { await session.client.close(); } catch { /* already closed */ }
  if (!keepSession) killIsolatedTmuxSession(session.workspace.sessionName);
  assertUserPiSettingsUnchanged(session.snapshot);
}

test("pi-tmux-bash eval starts from the fixed scenario dataset", () => {
  assert.equal(DATASET.model.selection, "openai-codex/gpt-5.6-luna");
  assert.equal(DATASET.model.requires_explicit_env, true);
  assert.deepEqual(DATASET.model.local_available, [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-luna",
    "zai-coding-cn/glm5.3",
  ]);
  assert.deepEqual(DATASET.model.not_available_locally, ["opencode-go/deepseek-v4-flash"]);
  assert.equal(LOCAL_PI_MODELS.includes(DATASET.model.selection), true);
  assert.match(INTENDED_EVAL_COMMAND, /LARKIN_PI_TMUX_BASH_EVAL_MODEL=openai-codex\/gpt-5\.6-luna/);
  if (requestedModel) assert.equal(LOCAL_PI_MODELS.includes(requestedModel), true);
  assert.equal(DATASET.standing_prompt_version, "larkin-standing-v30");
  assert.equal(DATASET.workspace.success_path, "isolated-git-fixture");
  assert.equal(DATASET.workspace.production_claim, "not-assumed");
  assert.match(DATASET.workspace.larkin_note, /does not fall back to native bash/);
  assert.equal(DATASET.grader.synthetic_fixtures, "unit-only");
  assert.equal(DATASET.harness.headless, true);
  assert.equal(DATASET.harness.tui_independent, true);
  assert.equal(DATASET.harness.intended_script, INTENDED_EVAL_SCRIPT);
  assert.deepEqual(DATASET.harness.pi_args, ["--mode", "rpc", "--no-session", "--no-extensions", "-e"]);
  assert.equal(DATASET.core_acceptance_rate, 1);
  assert.match(DATASET.threshold_rationale, /deterministic/);
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "long-command-backgrounds-without-subagent",
    "wait-timeout-is-not-failure",
    "inspect-by-returned-id",
    "stop-by-returned-id",
    "completion-stays-in-originating-target",
    "no-forced-subagent-for-known-long",
    "natural-long-local-command",
  ]);
});

async function runScenario(scenario) {
  const session = await startIsolatedPi();
  try {
    await hostPrompt(session, scenario.prompt);
    await waitFor(session.trace, (event) => event?.type === "agent_end", 300_000);
    if (scenario.wait_for_completion) {
      try {
        const firstEnd = session.trace.find((event) => event?.type === "agent_end");
        await waitFor(session.trace, () => findAutonomousCompletionTurn(session.trace, firstEnd), 180_000);
      } catch {
        // 由 rubric 判定缺失有序 autonomous completion
      }
    }
    return gradePiTmuxBashTrace(scenario, session.trace);
  } finally {
    await stopIsolatedPi(session);
  }
}

for (const scenario of DATASET.scenarios) {
  if (scenarioFilter.size > 0 && !scenarioFilter.has(scenario.id)) continue;
  test.skipIf(!evalEnabled)(`pi-tmux-bash scenario ${scenario.id} (${repetitions}x, threshold ${threshold})`, async () => {
    const graded = [];
    for (let i = 0; i < repetitions; i++) graded.push(await runScenario(scenario));
    const summary = summarizePiTmuxBashEval(graded);
    console.log(`[eval] ${scenario.id}: ${summary.passed}/${summary.total} passed (rate ${summary.rate})`);
    for (const grade of graded) {
      if (!grade.passed) console.log(`[eval]   failed rubric: ${JSON.stringify(grade.results)}`);
    }
    assert.ok(summary.rate >= threshold,
      `scenario ${scenario.id} pass rate ${summary.rate} below threshold ${threshold}`);
  }, { timeout: 900_000 });
}

test.skipIf(!liveEnabled)("opt-in live RPC: isolated git fixture short command (not a production/non-git claim)", async () => {
  const session = await startIsolatedPi({ git: true });
  try {
    assert.equal(session.workspace.gitFixture, true);
    assert.equal(fs.existsSync(path.join(session.workspace.workDir, ".git")), true);
    await hostPrompt(session, [
      "Use only currently available tools and synthetic local commands. No Feishu.",
      "Run exactly: echo larkin-tmux-git-fixture",
      "Then end the turn. Do not use an Agent or subagent.",
    ].join(" "));
    await waitFor(session.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = session.trace.find((event) => event?.type === "tool_execution_end" && event.toolName === "bash");
    const bashText = bashEnd?.result ? JSON.stringify(bashEnd.result) : "";
    assert.doesNotMatch(bashText, UPSTREAM_NON_GIT_ERROR);
    assert.match(bashText, /larkin-tmux-git-fixture/);
    console.log("[live] git fixture short command succeeded; this is not a production or non-git claim");
  } finally {
    await stopIsolatedPi(session);
  }
}, { timeout: 300_000 });

test.skipIf(!liveEnabled)("opt-in live RPC: non-git cwd currently fails with upstream git-root error", async () => {
  const session = await startIsolatedPi({ git: false });
  try {
    assert.equal(session.workspace.gitFixture, false);
    assert.equal(fs.existsSync(path.join(session.workspace.workDir, ".git")), false);
    await hostPrompt(session, [
      "Use only currently available tools and synthetic local commands. No Feishu.",
      "Run exactly: echo larkin-tmux-nongit",
      "If the tool refuses this workspace, report the limitation. Other authorized tools remain available.",
      "Do not use an Agent or subagent.",
    ].join(" "));
    await waitFor(session.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = session.trace.find((event) => event?.type === "tool_execution_end" && event.toolName === "bash");
    const bashText = bashEnd?.result ? JSON.stringify(bashEnd.result) : String(bashEnd?.resultText || "");
    assert.match(bashText, UPSTREAM_NON_GIT_ERROR);
    assert.equal(listIsolatedTmuxWindows(session.workspace.sessionName).length, 0);
    assert.equal(session.trace.some((event) =>
      event?.type === "tool_execution_start" && ["Agent", "supervised_start"].includes(event.toolName)), false);
    console.log("[live] non-git cwd currently failed as expected; do not treat this as production support");
  } finally {
    await stopIsolatedPi(session);
  }
}, { timeout: 300_000 });

test.skipIf(!liveEnabled)("opt-in live RPC: >60s timed-out-background and unprompted tmux-bash-completion turn", async () => {
  const session = await startIsolatedPi({ git: true });
  const marker = `LARKIN_TMUX_LIVE_${Date.now()}`;
  const timedCommand = buildTimedCommand({ sleepSeconds: 65, marker });
  try {
    assertHeadlessExtensionFixtureArgs(session.args, session.packagePath);
    assert.equal(session.selectedModel, session.requestedModel);
    await hostPrompt(session, [
      "Use only currently available tools and synthetic local commands. No Feishu.",
      `Start exactly: ${timedCommand}`,
      "Use a short wait timeout (2-5 seconds) so the wait returns first. That timeout is not failure.",
      "Report any identifier and end the turn. Do not kill the process. Do not send a second host prompt.",
    ].join(" "));
    const bashStart = await waitFor(session.trace, (event) =>
      event?.type === "tool_execution_start" && event.toolName === "bash"
      && commandMatchesTaskBash(event.args?.command, timedCommand), 180_000);
    const toolStartedAt = Date.now();
    assert.ok(bashStart, "lifetime is measured from the matching bash tool_execution_start, not the pre-model prompt");
    await waitFor(session.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = session.trace.find((event) => event?.type === "tool_execution_end" && event.toolName === "bash");
    const bashText = bashEnd?.result ? JSON.stringify(bashEnd.result) : "";
    assert.ok(extractTimedOutBackground(bashEnd) || extractTimedOutBackground(session.trace),
      `bash result must carry outcome timed-out-background: ${bashText.slice(0, 400)}`);
    const windowId = windowIdFromBashResult(bashText);
    assert.ok(windowId, `window id must come from the matching bash result, not a tmux list or .out name: ${bashText.slice(0, 400)}`);
    const childAfterTimeout = inspectRunningTmuxChild(session.workspace.sessionName, windowId);
    assert.equal(childAfterTimeout.running, true,
      `actual child under tmux ${windowId} must still be running after wait timeout: ${JSON.stringify(childAfterTimeout.processes)}`);

    const remaining = 60_000 - (Date.now() - toolStartedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining + 250));
    const childAfter60 = inspectRunningTmuxChild(session.workspace.sessionName, windowId);
    assert.equal(childAfter60.running, true,
      `child must still be running >60s after tool_execution_start: elapsed=${Date.now() - toolStartedAt}ms ${JSON.stringify(childAfter60.processes)}`);
    assert.ok(Date.now() - toolStartedAt > 60_000, "liveness clock is the matching tool start, not leftover autoClose=false windows");
    console.log(`[live] timed-out-background ${windowId} childPid=${childAfter60.panePid} elapsedMs=${Date.now() - toolStartedAt} requested=${session.requestedModel} actual=${session.selectedModel}`);

    const firstEnd = await waitFor(session.trace, (event) => event?.type === "agent_end", 180_000);
    assert.equal(session.hostPromptCount, 1, "first turn must be the only host prompt so far");

    await waitFor(session.trace, () => findAutonomousCompletionTurn(session.trace, firstEnd), 90_000);
    assert.equal(session.hostPromptCount, 1, "completion handling must be an unprompted autonomous turn");
    const unprompted = findAutonomousCompletionTurn(session.trace, firstEnd);
    assert.ok(unprompted?.completion, "unprompted turn must carry tmux-bash-completion");
    assert.ok(unprompted.turnStart, "post-completion handling requires turn_start");
    assert.ok(unprompted.assistantText.trim(), "post-completion handling requires assistant output");
    assert.ok(unprompted.settled, "post-completion handling requires agent_end or agent_settled");
    const completionText = JSON.stringify(unprompted.completion);
    assert.match(completionText, new RegExp(marker));
    assert.match(unprompted.assistantText, new RegExp(marker));
    const runtime = parseCommandRuntime(completionText);
    assert.ok(runtime, `completion must include in-command start/end timestamps: ${completionText.slice(0, 400)}`);
    assert.ok(runtime.runtimeMs > 60_000,
      `in-command runtime ${runtime.runtimeMs}ms must exceed 60s (start=${runtime.startSec} end=${runtime.endSec})`);
    console.log(`[live] autonomous completion settled; in-command runtime ${runtime.runtimeMs}ms`);
    await waitUntilIdle(session, 60_000).catch(() => {});

    if (!session.trace.some((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "peek"
      && String(event.args?.window) === windowId)) {
      await promptWhenIdle(session,
        `Inspect/peek only window ${windowId} with the current tmux tool, then end the turn. Do not kill it. No Feishu.`);
    }
    const peek = session.trace.find((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "peek"
      && String(event.args?.window) === windowId);
    assert.ok(peek, "peek must use the bash-returned window id");

    await promptWhenIdle(session,
      `Start exactly: sleep 180 && echo ${marker}-cancel. After you have a window id from that bash result, peek it, then stop/kill that same id. No Feishu, no Agent/subagent.`);
    await waitFor(session.trace, (event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "kill", 180_000);
    const kill = [...session.trace].reverse().find((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "kill");
    assert.ok(kill?.args?.window, "cancel must use a returned window id");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const afterKill = listIsolatedTmuxWindows(session.workspace.sessionName);
    assert.equal(afterKill.some((window) => window.id === kill.args.window), false,
      `killed window ${kill.args.window} must not remain`);
    assert.equal(session.trace.some((event) =>
      event?.type === "tool_execution_start" && ["Agent", "supervised_start"].includes(event.toolName)), false);
    console.log(`[live] cancelled ${kill.args.window}`);
  } finally {
    await stopIsolatedPi(session);
  }
}, { timeout: 900_000 });

test.skipIf(!liveEnabled)("opt-in live RPC: shared tmux session isolates two Pi owners", async () => {
  const workspace = createIsolatedTmuxWorkspace({ prefix: "larkin-tmux-shared-", git: true });
  workspaces.push(workspace);
  const ownerA = await startIsolatedPi({ workspace });
  const ownerB = await startIsolatedPi({ workspace });
  const marker = `LARKIN_TMUX_OWNER_${Date.now()}`;
  const command = `sleep 90 && echo ${marker}`;
  try {
    assert.equal(ownerA.workspace.sessionName, ownerB.workspace.sessionName);
    assert.equal(ownerA.selectedModel, ownerA.requestedModel);
    assert.equal(ownerB.selectedModel, ownerB.requestedModel);
    if (ownerA.piSessionId && ownerB.piSessionId) {
      assert.notEqual(ownerA.piSessionId, ownerB.piSessionId, "two Pi owners must have distinct session ids");
    }

    await hostPrompt(ownerA, [
      "Use only currently available tools and synthetic local commands. No Feishu.",
      `Start exactly: ${command}`,
      "Use a short wait timeout (2-5 seconds). Report the returned window id and end the turn. Do not kill it.",
    ].join(" "));
    await waitFor(ownerA.trace, (event) =>
      event?.type === "tool_execution_start" && event.toolName === "bash"
      && commandMatchesTaskBash(event.args?.command, command), 180_000);
    await waitFor(ownerA.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = ownerA.trace.find((event) => event?.type === "tool_execution_end" && event.toolName === "bash");
    const bashText = bashEnd?.result ? JSON.stringify(bashEnd.result) : "";
    const windowId = windowIdFromBashResult(bashText);
    assert.ok(windowId, `owner A window id must come from its matching bash result: ${bashText.slice(0, 400)}`);
    const child = inspectRunningTmuxChild(workspace.sessionName, windowId);
    assert.equal(child.running, true, `owner A child must be running: ${JSON.stringify(child.processes)}`);
    const listed = listIsolatedTmuxWindows(workspace.sessionName);
    const ownerWindow = listed.find((window) => window.id === windowId);
    assert.ok(ownerWindow?.piSessionId, `shared session window ${windowId} must record @pi-tmux-bash-pi-session-id`);
    if (ownerA.piSessionId) {
      assert.equal(ownerWindow.piSessionId, ownerA.piSessionId);
    }

    await hostPrompt(ownerB, [
      "Use only currently available tools. No Feishu.",
      `List tmux windows. Then peek ${windowId} and kill ${windowId}.`,
      "If the tools refuse that id, report the refusal and end the turn. Do not start a new command.",
    ].join(" "));
    await waitFor(ownerB.trace, (event) => event?.type === "agent_end", 180_000);
    const bTmux = ownerB.trace.filter((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux");
    const bList = bTmux.find((event) => event.args?.action === "list");
    const bPeek = bTmux.find((event) => event.args?.action === "peek" && String(event.args?.window) === windowId);
    const bKill = bTmux.find((event) => event.args?.action === "kill" && String(event.args?.window) === windowId);
    assert.ok(bList || bPeek || bKill, "owner B must use the tmux tool against the shared session");
    const bEnds = ownerB.trace.filter((event) => event?.type === "tool_execution_end" && event.toolName === "tmux");
    const bText = bEnds.map((event) => event.result ? JSON.stringify(event.result) : "").join("\n");
    if (ownerB.piSessionId) {
      assert.equal(windowsOwnedBy(listIsolatedTmuxWindows(workspace.sessionName), ownerB.piSessionId)
        .some((window) => window.id === windowId), false);
    }
    if (bList) {
      const listEnd = bEnds.find((event) => /window\(s\)|Background session/i.test(JSON.stringify(event.result || "")));
      const listText = listEnd ? JSON.stringify(listEnd.result) : "";
      if (listText) assert.doesNotMatch(listText, new RegExp(`${windowId.replace("@", "\\@")}\\b`));
    }
    if (bPeek || bKill) {
      assert.match(bText, /No bash-created tmux window/i);
    }
    const still = inspectRunningTmuxChild(workspace.sessionName, windowId);
    assert.equal(still.running, true, "owner B must not kill owner A's child");
    assert.ok(listIsolatedTmuxWindows(workspace.sessionName).some((window) => window.id === windowId),
      "owner A's window must remain after owner B list/peek/kill");
    console.log(`[live] shared session ${workspace.sessionName} isolated ${windowId} ownerA=${ownerWindow.piSessionId} ownerB=${ownerB.piSessionId || "unknown"}`);
  } finally {
    await stopIsolatedPi(ownerB, { keepSession: true });
    await stopIsolatedPi(ownerA);
  }
}, { timeout: 600_000 });
