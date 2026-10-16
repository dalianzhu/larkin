import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createTransportFixture, fixtureAgentId, fixtureOtherId } from "../../support/transport-recovery-fixture.mjs";

async function withFixture(run, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-transport-operator-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-transport-fixture", activeAgent: fixtureAgentId,
    agents: { [fixtureAgentId]: { runtime: "codex", model: "fixture-model" }, [fixtureOtherId]: { runtime: "codex", model: "fixture-model" } } }), { mode: 0o600 });
  let fixture;
  try { fixture = await createTransportFixture(root, options); await run(fixture); }
  finally { await fixture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const bytes = (store) => ["inbox", "inboxState", "runtimeDeliveries"].map((key) => fs.readFileSync(store.paths[key], "utf8"));

test("operator transport recovery switches only one session, preserves canonical bytes, and reconciles without task replay", async () => {
  await withFixture(async (f) => {
    await f.fail();
    f.store.appendCanonicalInboxOnce({ message_id: "om_passive_transport", target: "chat:oc_passive", content: "passive fixture", wake: false });
    const old = f.current(); const other = f.sessions.find((s) => s.agentId === fixtureOtherId);
    const before = bytes(f.store); const inspected = await f.inspect();
    assert.deepEqual(bytes(f.store), before, "inspection is read-only");
    assert.equal(inspected.plan.failures[0].target, "chat:oc_transport");
    assert.equal(inspected.plan.sessionId, old.sessionId); assert.ok(inspected.plan.launchId);
    const review = f.review(inspected.plan);
    const result = await f.commit(inspected.plan, review);
    assert.equal(result.phase, "reconciling"); assert.equal(result.dispatchHeld, true);
    assert.notEqual(f.current().sessionId, old.sessionId);
    assert.equal(f.current().config.resumeSessionId, null);
    assert.equal(f.current().inputs.length, 1);
    assert.equal(f.current().inputs[0].kind, "user");
    assert.doesNotMatch(f.current().inputs[0].text, /ORIGINAL_SIDE_EFFECT_MUST_NOT_REPLAY/);
    assert.match(f.current().inputs[0].text, /already-completed|Never repeat completed/);
    assert.deepEqual(bytes(f.store), before, "a fresh-session switch does not consume or rearm Inbox/ledger");
    assert.equal(f.store.readJson("agentState", {}).previousSessions.codex.sessionId, old.sessionId);
    assert.equal(other.closes.length, 0, "another Agent is not switched");
    await f.commit(inspected.plan, review);
    assert.equal(f.current().inputs.length, 1, "duplicate control request does not repeat a paid reconciliation");
    await f.finish();
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "complete");
    const status = f.store.readJson("status", {});
    assert.equal(status.runtimeReadiness.state, "ready"); assert.equal(status.inboundDeliveryHealth.state, "healthy");
    assert.equal(status.inboundDeliveryHealth.reason, undefined); assert.equal(status.inboundDeliveryHealth.nextAction, undefined);
    assert.equal(status.inboundDeliveryHealth.lastFailure.state, "error");
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_passive_transport"]);
  });
});

for (const invalid of ["token", "target", "owner", "evidence"]) test(`operator recovery refuses stale/unreviewed ${invalid}`, async () => {
  await withFixture(async (f) => {
    await f.fail(); const { plan } = await f.inspect(); const review = f.review(plan); const before = bytes(f.store);
    if (invalid === "token") f.store.appendCanonicalInboxOnce({ message_id: "om_late_transport", target: "chat:oc_late", content: "new fixture" });
    else if (invalid === "target") review.decisions[0].target = "chat:oc_wrong";
    else if (invalid === "owner") review.decisions[0].owner = fixtureOtherId;
    else review.decisions[0].evidence = "";
    await assert.rejects(f.commit(plan, review), (error) => ["recovery_plan_stale", "recovery_review_invalid"].includes(error.code));
    assert.equal(f.sessions.filter((s) => s.agentId === fixtureAgentId).length, 1);
    if (invalid !== "token") assert.deepEqual(bytes(f.store), before);
  });
});

