import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import {
  ContextPromptBuilder,
  LARKIN_STANDING_PROMPT_VERSION,
  PI_TMUX_BASH_GUIDANCE,
} from "../../../dist/agent/context-prompt.mjs";
import {
  extractTimedOutBackground,
  extractTmuxBashCompletion,
  findUnpromptedCompletionTurn,
  gradePiTmuxBashTrace,
  loadPiTmuxBashEval,
  summarizePiTmuxBashEval,
} from "../../support/pi-tmux-bash-grader.mjs";
import {
  DEFAULT_ISOLATED_PACKAGE,
  HEADLESS_PI_RPC_PREFIX,
  INTENDED_EVAL_SCRIPT,
  UPSTREAM_NON_GIT_ERROR,
  assertHeadlessExtensionFixtureArgs,
  assertUserPiSettingsUnchanged,
  buildPiRpcArgs,
  createIsolatedTmuxWorkspace,
  killIsolatedTmuxSession,
  packageHasResolvableDependencies,
  prepareIsolatedTmuxBashPackage,
  readPinnedPluginManifest,
  resolveTmuxBashLoadMode,
  resolveTmuxBashPackagePath,
  snapshotUserPiSettings,
} from "../../support/pi-tmux-bash-live-harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATASET = loadPiTmuxBashEval(path.join(ROOT, "evals/pi-tmux-bash/scenarios.json"));

function buildPrompt(runtime = "pi") {
  return new ContextPromptBuilder().build({ agentId: "cli_eval", runtime });
}

function completionEvent(marker) {
  return {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [{ type: "custom", customType: "tmux-bash-completion", content: `Command finished\n${marker}` }],
    }],
  };
}

test("pi-tmux-bash dataset pins version, threshold, external plugin 0.0.12, and standing v30", () => {
  assert.equal(DATASET.dataset, "pi-tmux-bash");
  assert.equal(DATASET.version, 1);
  assert.equal(DATASET.standing_prompt_version, "larkin-standing-v30");
  assert.equal(DATASET.model.standing_prompt_version, "larkin-standing-v30");
  assert.equal(DATASET.workspace.success_path, "isolated-git-fixture");
  assert.equal(DATASET.workspace.production_claim, "not-assumed");
  assert.match(DATASET.workspace.upstream_limitation, /not in a git repository/);
  assert.match(DATASET.workspace.larkin_note, /usually not git/);
  assert.equal(DATASET.harness.headless, true);
  assert.equal(DATASET.harness.tui_independent, true);
  assert.equal(DATASET.harness.intended_script, INTENDED_EVAL_SCRIPT);
  assert.deepEqual(DATASET.harness.pi_args, ["--mode", "rpc", "--no-session", "--no-extensions", "-e"]);
  assert.equal(DATASET.model.selection, "opencode-go/deepseek-v4-flash");
  assert.equal(DATASET.threshold, 0.6);
  assert.equal(DATASET.grader.version, 1);
  assert.equal(DATASET.grader.threshold, 0.6);
  assert.equal(DATASET.plugin.name, "@richardgill/pi-tmux-bash");
  assert.equal(DATASET.plugin.version, "0.0.12");
  assert.equal(DATASET.plugin.distribution, "external-user-installed");
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "long-command-backgrounds-without-subagent",
    "wait-timeout-is-not-failure",
    "inspect-by-returned-id",
    "stop-by-returned-id",
    "completion-stays-in-originating-target",
    "no-forced-subagent-for-known-long",
  ]);
});

