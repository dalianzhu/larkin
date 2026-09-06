import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { gradeInboxAuditFlowTrace, loadInboxAuditFlowEval } from "../support/inbox-audit-flow-grader.mjs";
import { parsePublicCliJson } from "../support/inbox-audit-flow-json.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATASET = loadInboxAuditFlowEval(path.join(ROOT, "evals/inbox-audit-flow/scenarios.json"));

function read(scenario, receipt = "receipt-old") {
  return { action: "audit_read", surface: "public-cli", argv: ["inbox", "audit", "--json"], exit_code: 0,
    result: { version: 4, targets: [{ target: scenario.fixture.target, anchor: scenario.fixture.anchor, observed_at: "2026-09-06T00:00:00.000Z", revision: "sha256:read", receipt }] } };
}

test("inbox audit flow dataset is versioned with four fixed synthetic scenarios", () => {
  assert.equal(DATASET.dataset, "inbox-audit-flow");
  assert.equal(DATASET.version, 1);
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), ["no-finding", "handled-finding", "failure-after-read", "stale-receipt"]);
  assert.equal(DATASET.grader.threshold, 1);
});

test("gateway parses complete pretty JSON stdout and records malformed output explicitly", () => {
  assert.deepEqual(parsePublicCliJson("{\n  \"version\": 4,\n  \"receipt\": \"synthetic\"\n}\n"), {
    ok: true, value: { version: 4, receipt: "synthetic" },
  });
  assert.deepEqual(parsePublicCliJson("{not-json}"), { ok: false, error: "invalid_json" });
  assert.deepEqual(parsePublicCliJson("\n  \n"), { ok: false, error: "empty_stdout" });
});

test("grader accepts no-finding and handled synthetic CLI traces", () => {
  const noFinding = DATASET.scenarios.find((scenario) => scenario.id === "no-finding");
  const noFindingRead = read(noFinding);
  assert.deepEqual(gradeInboxAuditFlowTrace(DATASET, noFinding, [
    noFindingRead,
    { action: "fake_history", surface: "synthetic-cli-stub", target: noFinding.fixture.target, anchor: noFinding.fixture.anchor },
    { action: "audit_complete", surface: "public-cli", argv: ["inbox", "audit", "complete", "--receipt", "receipt-old", "--outcome", "no-finding", "--json"], exit_code: 0,
      requested_receipt: "receipt-old", requested_outcome: "no-finding", result: { completed: true, reason: "completed" } },
  ]), { passed: true, failures: [] });

  const handled = DATASET.scenarios.find((scenario) => scenario.id === "handled-finding");
  const handledRead = read(handled);
  assert.deepEqual(gradeInboxAuditFlowTrace(DATASET, handled, [
    handledRead,
    { action: "fake_history", surface: "synthetic-cli-stub", target: handled.fixture.target, anchor: handled.fixture.anchor },
    { action: "fake_send", surface: "synthetic-cli-stub", target: handled.fixture.target, anchor: handled.fixture.anchor, body: "synthetic reply" },
    { action: "audit_complete", surface: "public-cli", argv: ["inbox", "audit", "complete", "--receipt", "receipt-old", "--outcome", "handled", "--json"], exit_code: 0,
      requested_receipt: "receipt-old", requested_outcome: "handled", result: { completed: true, reason: "completed" } },
  ]), { passed: true, failures: [] });
});

test("grader accepts pending-after-failure and stale-receipt traces", () => {
  const failed = DATASET.scenarios.find((scenario) => scenario.id === "failure-after-read");
  assert.equal(gradeInboxAuditFlowTrace(DATASET, failed, [
    read(failed),
    { action: "verification_audit_read", surface: "public-cli", argv: ["inbox", "audit", "--json"], exit_code: 0,
      result: { version: 4, targets: [{ target: failed.fixture.target, anchor: failed.fixture.anchor, receipt: "receipt-new" }] } },
  ]).passed, true);

  const stale = DATASET.scenarios.find((scenario) => scenario.id === "stale-receipt");
  assert.equal(gradeInboxAuditFlowTrace(DATASET, stale, [
    read(stale),
    { action: "fixture_advance_anchor", target: stale.fixture.target, anchor: stale.fixture.new_anchor },
    { action: "audit_complete", surface: "public-cli", argv: ["inbox", "audit", "complete", "--receipt", "receipt-old", "--outcome", "handled", "--json"], exit_code: 0,
      requested_receipt: "receipt-old", result: { completed: false, reason: "stale" } },
    { action: "verification_audit_read", surface: "public-cli", argv: ["inbox", "audit", "--json"], exit_code: 0,
      result: { version: 4, targets: [{ target: stale.fixture.target, anchor: stale.fixture.new_anchor, receipt: "receipt-new" }] } },
  ]).passed, true);
});

test("grader rejects empty runs, direct or failed completion, and wrong target replies", () => {
  const noFinding = DATASET.scenarios.find((scenario) => scenario.id === "no-finding");
  assert.equal(gradeInboxAuditFlowTrace(DATASET, noFinding, []).passed, false);
  const first = read(noFinding);
  const directCompletion = gradeInboxAuditFlowTrace(DATASET, noFinding, [
    first,
    { action: "audit_complete", surface: "synthetic-cli-stub", argv: ["complete"], exit_code: 0, result: { completed: true, reason: "completed" }, requested_receipt: "receipt-old", requested_outcome: "no-finding" },
  ]);
  assert.equal(directCompletion.passed, false);

  const handled = DATASET.scenarios.find((scenario) => scenario.id === "handled-finding");
  const wrongTarget = gradeInboxAuditFlowTrace(DATASET, handled, [
    read(handled),
    { action: "fake_history", surface: "synthetic-cli-stub", target: handled.fixture.target, anchor: handled.fixture.anchor },
    { action: "fake_send", surface: "synthetic-cli-stub", target: "chat:oc_wrong", anchor: handled.fixture.anchor, body: "synthetic reply" },
    { action: "audit_complete", surface: "public-cli", argv: ["inbox", "audit", "complete", "--receipt", "receipt-old", "--outcome", "handled", "--json"], exit_code: 0,
      requested_receipt: "receipt-old", requested_outcome: "handled", result: { completed: true, reason: "completed" } },
  ]);
  assert.equal(wrongTarget.passed, false);
});
