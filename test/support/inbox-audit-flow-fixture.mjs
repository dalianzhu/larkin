import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURE_AGENT_ID = "cli_inboxAuditEvalA1";
export const FIXTURE_TIME = "2026-09-06T00:00:00.000Z";

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function appendTrace(root, event) {
  fs.appendFileSync(path.join(root, "trace.ndjson"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function eventForTarget(target, anchor) {
  if (target.startsWith("chat:")) return { chat_id: target.slice("chat:".length), thread_id: null, message_id: anchor };
  const parts = target.split(":");
  return { chat_id: parts[1], thread_id: parts[2], message_id: anchor };
}

async function observeFixtureTarget(sourceRoot, root, registryFile, agentId, target, anchor, now) {
  if (!sourceRoot) throw new Error("fixture setup requires --source-root");
  const [stateModule, auditModule] = await Promise.all([
    import(pathToFileURL(path.join(sourceRoot, "dist", "agent", "agent-state-store.mjs")).href),
    import(pathToFileURL(path.join(sourceRoot, "dist", "agent", "missed-outbound-scan.mjs")).href),
  ]);
  const event = eventForTarget(target, anchor);
  const store = stateModule.createAgentStateStore(root, agentId);
  const appended = store.appendCanonicalInboxOnce({
    message_id: anchor,
    chat_id: event.chat_id,
    ...(event.thread_id ? { thread_id: event.thread_id } : {}),
    content: "synthetic audit source",
    wake: true,
  });
  if (appended.status !== "appended" || !Number.isSafeInteger(appended.envelope?.target_seq)) {
    throw new Error("fixture canonical Inbox append did not produce target_seq");
  }
  return auditModule.observeInboxAuditTarget(registryFile, agentId, {
    ...event, chat_type: "group", wake: true, _sender_is_bot: false, _scan_authority: true,
    source_seq: appended.envelope.target_seq,
  }, now);
}

export async function createInboxAuditFixture({ root, scenario, sourceRoot }) {
  const fixtureRoot = root || fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-eval-"));
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const agentId = scenario.fixture.agent_id || FIXTURE_AGENT_ID;
  writePrivate(path.join(fixtureRoot, "config.json"), {
    version: 3,
    serverId: "server_inbox_audit_eval",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "gpt-5.6-sol" } },
  });
  await observeFixtureTarget(sourceRoot, fixtureRoot, path.join(fixtureRoot, "inbox-audit.json"), agentId,
    scenario.fixture.target, scenario.fixture.anchor, new Date(FIXTURE_TIME));
  fs.writeFileSync(path.join(fixtureRoot, "trace.ndjson"), "", { mode: 0o600 });
  writePrivate(path.join(fixtureRoot, "history.json"), {
    target: scenario.fixture.target,
    anchor: scenario.fixture.anchor,
    result: scenario.fixture.history,
  });
  return { root: fixtureRoot, agentId, traceFile: path.join(fixtureRoot, "trace.ndjson") };
}

export async function advanceFixtureAnchor(root, scenario, sourceRoot, agentId = FIXTURE_AGENT_ID) {
  const file = path.join(root, "inbox-audit.json");
  const observed = await observeFixtureTarget(sourceRoot, root, file, agentId, scenario.fixture.target,
    scenario.fixture.new_anchor, new Date("2026-09-06T00:01:00.000Z"));
  if (observed !== true) throw new Error("fixture anchor advance did not create new evidence");
  writePrivate(path.join(root, "history.json"), {
    target: scenario.fixture.target,
    anchor: scenario.fixture.new_anchor,
    result: scenario.fixture.history,
  });
  appendTrace(root, { action: "fixture_advance_anchor", target: scenario.fixture.target, anchor: scenario.fixture.new_anchor });
}
