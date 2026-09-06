import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { PiRpcClient } from "../../dist/runtime/pi-rpc-client.mjs";
import {
  extractTmuxBashCompletion,
  gradePiTmuxBashTrace,
  loadPiTmuxBashEval,
  summarizePiTmuxBashEval,
} from "../support/pi-tmux-bash-grader.mjs";
import {
  assertUserPiSettingsUnchanged,
  buildPiRpcArgs,
  childEnvForIsolatedPi,
  createIsolatedTmuxWorkspace,
  discoverIsolatedTmuxWindows,
  killIsolatedTmuxSession,
  listIsolatedTmuxWindows,
  prepareIsolatedTmuxBashPackage,
  resolveTmuxBashLoadMode,
  resolveTmuxBashPackagePath,
  snapshotUserPiSettings,
  spawnPiRpc,
  standingPromptFile,
  UPSTREAM_NON_GIT_ERROR,
  waitFor,
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
const model = String(process.env.LARKIN_PI_TMUX_BASH_EVAL_MODEL || DATASET.model.selection).trim();

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
    await session.client.request("prompt", { message });
  } catch (error) {
    if (!/already processing/i.test(String(error))) throw error;
    await session.client.request("prompt", { message, streamingBehavior: "followUp" });
  }
  return waitFor(session.trace, (event) => event?.type === "agent_end" && agentEndCount(session.trace) > before, 180_000);
}

async function startIsolatedPi({ appendPrompt = true, git = true } = {}) {
  const snapshot = snapshotUserPiSettings();
  const source = resolveTmuxBashPackagePath();
  const loadMode = resolveTmuxBashLoadMode();
  if (loadMode === "extension" && !source) {
    throw new Error("LARKIN_PI_TMUX_BASH_PACKAGE or the isolated published 0.0.12 package is required for extension load");
  }
  const workspace = createIsolatedTmuxWorkspace({
    prefix: git ? "larkin-tmux-eval-" : "larkin-tmux-nongit-",
    git,
  });
  workspaces.push(workspace);
  let packagePath = source;
  if (loadMode === "extension") {
    packagePath = prepareIsolatedTmuxBashPackage(source, workspace.packageDir);
  }
  const extraArgs = [];
  if (appendPrompt) {
    const standing = new ContextPromptBuilder().build({ agentId: "cli_tmux_eval", runtime: "pi" });
    extraArgs.push("--append-system-prompt", standingPromptFile(workspace, standing.content));
  }
  const args = buildPiRpcArgs({ packagePath, loadMode, model, extraArgs });
  const child = spawnPiRpc({ args, cwd: workspace.workDir, env: childEnvForIsolatedPi(workspace) });
  const trace = [];
  const client = new PiRpcClient(child, { requestTimeoutMs: 30_000, inputTimeoutMs: 180_000, inputMaxTimeoutMs: 600_000 });
  subscribeTrace(client, trace);
  const state = await client.request("get_state");
  const selected = state?.model?.provider && state?.model?.id
    ? `${state.model.provider}/${state.model.id}`
    : state?.model?.id || "unknown";
  console.log(`[live] pi ${loadMode} gitFixture=${workspace.gitFixture} package=${packagePath || "discovery"} model=${selected} session=${workspace.sessionName}`);
  return { snapshot, workspace, child, client, trace, loadMode, packagePath, state, selectedModel: selected };
}

async function stopIsolatedPi(session) {
  try { await session.client.close(); } catch { /* already closed */ }
  killIsolatedTmuxSession(session.workspace.sessionName);
  assertUserPiSettingsUnchanged(session.snapshot);
}

test("pi-tmux-bash eval starts from the fixed scenario dataset", () => {
  assert.equal(DATASET.model.selection, "opencode-go/deepseek-v4-flash");
  assert.equal(DATASET.standing_prompt_version, "larkin-standing-v30");
  assert.equal(DATASET.workspace.success_path, "isolated-git-fixture");
  assert.equal(DATASET.workspace.production_claim, "not-assumed");
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "long-command-backgrounds-without-subagent",
    "wait-timeout-is-not-failure",
    "inspect-by-returned-id",
    "stop-by-returned-id",
    "completion-stays-in-originating-target",
    "no-forced-subagent-for-known-long",
  ]);
});

async function runScenario(scenario) {
  const session = await startIsolatedPi();
  try {
    await session.client.request("prompt", { message: scenario.prompt });
    await waitFor(session.trace, (event) => event?.type === "agent_end", 300_000);
    if (scenario.wait_for_completion) {
      try {
        await waitFor(session.trace, (event) => extractTmuxBashCompletion(event) || extractTmuxBashCompletion(session.trace), 180_000);
        await new Promise((resolve) => setTimeout(resolve, 8_000));
      } catch {
        // 由 rubric 判定缺失 completion
      }
    }
    return gradePiTmuxBashTrace(scenario, session.trace);
  } finally {
    await stopIsolatedPi(session);
  }
}