test("standing prompt v30 replaces forced subagent rules with conditional tmux-backed bash guidance", () => {
  assert.equal(LARKIN_STANDING_PROMPT_VERSION, "larkin-standing-v30");
  const pi = buildPrompt("pi");
  assert.equal(pi.version, "larkin-standing-v30");
  assert.match(pi.content, /## Long-running commands \(pi\)/);
  for (const line of PI_TMUX_BASH_GUIDANCE) {
    assert.equal(pi.content.includes(line), true, line);
  }
  assert.match(pi.content, /If the current tools include a tmux-backed bash/);
  assert.match(pi.content, /timeout is not process failure/);
  assert.match(pi.content, /identifiers those tools return/);
  assert.match(pi.content, /originating conversation/);
  assert.match(pi.content, /Do not assume tmux or extra inspect\/stop tools exist unless they appear in the current tool list/);
  assert.match(pi.content, /If an available tool refuses the current workspace/);
  assert.match(pi.content, /Do not invent a second background mechanism/);
  assert.doesNotMatch(pi.content, /## Background subagents \(pi\)/);
  assert.doesNotMatch(pi.content, /hard-capped at 60/);
  assert.doesNotMatch(pi.content, /Total lifetime is 600s/);
  assert.doesNotMatch(pi.content, /MUST use the Agent tool/);
  assert.doesNotMatch(pi.content, /run_in_background:\s*true/);
  assert.doesNotMatch(pi.content, /nohup/);
  assert.doesNotMatch(pi.content, /supervised_start/);
  assert.doesNotMatch(pi.content, /ONLY supported background mechanism/);
  assert.doesNotMatch(pi.content, /getGitRoot|git init|git repository|production workspace|Larkin Agent workspace/i);
  const remainder = PI_TMUX_BASH_GUIDANCE.reduce((text, line) => text.replaceAll(line, ""), pi.content);
  assert.doesNotMatch(remainder, /tmux-backed bash/);
  const other = buildPrompt("codex");
  assert.doesNotMatch(other.content, /## Long-running commands \(pi\)/);
  assert.doesNotMatch(other.content, /tmux-backed bash/);
});

test("golden traces reach the registered threshold and reject forced subagent routing", () => {
  const traces = {
    "long-command-backgrounds-without-subagent": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 8 && echo larkin-tmux-eval-long", timeout: 5, timeoutAction: "background" } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Still running after 5s in background tmux window @42" }] } },
      { type: "agent_end" },
    ],
    "wait-timeout-is-not-failure": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 12 && echo larkin-tmux-eval-timeout", timeout: 3 } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Still running after 3s in background tmux. Use tmux peek/list/kill. @99" }], details: { outcome: "timed-out-background" } } },
      { type: "agent_end" },
    ],
    "inspect-by-returned-id": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 20 && echo larkin-tmux-eval-peek" } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Started in background tmux window: sleep @77" }] } },
      { type: "tool_execution_start", toolName: "tmux", args: { action: "peek", window: "@77" } },
      { type: "tool_execution_end", toolName: "tmux", result: { content: [{ type: "text", text: "peek @77" }] } },
      { type: "agent_end" },
    ],
    "stop-by-returned-id": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 120 && echo larkin-tmux-eval-kill" } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Started in background tmux window @88" }] } },
      { type: "tool_execution_start", toolName: "tmux", args: { action: "kill", window: "@88" } },
      { type: "tool_execution_end", toolName: "tmux", result: { content: [{ type: "text", text: "killed @88" }] } },
      { type: "agent_end" },
    ],
    "completion-stays-in-originating-target": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 6 && echo larkin-tmux-eval-done" } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Still running after 5s in background tmux @12" }] } },
      { type: "agent_end" },
      completionEvent("larkin-tmux-eval-done"),
      { type: "message_update", assistantMessageEvent: { type: "text", content: "larkin-tmux-eval-done finished here" } },
      { type: "agent_end" },
    ],
    "no-forced-subagent-for-known-long": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 8 && echo larkin-tmux-eval-deploy", background: true } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Started in background tmux window @15" }] } },
      { type: "agent_end" },
    ],
  };
  const graded = DATASET.scenarios.map((scenario) => ({
    id: scenario.id,
    ...gradePiTmuxBashTrace(scenario, traces[scenario.id]),
  }));
  for (const result of graded) {
    assert.equal(result.passed, true, `${result.id}: ${JSON.stringify(result.results)}`);
  }
  const summary = summarizePiTmuxBashEval(graded);
  assert.equal(summary.rate >= DATASET.threshold, true);
  assert.equal(summary.passed, DATASET.scenarios.length);
});

