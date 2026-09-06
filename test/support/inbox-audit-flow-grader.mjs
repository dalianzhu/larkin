import fs from "node:fs";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadInboxAuditFlowEval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "inbox-audit-flow" || value.version !== 1) throw new Error("inbox audit eval dataset/version mismatch");
  if (value.grader?.name !== "inbox-audit-flow-trace-grader" || value.grader.version !== 1 || value.grader.threshold !== 1) {
    throw new Error("inbox audit eval grader metadata mismatch");
  }
  if (!Array.isArray(value.grader.rubric) || value.grader.rubric.length < 5) throw new Error("inbox audit eval rubric is incomplete");
  if (!Array.isArray(value.scenarios) || value.scenarios.length !== 4) throw new Error("inbox audit eval requires four scenarios");
  const ids = new Set();
  for (const scenario of value.scenarios) {
    if (typeof scenario.id !== "string" || !scenario.id || ids.has(scenario.id)) throw new Error("scenario id is missing or duplicated");
    ids.add(scenario.id);
    if (typeof scenario.task !== "string" || !scenario.task.includes("{gateway}")) throw new Error(`${scenario.id} task must bind gateway`);
    if (!object(scenario.fixture) || typeof scenario.fixture.target !== "string" || typeof scenario.fixture.anchor !== "string") {
      throw new Error(`${scenario.id} fixture target/anchor is required`);
    }
    if (!Array.isArray(scenario.required_actions) || scenario.required_actions.length === 0) throw new Error(`${scenario.id} required actions are missing`);
  }
  return value;
}

function latestResult(trace, action) {
  return trace.filter((event) => event.action === action).at(-1);
}

function readTarget(event) {
  return event?.result?.targets?.[0] || null;
}

export function gradeInboxAuditFlowTrace(dataset, scenario, trace) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  if (!Array.isArray(trace) || trace.length === 0) {
    return { passed: false, failures: [{ rule: "nonempty_trace", detail: "empty trace cannot earn credit" }] };
  }
  const known = new Set(["audit_read", "audit_complete", "fake_history", "fake_send", "fixture_advance_anchor", "verification_audit_read"]);
  for (const [index, event] of trace.entries()) {
    if (!object(event) || !known.has(event.action)) fail("known_action", `trace event ${index}`);
    if (["audit_read", "audit_complete", "verification_audit_read"].includes(event.action)) {
      if (event.surface !== "public-cli" || event.exit_code !== 0) fail("public_cli_boundary", `event ${index}`);
      if (!Array.isArray(event.argv) || event.argv[0] !== "inbox" || event.argv[1] !== "audit") fail("public_cli_argv", `event ${index}`);
      if (event.action === "audit_read" && event.argv.at(-1) !== "--json") fail("public_cli_read", `event ${index}`);
      if (event.action === "audit_complete" && (!event.argv.includes("complete") || event.argv.at(-1) !== "--json")) fail("public_cli_complete", `event ${index}`);
    }
    if (["fake_history", "fake_send"].includes(event.action) && event.surface !== "synthetic-cli-stub") fail("synthetic_boundary", `event ${index}`);
  }
  const reads = trace.filter((event) => event.action === "audit_read");
  const firstRead = reads[0];
  const initial = readTarget(firstRead);
  if (!firstRead || firstRead.result?.version !== 4 || !initial || initial.target !== scenario.fixture.target || initial.anchor !== scenario.fixture.anchor
      || typeof initial.receipt !== "string" || typeof initial.revision !== "string") {
    fail("audit_read_receipt", "first public audit read did not return the declared target, anchor, revision, and receipt");
  }
  const required = new Set(scenario.required_actions);
  for (const action of required) if (!trace.some((event) => event.action === action)) fail("required_actions", action);
  if (scenario.id === "no-finding") {
    const history = latestResult(trace, "fake_history");
    const complete = latestResult(trace, "audit_complete");
    if (!history || history.target !== initial?.target || history.anchor !== initial?.anchor) fail("history_target", "history must use the returned target and anchor");
    if (!complete || complete.requested_outcome !== "no-finding" || complete.requested_receipt !== initial?.receipt
        || complete.result?.completed !== true || complete.result?.reason !== "completed") {
      fail("no_finding_completion", "no-finding must explicitly complete the returned receipt");
    }
    if (trace.some((event) => event.action === "fake_send")) fail("no_finding_send", "no-finding must not send");
  } else if (scenario.id === "handled-finding") {
    const history = latestResult(trace, "fake_history");
    const send = latestResult(trace, "fake_send");
    const complete = latestResult(trace, "audit_complete");
    if (!history || history.target !== initial?.target || history.anchor !== initial?.anchor) fail("history_target", "history must use the returned target and anchor");
    if (!send || send.target !== initial?.target || send.anchor !== initial?.anchor) fail("reply_anchor", "reply must use the returned target and anchor");
    if (!complete || complete.requested_outcome !== "handled" || complete.requested_receipt !== initial?.receipt
        || complete.result?.completed !== true || complete.result?.reason !== "completed") {
      fail("handled_completion", "handled finding must complete the returned receipt after the reply");
    }
    if (trace.findIndex((event) => event.action === "fake_send") > trace.findIndex((event) => event.action === "audit_complete")) {
      fail("reply_before_completion", "reply must precede completion");
    }
  } else if (scenario.id === "failure-after-read") {
    const verification = latestResult(trace, "verification_audit_read");
    const target = readTarget(verification);
    if (!verification || !target || target.target !== initial?.target || target.anchor !== initial?.anchor) fail("pending_after_failure", "later read must still show the same pending target");
    if (trace.some((event) => event.action === "audit_complete" || event.action === "fake_send")) fail("failure_side_effect", "caller failure must leave completion and send absent");
  } else if (scenario.id === "stale-receipt") {
    const advance = latestResult(trace, "fixture_advance_anchor");
    const complete = latestResult(trace, "audit_complete");
    const verification = latestResult(trace, "verification_audit_read");
    const target = readTarget(verification);
    if (!advance || advance.anchor !== scenario.fixture.new_anchor) fail("new_revision", "fixture did not record the newer anchor");
    if (!complete || complete.requested_receipt !== initial?.receipt || complete.result?.completed !== false || complete.result?.reason !== "stale") {
      fail("stale_completion", "old receipt must be rejected as stale");
    }
    if (!target || target.target !== scenario.fixture.target || target.anchor !== scenario.fixture.new_anchor) fail("new_target_pending", "new anchor must remain visible after stale completion");
  }
  return { passed: failures.length === 0, failures };
}

if (process.argv[1] && process.argv[1].endsWith("inbox-audit-flow-grader.mjs")) {
  const scenarioId = process.argv[process.argv.indexOf("--scenario") + 1];
  const traceFile = process.argv[process.argv.indexOf("--trace") + 1];
  const datasetFile = new URL("../../evals/inbox-audit-flow/scenarios.json", import.meta.url);
  const dataset = loadInboxAuditFlowEval(datasetFile);
  const scenario = dataset.scenarios.find((item) => item.id === scenarioId);
  if (!scenario || !traceFile) throw new Error("grader requires --scenario and --trace");
  const trace = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const grade = gradeInboxAuditFlowTrace(dataset, scenario, trace);
  process.stdout.write(`${JSON.stringify(grade, null, 2)}\n`);
  process.exit(grade.passed ? 0 : 1);
}