for (const scenario of DATASET.scenarios) {
  if (scenarioFilter.size > 0 && !scenarioFilter.has(scenario.id)) continue;
  test(`pi-tmux-bash scenario ${scenario.id} (${repetitions}x, threshold ${threshold})`, async () => {
    if (!evalEnabled) return;
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

test("opt-in live RPC: isolated git fixture short command (not a production/non-git claim)", async () => {
  if (!liveEnabled) return;
  const session = await startIsolatedPi({ git: true });
  try {
    assert.equal(session.workspace.gitFixture, true);
    assert.equal(fs.existsSync(path.join(session.workspace.workDir, ".git")), true);
    await session.client.request("prompt", {
      message: [
        "Use only currently available tools and synthetic local commands. No Feishu.",
        "Run exactly: echo larkin-tmux-git-fixture",
        "Then end the turn. Do not use an Agent or subagent.",
      ].join(" "),
    });
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

test("opt-in live RPC: non-git cwd currently fails with upstream git-root error", async () => {
  if (!liveEnabled) return;
  const session = await startIsolatedPi({ git: false });
  try {
    assert.equal(session.workspace.gitFixture, false);
    assert.equal(fs.existsSync(path.join(session.workspace.workDir, ".git")), false);
    await session.client.request("prompt", {
      message: [
        "Use only currently available tools and synthetic local commands. No Feishu.",
        "Run exactly: echo larkin-tmux-nongit",
        "If the tool refuses this workspace, report the limitation and end the turn.",
        "Do not invent a second background mechanism. Do not use an Agent or subagent.",
      ].join(" "),
    });
    await waitFor(session.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = session.trace.find((event) => event?.type === "tool_execution_end" && event.toolName === "bash");
    const bashText = bashEnd?.result ? JSON.stringify(bashEnd.result) : String(bashEnd?.resultText || "");
    assert.match(bashText, UPSTREAM_NON_GIT_ERROR);
    assert.equal(discoverIsolatedTmuxWindows(session.workspace).length, 0);
    assert.equal(session.trace.some((event) =>
      event?.type === "tool_execution_start" && ["Agent", "supervised_start"].includes(event.toolName)), false);
    console.log("[live] non-git cwd currently failed as expected; do not treat this as production support");
  } finally {
    await stopIsolatedPi(session);
  }
}, { timeout: 300_000 });

test("opt-in live RPC: >60s tmux process, peek, cancel, and completion followUp", async () => {
  if (!liveEnabled) return;
  const session = await startIsolatedPi({ git: true });
  const marker = `LARKIN_TMUX_LIVE_${Date.now()}`;
  const startedAt = Date.now();
  try {
    await session.client.request("prompt", {
      message: [
        "Use only currently available tools and synthetic local commands. No Feishu.",
        `Start exactly: sleep 65 && echo ${marker}`,
        "Use a short wait timeout (2-5 seconds) so the wait returns first. That timeout is not failure.",
        "Report any identifier and end the turn. Do not kill the process.",
      ].join(" "),
    });
    await waitFor(session.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = session.trace.find((event) => event?.type === "tool_execution_end" && event.toolName === "bash");
    const bashText = bashEnd?.result ? JSON.stringify(bashEnd.result) : "";
    assert.match(bashText, /still running|background tmux|started in background/i);
    let windows = discoverIsolatedTmuxWindows(session.workspace);
    if (windows.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      windows = discoverIsolatedTmuxWindows(session.workspace);
    }
    const windowId = (bashText.match(/@\d+/) || [])[0] || windows[0]?.id;
    assert.ok(windowId, `must resolve a tmux window id from RPC or isolated session: ${bashText.slice(0, 400)} windows=${JSON.stringify(windows)}`);
    console.log(`[live] backgrounded ${windowId} after wait timeout; isolating session=${session.workspace.sessionName}`);

    const remaining = 61_000 - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    const still = discoverIsolatedTmuxWindows(session.workspace);
    assert.ok(still.some((window) => window.id === windowId),
      `tmux window ${windowId} must still exist after 60s in ${session.workspace.sessionName}: ${JSON.stringify(still)}`);
    assert.ok(Date.now() - startedAt >= 60_000, "process must be observed after 60 seconds");
    console.log(`[live] window ${windowId} still alive after ${Date.now() - startedAt}ms`);

    if (!session.trace.some((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "peek")) {
      await promptWhenIdle(session,
        `Inspect/peek only window ${windowId} with the current tmux tool, then end the turn. Do not kill it. No Feishu.`);
    }
    const peek = session.trace.find((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "peek");
    assert.ok(peek, "peek must go through the tmux tool RPC");
    assert.equal(String(peek.args.window), windowId);

    await waitFor(session.trace, (event) => extractTmuxBashCompletion(event) || extractTmuxBashCompletion(session.trace), 90_000);
    const completion = extractTmuxBashCompletion(session.trace);
    assert.ok(completion, "completion followUp must arrive through RPC");
    assert.match(JSON.stringify(completion), new RegExp(marker));
    console.log("[live] completion followUp received");
    await waitUntilIdle(session, 60_000).catch(() => {});

    await promptWhenIdle(session,
      `Start exactly: sleep 180 && echo ${marker}-cancel. After you have a window id, peek it, then stop/kill that same id. No Feishu, no Agent/subagent.`);
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