for (const [category, reason] of [["auth", "authentication failed"], ["quota", "quota exceeded"], ["context_window", "context window exceeded"], ["provider", "Runtime configuration invalid"], ["provider", "stream connection failed: authentication failed"], ["provider", "stream connection failed: quota exceeded"]]) {
  test(`transport recovery does not bypass ${category} prerequisite/failure`, async () => {
    await withFixture(async (f) => {
      await f.fail({ category, reason });
      await assert.rejects(f.inspect(), (error) => ["recovery_non_transport_failure", "recovery_prerequisite_failed"].includes(error.code));
      assert.equal(f.sessions.filter((s) => s.agentId === fixtureAgentId).length, 1);
    });
  });
}

test("operator attempts have a persistent cooldown and bounded budget; restart never repeats an uncertain turn", async () => {
  let now = Date.now();
  await withFixture(async (f) => {
    await f.fail(); let { plan } = await f.inspect(); await f.commit(plan, f.review(plan));
    const freshId = f.current().sessionId;
    await f.finish({ outcome: "error", poll: false });
    ({ plan } = await f.inspect());
    await assert.rejects(f.commit(plan, f.review(plan)), (error) => error.code === "recovery_cooldown");
    await f.restart(); assert.equal(f.current().sessionId, freshId); assert.equal(f.current().inputs.length, 0);
    for (let i = 0; i < 2; i++) {
      now += 60_001; ({ plan } = await f.inspect()); await f.commit(plan, f.review(plan)); await f.finish({ outcome: "error", poll: false });
    }
    now += 60_001; ({ plan } = await f.inspect()); assert.equal(plan.attemptsRemaining, 0);
    await assert.rejects(f.commit(plan, f.review(plan)), (error) => error.code === "recovery_retry_budget_exhausted");
    await f.host().recoverTransportSession(fixtureAgentId, { abort: true, planToken: f.store.readJson("transportRecovery", {}).lastPlan });
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "cancelled");
    assert.equal(f.store.readJson("runtimeDeliveries", {}).records[0].status, "error");
  }, { now: () => now });
});

test("recovery holds new ingress durably and ignores old-epoch success", async () => {
  await withFixture(async (f) => {
    await f.fail(); const old = f.current(); const { plan } = await f.inspect(); await f.commit(plan, f.review(plan));
    const count = f.current().inputs.length;
    await f.host().ingest(fixtureAgentId, { message_id: "om_transport_new", event_id: "evt_transport_new", chat_id: "oc_new", chat_type: "group",
      sender_id: "ou_fixture", content: "new work remains pending", _mentioned_bot: true, _sender_is_bot: true });
    assert.equal(f.current().inputs.length, count);
    old.emit({ type: "turn-start" }); old.emit({ type: "activity", activity: "text" }); old.emit({ type: "turn-end", outcome: "success" });
    assert.notEqual(f.store.readJson("transportRecovery", {}).phase, "complete");
    assert.ok(f.store.readNdjson("inbox").some((row) => row.message_id === "om_transport_new"));
  });
});

test("a crash after durable switch intent rolls forward the same fresh session without changing Inbox bytes", async () => {
  let failWrite = false;
  await withFixture(async (f) => {
    await f.fail(); const { plan } = await f.inspect(); const review = f.review(plan); const before = bytes(f.store);
    failWrite = true;
    await assert.rejects(f.commit(plan, review), (error) => error.code === "recovery_commit_pending");
    const intent = f.store.readJson("transportRecovery", {});
    assert.equal(intent.phase, "switching"); assert.ok(intent.sessionId);
    assert.deepEqual(bytes(f.store), before);
    await f.restart();
    assert.equal(f.current().sessionId, intent.sessionId);
    assert.equal(f.current().inputs.length, 0, "restart never sends a recovery prompt on its own");
    assert.equal(f.store.readJson("agentState", {}).sessions.codex, intent.sessionId);
    assert.equal(f.store.readJson("agentState", {}).previousSessions.codex.sessionId, plan.sessionId);
    assert.deepEqual(bytes(f.store), before);
    await f.commit(plan, review); // definitely not submitted before the crash: safe idempotent continuation
    assert.equal(f.current().inputs.length, 1);
    await f.finish();
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "complete");
  }, { storeDecorator(store) {
    if (store.__transportWriteWrapped) return store;
    store.__transportWriteWrapped = true;
    const original = store.writeJson.bind(store);
    store.writeJson = (key, value) => {
      if (failWrite && key === "agentState" && store.readJson("transportRecovery", {}).phase === "switching") {
        failWrite = false; throw new Error("synthetic projection crash");
      }
      return original(key, value);
    };
    return store;
  } });
});

