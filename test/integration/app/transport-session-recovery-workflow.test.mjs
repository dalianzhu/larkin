import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { fixtureAgentId as agentId, fixtureOtherId } from "../../support/transport-recovery-fixture.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (check()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail("workflow condition timed out");
}
function cli(root, args = [], extraEnv = {}) {
  const env = { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root, ...extraEnv };
  if (!("LARKIN_AGENT_ID" in extraEnv)) delete env.LARKIN_AGENT_ID;
  const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/cli.mjs"), "session", "recover", "--agent", agentId, "--reason", "transport-failure", "--json", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 10_000 });
  assert.ok(result.stdout, result.stderr || String(result.error));
  return { ...JSON.parse(result.stdout), exitCode: result.status };
}
for (const crash of [false, true]) test(`public transport recovery preserves canonical Inbox and never replays completed effects${crash ? " across a process crash" : ""}`, { timeout: 25_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-transport-public-"));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, "clock"), "1000000");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-transport", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "fixture-model" }, [fixtureOtherId]: { runtime: "codex", model: "fixture-model" } } }), { mode: 0o600 });
  let child;
  const supervisors = [];
  async function start() {
    let output = "";
    child = spawn(process.execPath, [path.join(ROOT, "test/support/transport-recovery-control-harness.mjs"), "app/runtime-process.mjs"], { cwd: ROOT,
      env: { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (x) => { output += x; }); child.stderr.on("data", (x) => { output += x; });
    await until(() => { if (child.exitCode !== null) assert.fail(output); return output.includes("ready"); });
    supervisors.push(JSON.parse(fs.readFileSync(path.join(root, "supervisor-status.json"))).pid);
  }
  const inputs = () => fs.readFileSync(path.join(root, "inputs.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
  try {
    await start();
    const store = createAgentStateStore(root, agentId);
    const other = createAgentStateStore(root, fixtureOtherId);
    const otherState = fs.readFileSync(other.paths.agentState, "utf8");
    const before = ["inbox", "inboxState", "runtimeDeliveries"].map((key) => fs.readFileSync(store.paths[key], "utf8"));
    const inspect = cli(root); assert.equal(inspect.ok, true);
    assert.equal(inspect.plan.agentId, agentId); assert.equal(inspect.plan.runtime, "codex");
    assert.ok(inspect.plan.sessionId); assert.ok(inspect.plan.launchId); assert.ok(Number.isSafeInteger(inspect.plan.generation));
    assert.equal(inspect.plan.failures[0].target, "chat:oc_transport");
    assert.equal(inputs().length, 1, "inspect must not call a model");
    assert.equal(cli(root, [], { LARKIN_AGENT_ID: agentId }).code, "user_authority_required");
    let plan = inspect.plan;
    const reviewFile = path.join(root, "review.json");
    function review() {
      fs.writeFileSync(reviewFile, JSON.stringify({ planToken: plan.token, decisions: plan.failures.map((f) => ({ deliveryId: f.deliveryId, target: f.target, owner: agentId,
        disposition: "already-completed", evidence: "Synthetic completed write receipt; read-only verification required." })) }), { mode: 0o600 });
      return ["--plan", plan.token, "--review-file", reviewFile];
    }
    const args = review();
    const result = cli(root, args); assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.sessionId, plan.sessionId); assert.equal(result.previousSessionId, plan.sessionId);
    assert.equal(result.dispatchHeld, true); assert.equal(result.phase, "reconciling");
    assert.deepEqual(["inbox", "inboxState", "runtimeDeliveries"].map((key) => fs.readFileSync(store.paths[key], "utf8")), before);
    assert.equal(cli(root, args).recoveryId, result.recoveryId);
    assert.equal(inputs().length, 2, "duplicate commit cannot repeat reconciliation");
    assert.equal(inputs()[1].kind, "user");
    assert.doesNotMatch(inputs()[1].text, /ORIGINAL_SIDE_EFFECT_MUST_NOT_REPLAY/);
    assert.match(inputs()[1].text, /Never repeat completed reviews, merges/);
    assert.equal(fs.readFileSync(other.paths.agentState, "utf8"), otherState);
    if (crash) {
      child.kill("SIGKILL"); await once(child, "exit");
      await start();
      assert.equal(inputs().length, 2, "restart must never submit an uncertain turn");
      assert.equal(cli(root, args).phase, "failed"); assert.equal(inputs().length, 2);
      assert.equal(store.readJson("transportRecovery", null).code, "reconciliation_interrupted");
      plan = cli(root).plan;
      assert.equal(cli(root, review()).code, "recovery_cooldown");
      fs.writeFileSync(path.join(root, "clock"), "1060001");
      plan = cli(root).plan;
      assert.equal(cli(root, review()).ok, true);
      assert.equal(inputs().length, 3);
    }
    fs.writeFileSync(path.join(root, "finish"), "now");
    await until(() => fs.existsSync(path.join(root, "finished")));
    await until(() => store.readJson("transportRecovery", null)?.phase === "complete");
    assert.equal(store.readJson("runtimeDeliveries", {}).records[0].status, "consumed");
    const status = store.readJson("status", {});
    assert.equal(status.runtimeReadiness.state, "ready"); assert.equal(status.inboundDeliveryHealth.state, "healthy");
    assert.equal(status.inboundDeliveryHealth.reason, undefined);
    assert.equal(status.inboundDeliveryHealth.nextAction, undefined);
    assert.equal(inputs().filter((x) => x.kind === "wake").length, 1, "the failed side-effect task must never be replayed");
  } finally {
    if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    for (const pid of supervisors) { try { process.kill(pid, "SIGTERM"); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
