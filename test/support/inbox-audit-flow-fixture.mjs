import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE_AGENT_ID = "cli_inboxAuditEvalA1";
export const FIXTURE_TIME = "2026-09-06T00:00:00.000Z";

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function appendTrace(root, event) {
  fs.appendFileSync(path.join(root, "trace.ndjson"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function createInboxAuditFixture({ root, scenario }) {
  const fixtureRoot = root || fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-eval-"));
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const agentId = scenario.fixture.agent_id || FIXTURE_AGENT_ID;
  writePrivate(path.join(fixtureRoot, "config.json"), {
    version: 3,
    serverId: "server_inbox_audit_eval",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "gpt-5.6-sol" } },
  });
  writePrivate(path.join(fixtureRoot, "inbox-audit.json"), {
    version: 2,
    targets: [{
      agent_id: agentId,
      target: scenario.fixture.target,
      anchor: scenario.fixture.anchor,
      observed_at: FIXTURE_TIME,
      status: "pending",
    }],
  });
  fs.writeFileSync(path.join(fixtureRoot, "trace.ndjson"), "", { mode: 0o600 });
  writePrivate(path.join(fixtureRoot, "history.json"), {
    target: scenario.fixture.target,
    anchor: scenario.fixture.anchor,
    result: scenario.fixture.history,
  });
  return { root: fixtureRoot, agentId, traceFile: path.join(fixtureRoot, "trace.ndjson") };
}

export function advanceFixtureAnchor(root, scenario, agentId = FIXTURE_AGENT_ID) {
  const file = path.join(root, "inbox-audit.json");
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  const row = registry.targets.find((candidate) => candidate.agent_id === agentId && candidate.target === scenario.fixture.target);
  if (!row) throw new Error("fixture target is missing before anchor advance");
  row.anchor = scenario.fixture.new_anchor;
  row.observed_at = "2026-09-06T00:01:00.000Z";
  row.status = "pending";
  delete row.completed_at;
  delete row.completed_anchor;
  delete row.completed_outcome;
  writePrivate(file, registry);
  writePrivate(path.join(root, "history.json"), {
    target: scenario.fixture.target,
    anchor: scenario.fixture.new_anchor,
    result: scenario.fixture.history,
  });
  appendTrace(root, { action: "fixture_advance_anchor", target: scenario.fixture.target, anchor: scenario.fixture.new_anchor });
}