test("uncertain submission after a crash is held and requires a new reviewed plan", async () => {
  let now = Date.now();
  await withFixture(async (f) => {
    await f.fail(); const { plan } = await f.inspect(); const review = f.review(plan);
    await f.commit(plan, review);
    const j = f.store.readJson("transportRecovery", {});
    f.store.writeJson("transportRecovery", { ...j, phase: "submitting" });
    await f.restart();
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "failed");
    assert.equal(f.store.readJson("transportRecovery", {}).code, "reconciliation_interrupted");
    await f.commit(plan, review);
    assert.equal(f.current().inputs.length, 0, "uncertain prior acceptance must not be retried by an idempotent duplicate");
    now += 60_001;
    const inspected = await f.inspect();
    assert.notEqual(inspected.plan.token, plan.token);
    await f.commit(inspected.plan, f.review(inspected.plan));
    assert.equal(f.current().inputs.length, 1);
    await f.finish();
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "complete");
  }, { now: () => now });
});

for (const fault of ["staging-failure", "new-arrival"]) test(`recovery stages fail closed for ${fault} without changing the old session or ledger`, async () => {
  let active;
  await withFixture(async (f) => {
    await f.fail(); const old = f.current(); const { plan } = await f.inspect(); const before = bytes(f.store);
    active = f;
    await assert.rejects(f.commit(plan, f.review(plan)), (error) => error.code === "recovery_staging_failed");
    assert.equal(f.store.readJson("agentState", {}).sessions.codex, old.sessionId);
    assert.equal(old.closes.length, 0);
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "failed");
    if (fault === "staging-failure") assert.deepEqual(bytes(f.store), before);
    else {
      assert.equal(bytes(f.store)[2], before[2]);
      assert.ok(f.store.readNdjson("inbox").some((row) => row.message_id === "om_stage_arrival"));
      assert.equal(f.current().inputs.length, 0, "staged child must not receive task input");
    }
  }, { onCreate() {
    if (!active) return;
    if (fault === "staging-failure") throw new Error("synthetic staging refusal");
    active.store.appendCanonicalInboxOnce({ message_id: "om_stage_arrival", target: "chat:oc_new", content: "durable later arrival" });
  } });
});

test("a malformed recovery journal disables only its Agent after restart", async () => {
  await withFixture(async (f) => {
    await f.fail(); f.store.writeJson("transportRecovery", { version: 1, phase: "awaiting" });
    await f.restart();
    const status = f.store.readJson("status", {});
    assert.notEqual(status.runtimeReadiness.state, "ready");
    assert.equal(f.sessions.filter((s) => s.agentId === fixtureAgentId).length, 1);
    assert.equal(f.sessions.filter((s) => s.agentId === fixtureOtherId).length, 2);
    await assert.rejects(f.inspect(), (error) => error.code === "recovery_journal_invalid");
  });
});

test("polling without a successful reconciliation turn cannot release the recovery hold", async () => {
  await withFixture(async (f) => {
    await f.fail(); const { plan } = await f.inspect(); await f.commit(plan, f.review(plan));
    await f.finish({ outcome: "aborted" });
    assert.equal(f.store.readJson("runtimeDeliveries", {}).records[0].status, "consumed");
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "failed");
    assert.notEqual(f.store.readJson("status", {}).runtimeReadiness.state, "ready");
  });
});

