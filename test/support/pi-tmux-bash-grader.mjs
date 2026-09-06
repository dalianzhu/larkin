import fs from "node:fs";

const BOOLEAN_KEYS = [
  "uses_bash",
  "no_forced_subagent",
  "wait_timeout_not_failure",
  "returned_id",
  "inspects_by_returned_id",
  "stops_by_returned_id",
  "completion_followup",
  "stays_in_originating_target",
  "final_summary",
  "no_hard_kill_or_lifetime_cap",
  "turn_completed",
];

const FORCED_SUBAGENT_TOOLS = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "supervised_start",
  "supervised_wait",
  "supervised_kill",
]);

const WINDOW_ID_RE = /@\d+/g;
const STILL_RUNNING_RE = /still running|started in background|background tmux|timeoutAction["']?\s*[:=]\s*["']?background/i;
const HARD_KILL_RE = /hard-capped at 60|never pass a bash timeout above 60|total lifetime is 600s|supervised_start|run_in_background:\s*true/i;
const NEW_TARGET_RE = /new conversation|start a new (?:chat|dm|conversation)|direct message for (?:status|subagent)/i;
const IS_TEXT_DELTA = (event) => event?.type === "message_update"
  && /^text/.test(String(event.assistantMessageEvent?.type || ""));

function collectCustomMessages(node, customType, found = []) {
  if (node == null) return found;
  if (Array.isArray(node)) {
    for (const item of node) collectCustomMessages(item, customType, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (node.customType === customType) found.push(node);
  for (const value of Object.values(node)) collectCustomMessages(value, customType, found);
  return found;
}

export function extractTmuxBashCompletion(traceOrMessages) {
  const matches = collectCustomMessages(traceOrMessages, "tmux-bash-completion");
  return matches.length > 0 ? matches[0] : null;
}

export function extractTimedOutBackground(eventOrTrace) {
  const nodes = Array.isArray(eventOrTrace) ? eventOrTrace : [eventOrTrace];
  for (const node of nodes) {
    if (!node) continue;
    const details = node.result?.details || node.details;
    if (details?.outcome === "timed-out-background") return details;
    const encoded = typeof node === "string" ? node : JSON.stringify(node);
    if (encoded.includes("timed-out-background")) return { outcome: "timed-out-background" };
  }
  return null;
}

export function findUnpromptedCompletionTurn(trace, firstAgentEnd) {
  const events = Array.isArray(trace) ? trace : [];
  const start = firstAgentEnd ? events.indexOf(firstAgentEnd) : events.findIndex((event) => event?.type === "agent_end");
  if (start < 0) return null;
  const after = events.slice(start + 1);
  const completionEvent = after.find((event) => extractTmuxBashCompletion(event));
  if (!completionEvent) return null;
  return {
    turnStart: after.find((event) => event?.type === "turn_start"),
    agentEnd: after.find((event) => event?.type === "agent_end"),
    completion: extractTmuxBashCompletion(completionEvent),
    completionEvent,
  };
}

export function loadPiTmuxBashEval(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.dataset !== "pi-tmux-bash") throw new Error("pi-tmux-bash eval dataset id mismatch");
  if (raw.version !== 1) throw new Error("pi-tmux-bash eval version must be 1");
  if (raw.standing_prompt_version !== "larkin-standing-v30") {
    throw new Error("pi-tmux-bash standing prompt version must be larkin-standing-v30");
  }
  if (raw.workspace?.success_path !== "isolated-git-fixture") {
    throw new Error("pi-tmux-bash eval success path must be isolated-git-fixture");
  }
  if (raw.workspace?.production_claim !== "not-assumed") {
    throw new Error("pi-tmux-bash eval must not claim production or non-git support");
  }
  if (raw.plugin?.name !== "@richardgill/pi-tmux-bash" || raw.plugin?.version !== "0.0.12") {
    throw new Error("pi-tmux-bash eval must pin external @richardgill/pi-tmux-bash@0.0.12");
  }
  if (raw.plugin?.distribution !== "external-user-installed") {
    throw new Error("pi-tmux-bash plugin must be recorded as external-user-installed");
  }
  if (raw.harness?.headless !== true || raw.harness?.tui_independent !== true) {
    throw new Error("pi-tmux-bash eval must record a headless TUI-independent RPC harness");
  }
  if (!Array.isArray(raw.harness?.pi_args) || !raw.harness.pi_args.includes("--mode")
    || !raw.harness.pi_args.includes("rpc") || !raw.harness.pi_args.includes("--no-session")
    || !raw.harness.pi_args.includes("--no-extensions") || !raw.harness.pi_args.includes("-e")) {
    throw new Error("pi-tmux-bash eval must pin real Pi --mode rpc --no-session --no-extensions -e");
  }
  if (typeof raw.model?.selection !== "string" || !raw.model.selection) {
    throw new Error("eval model must be set");
  }
  if (typeof raw.threshold !== "number" || raw.threshold <= 0 || raw.threshold > 1) {
    throw new Error("eval threshold must be in (0, 1]");
  }
  if (raw.core_acceptance_rate !== 1) {
    throw new Error("core acceptance deterministic assertions must require rate 1");
  }
  if (typeof raw.threshold_rationale !== "string" || raw.threshold_rationale.length < 40) {
    throw new Error("pi-tmux-bash model-eval threshold needs a meaningful rationale");
  }
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new Error("eval scenarios must be non-empty");
  }
  const scenarios = raw.scenarios.map((scenario) => {
    if (!scenario || typeof scenario !== "object") throw new Error("scenario must be an object");
    if (!scenario.id || typeof scenario.id !== "string") throw new Error("scenario.id required");
    if (!scenario.prompt || typeof scenario.prompt !== "string") {
      throw new Error(`scenario ${scenario.id}.prompt required`);
    }
    if (!scenario.task_bash || typeof scenario.task_bash !== "string") {
      throw new Error(`scenario ${scenario.id}.task_bash required`);
    }
    if (!scenario.expectations || typeof scenario.expectations !== "object") {
      throw new Error(`scenario ${scenario.id}.expectations required`);
    }
    const kind = scenario.kind || "prescribed";
    if (kind !== "prescribed" && kind !== "natural") {
      throw new Error(`scenario ${scenario.id}.kind must be prescribed or natural`);
    }
    for (const key of BOOLEAN_KEYS) {
      if (scenario.expectations[key] !== undefined && typeof scenario.expectations[key] !== "boolean") {
        throw new Error(`scenario ${scenario.id}.expectations.${key} must be boolean`);
      }
    }
    return { ...scenario, kind };
  });
  if (!scenarios.some((scenario) => scenario.kind === "natural")) {
    throw new Error("pi-tmux-bash eval must include at least one natural user request");
  }
  return { ...raw, scenarios };
}

function toolStarts(trace, toolName) {
  return trace.filter((event) => event?.type === "tool_execution_start" && event.toolName === toolName);
}

function toolEnds(trace, toolName) {
  return trace.filter((event) => event?.type === "tool_execution_end" && event.toolName === toolName);
}

function stringifyResult(event) {
  if (!event) return "";
  if (typeof event.resultText === "string") return event.resultText;
  return event.result ? JSON.stringify(event.result) : "";
}

function collectWindowIds(text) {
  return [...String(text || "").matchAll(WINDOW_ID_RE)].map((match) => match[0]);
}

function assistantText(trace) {
  return trace.filter(IS_TEXT_DELTA)
    .map((event) => String(event.assistantMessageEvent?.content || event.assistantMessageEvent?.delta || ""))
    .join(" ");
}

export function gradePiTmuxBashTrace(scenario, trace) {
  const events = Array.isArray(trace) ? trace : [];
  const expectations = scenario.expectations;
  const bashStarts = toolStarts(events, "bash");
  const bashEnds = toolEnds(events, "bash");
  const tmuxStarts = toolStarts(events, "tmux");
  const forced = events.filter((event) =>
    event?.type === "tool_execution_start" && FORCED_SUBAGENT_TOOLS.has(event.toolName));
  const bashText = bashEnds.map(stringifyResult).join("\n");
  const allToolText = [...bashEnds, ...toolEnds(events, "tmux")].map(stringifyResult).join("\n");
  const ids = collectWindowIds(`${bashText}\n${allToolText}`);
  const text = assistantText(events);
  const completion = extractTmuxBashCompletion(events);
  const marker = String(scenario.marker || scenario.task_bash.split(" ").pop() || "");

  const results = {
    uses_bash: bashStarts.length > 0,
    no_forced_subagent: forced.length === 0,
    wait_timeout_not_failure: STILL_RUNNING_RE.test(bashText) || ids.length > 0
      || extractTimedOutBackground(bashEnds) !== null,
    returned_id: ids.length > 0,
    inspects_by_returned_id: tmuxStarts.some((event) => {
      const action = event.args?.action;
      if (action === "list") return true;
      return action === "peek" && ids.includes(String(event.args?.window || ""));
    }),
    stops_by_returned_id: tmuxStarts.some((event) =>
      event.args?.action === "kill" && ids.includes(String(event.args?.window || ""))),
    completion_followup: completion !== null,
    stays_in_originating_target: !NEW_TARGET_RE.test(text),
    final_summary: marker ? text.includes(marker) || allToolText.includes(marker)
      || JSON.stringify(completion || {}).includes(marker) : /completed|output|result/i.test(text),
    no_hard_kill_or_lifetime_cap: !HARD_KILL_RE.test(JSON.stringify(events)) && forced.length === 0,
    turn_completed: events.some((event) => event?.type === "agent_end"),
  };

  const passed = Object.keys(expectations).every((key) => results[key] === expectations[key]);
  return { passed, results, expectations };
}

export function summarizePiTmuxBashEval(results) {
  const passed = results.filter((result) => result.passed).length;
  return { passed, total: results.length, rate: results.length === 0 ? 0 : passed / results.length };
}