test("grader rejects Agent/subagent delegation and missing inspect/stop IDs", () => {
  const long = DATASET.scenarios.find((scenario) => scenario.id === "long-command-backgrounds-without-subagent");
  const forced = gradePiTmuxBashTrace(long, [
    { type: "tool_execution_start", toolName: "Agent", args: { prompt: "run it", run_in_background: true } },
    { type: "agent_end" },
  ]);
  assert.equal(forced.passed, false);
  assert.equal(forced.results.no_forced_subagent, false);

  const inspect = DATASET.scenarios.find((scenario) => scenario.id === "inspect-by-returned-id");
  const noPeek = gradePiTmuxBashTrace(inspect, [
    { type: "tool_execution_start", toolName: "bash", args: { command: inspect.task_bash } },
    { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Started in background tmux window @1" }] } },
    { type: "agent_end" },
  ]);
  assert.equal(noPeek.passed, false);
  assert.equal(noPeek.results.inspects_by_returned_id, false);
});

test("completion extractor only accepts tmux-bash-completion followUp", () => {
  assert.equal(extractTmuxBashCompletion({ customType: "subagent-notification" }), null);
  assert.equal(extractTmuxBashCompletion(completionEvent("done"))?.customType, "tmux-bash-completion");
});

test("headless RPC fixture args and unprompted completion turn are independent of TUI", () => {
  const args = buildPiRpcArgs({
    packagePath: "/tmp/fixture-pkg",
    loadMode: "extension",
    model: "openai-codex/gpt-5.6-luna",
  });
  assert.deepEqual(args.slice(0, 4), HEADLESS_PI_RPC_PREFIX);
  assert.equal(assertHeadlessExtensionFixtureArgs(args, "/tmp/fixture-pkg"), true);
  const timeoutEnd = {
    type: "tool_execution_end",
    toolName: "bash",
    result: { details: { outcome: "timed-out-background" }, content: [{ type: "text", text: "Still running after 5s" }] },
  };
  assert.equal(extractTimedOutBackground(timeoutEnd)?.outcome, "timed-out-background");
  const firstEnd = { type: "agent_end" };
  const secondStart = { type: "turn_start" };
  const secondEnd = completionEvent("larkin-tmux-eval-done");
  const found = findUnpromptedCompletionTurn([timeoutEnd, firstEnd, secondStart, secondEnd], firstEnd);
  assert.equal(found?.completion?.customType, "tmux-bash-completion");
  assert.equal(found.turnStart, secondStart);
  assert.equal(findUnpromptedCompletionTurn([timeoutEnd, firstEnd], firstEnd), null);
});

test("isolated harness uses configurable local package or normal discovery and does not write user Pi settings", () => {
  const snapshot = snapshotUserPiSettings();
  const workspace = createIsolatedTmuxWorkspace("larkin-tmux-unit-");
  try {
    assert.equal(workspace.gitFixture, true);
    assert.equal(fs.existsSync(path.join(workspace.workDir, ".git")), true);
    const extensionArgs = buildPiRpcArgs({
      packagePath: workspace.packageDir,
      loadMode: "extension",
      model: DATASET.model.selection,
    });
    assert.deepEqual(extensionArgs.slice(0, 4), HEADLESS_PI_RPC_PREFIX);
    assert.equal(assertHeadlessExtensionFixtureArgs(extensionArgs, workspace.packageDir), true);
    const discoveryArgs = buildPiRpcArgs({ loadMode: "discovery" });
    assert.equal(discoveryArgs.includes("-e"), false);
    assert.equal(discoveryArgs.includes("--no-extensions"), false);
    assert.equal(resolveTmuxBashLoadMode({ LARKIN_PI_TMUX_BASH_LOAD: "discovery" }), "discovery");
    const defaultPath = resolveTmuxBashPackagePath({});
    if (defaultPath) {
      assert.equal(defaultPath, path.resolve(DEFAULT_ISOLATED_PACKAGE));
      const manifest = readPinnedPluginManifest(defaultPath);
      assert.equal(manifest.name, "@richardgill/pi-tmux-bash");
      assert.equal(manifest.version, "0.0.12");
      assert.equal(packageHasResolvableDependencies(defaultPath), true);
      const unusedDest = path.join(workspace.root, "must-not-copy");
      assert.equal(prepareIsolatedTmuxBashPackage(defaultPath, unusedDest), path.resolve(defaultPath));
      assert.equal(fs.existsSync(unusedDest), false);
    }
    const packagePath = resolveTmuxBashPackagePath({
      LARKIN_PI_TMUX_BASH_PACKAGE: DEFAULT_ISOLATED_PACKAGE,
    });
    if (packagePath) {
      const manifest = readPinnedPluginManifest(packagePath);
      assert.equal(manifest.name, "@richardgill/pi-tmux-bash");
      assert.equal(manifest.version, "0.0.12");
    }
    assertUserPiSettingsUnchanged(snapshot);
  } finally {
    killIsolatedTmuxSession(workspace.sessionName);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("harness distinguishes isolated git fixture from explicit non-git cwd that currently fails", () => {
  const git = createIsolatedTmuxWorkspace({ prefix: "larkin-tmux-git-", git: true });
  const nongit = createIsolatedTmuxWorkspace({ prefix: "larkin-tmux-nongit-", git: false });
  try {
    assert.equal(git.gitFixture, true);
    assert.equal(fs.existsSync(path.join(git.workDir, ".git")), true);
    assert.equal(nongit.gitFixture, false);
    assert.equal(fs.existsSync(path.join(nongit.workDir, ".git")), false);
    assert.match("Error: not in a git repository.", UPSTREAM_NON_GIT_ERROR);
    assert.equal(DEFAULT_ISOLATED_PACKAGE,
      "/tmp/larkin-tmux-package.ypzqKm/node_modules/@richardgill/pi-tmux-bash");
  } finally {
    killIsolatedTmuxSession(git.sessionName);
    killIsolatedTmuxSession(nongit.sessionName);
    fs.rmSync(git.root, { recursive: true, force: true });
    fs.rmSync(nongit.root, { recursive: true, force: true });
  }
});