test("retry after consumption never polls later messages using a historical row limit", async () => {
  let now = Date.now();
  await withFixture(async (f) => {
    await f.fail(); let { plan } = await f.inspect(); await f.commit(plan, f.review(plan));
    await f.finish({ outcome: "error" });
    f.store.appendCanonicalInboxOnce({ message_id: "om_same_target_later", target: "chat:oc_transport", content: "later unreviewed work" });
    now += 60_001; ({ plan } = await f.inspect());
    assert.equal(plan.failures[0].pendingRows, 0);
    await f.commit(plan, f.review(plan));
    assert.match(f.current().inputs.at(-1).text, /Reviewed target row limits: \[\]/);
    await f.finish({ poll: false });
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "complete");
    assert.ok(f.store.readNdjson("inbox").some((row) => row.message_id === "om_same_target_later"));
  }, { now: () => now });
});

test("canonical poll atomically refuses later or unrelated rows during reconciliation", async () => {
  await withFixture(async (f) => {
    await f.fail(); const { plan } = await f.inspect(); await f.commit(plan, f.review(plan));
    f.store.appendCanonicalInboxOnce({ message_id: "om_unreviewed_later", target: "chat:oc_transport", content: "new work" });
    f.store.appendCanonicalInboxOnce({ message_id: "om_unreviewed_other", target: "chat:oc_other", content: "other work" });
    const before = bytes(f.store);
    assert.throws(() => f.store.pollInbox({ target: "chat:oc_transport", limit: 2 }), /recovery_poll_outside_snapshot/);
    assert.throws(() => f.store.pollInbox({ target: "chat:oc_other", limit: 1 }), /recovery_poll_outside_snapshot/);
    assert.throws(() => f.store.pollInbox({ limit: 1 }), /recovery_poll_refused/);
    assert.deepEqual(bytes(f.store), before);
    f.store.pollInbox({ target: "chat:oc_transport", limit: 1 });
    const after = bytes(f.store);
    assert.throws(() => f.store.pollInbox({ target: "chat:oc_transport", limit: 1 }), /recovery_poll_outside_snapshot/);
    assert.deepEqual(bytes(f.store), after);
    await f.finish({ poll: false });
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "complete");
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_unreviewed_later", "om_unreviewed_other"]);
  });
});

test("a new explicit attempt requires its own success even if a prior turn left delayed-consumption proof", async () => {
  let now = Date.now(); let duringRetry;
  await withFixture(async (f) => {
    await f.fail(); let { plan } = await f.inspect(); await f.commit(plan, f.review(plan));
    await f.finish({ poll: false });
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "reconciling");
    now += 60_001; ({ plan } = await f.inspect());
    duringRetry = () => f.store.pollInbox({ target: "chat:oc_transport", limit: 1 });
    await f.commit(plan, f.review(plan));
    assert.equal(f.store.readJson("runtimeDeliveries", {}).records[0].status, "consumed");
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "reconciling", "previous attempt success cannot authenticate a new attempt");
    duringRetry = null;
    await f.finish({ poll: false });
    assert.equal(f.store.readJson("transportRecovery", {}).phase, "complete");
  }, { now: () => now, onPrompt() { duringRetry?.(); } });
});

test("startup moves legacy healthy error fields into historical diagnostics", async () => {
  await withFixture(async (f) => {
    f.store.writeJson("status", { ...f.store.readJson("status", {}), inboundDeliveryHealth: { state: "healthy", at: "2026-01-01T00:00:00Z",
      recoveredAt: "2026-01-01T00:01:00Z", code: "runtime_delivery_event", reason: "historical failure", nextAction: "historical action", messageIds: ["om_old_consumed"] } });
    await f.restart();
    const health = f.store.readJson("status", {}).inboundDeliveryHealth;
    assert.equal(health.state, "healthy"); assert.equal(health.reason, undefined); assert.equal(health.nextAction, undefined);
    assert.equal(health.at, "2026-01-01T00:01:00Z");
    assert.equal(health.lastFailure.reason, "historical failure"); assert.equal(health.lastFailure.state, "error");
  });
});
