import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInboxAuditFixture, advanceFixtureAnchor } from "./inbox-audit-flow-fixture.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/inbox-audit-flow/scenarios.json"), "utf8"));
const GATEWAY = path.join(ROOT, "test/support/inbox-audit-flow-gateway.mjs");

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function scenario() {
  const id = flag("--scenario");
  const found = DATASET.scenarios.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown scenario: ${id || "<missing>"}`);
  return found;
}

function runGateway(action, root, sourceRoot, extra = []) {
  const result = spawnSync(process.execPath, [GATEWAY, action, "--root", root, "--agent-id", "cli_inboxAuditEvalA1", "--source-root", sourceRoot, ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(root, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

const command = process.argv[2] || "";
if (command === "--setup") {
  const item = scenario();
  const sourceRoot = flag("--source-root");
  if (!sourceRoot) throw new Error("--setup requires --source-root");
  const fixture = await createInboxAuditFixture({ root: flag("--root") || undefined, scenario: item, sourceRoot });
  const callerInstruction = item.task
    .replaceAll("{gateway}", GATEWAY)
    .replaceAll("{agent_id}", fixture.agentId)
    .replaceAll("{root}", fixture.root)
    .replaceAll("{source_root}", sourceRoot);
  process.stdout.write(`${JSON.stringify({
    dataset: DATASET.dataset, version: DATASET.version, scenario: item.id,
    root: fixture.root, agent_id: fixture.agentId, gateway: GATEWAY,
    caller_instruction: callerInstruction,
    advance_command: item.fixture.new_anchor
      ? `bun ${path.join(ROOT, "test/support/inbox-audit-flow-driver.mjs")} --advance-anchor --scenario ${item.id} --root ${fixture.root} --agent-id ${fixture.agentId}`
      : null,
    verify_command: `bun ${path.join(ROOT, "test/support/inbox-audit-flow-driver.mjs")} --verify --scenario ${item.id} --root ${fixture.root} --source-root ${sourceRoot}`,
    trace: path.join(fixture.root, "trace.ndjson"),
    grade_command: `bun ${path.join(ROOT, "test/support/inbox-audit-flow-grader.mjs")} --scenario ${item.id} --trace ${path.join(fixture.root, "trace.ndjson")}`,
  }, null, 2)}\n`);
  process.exit(0);
}
if (command === "--advance-anchor") {
  const item = scenario();
  const sourceRoot = flag("--source-root");
  if (!sourceRoot) throw new Error("--advance-anchor requires --source-root");
  await advanceFixtureAnchor(flag("--root"), item, sourceRoot, flag("--agent-id") || undefined);
  process.stdout.write(JSON.stringify({ ok: true, action: "fixture_advance_anchor", anchor: item.fixture.new_anchor }) + "\n");
  process.exit(0);
}
if (command === "--verify") {
  process.exit(runGateway("verify-read", flag("--root"), flag("--source-root")));
}
if (command === "--grade") {
  const { gradeInboxAuditFlowTrace, loadInboxAuditFlowEval } = await import("./inbox-audit-flow-grader.mjs");
  const item = scenario();
  const trace = fs.readFileSync(flag("--trace"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const dataset = loadInboxAuditFlowEval(path.join(ROOT, "evals/inbox-audit-flow/scenarios.json"));
  process.stdout.write(`${JSON.stringify(gradeInboxAuditFlowTrace(dataset, item, trace), null, 2)}\n`);
  process.exit(0);
}
process.stderr.write("usage: --setup|--advance-anchor|--verify|--grade --scenario <id> ...\n");
process.exit(2);
