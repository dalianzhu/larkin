import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const action = argv.shift() || "";

function value(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || "" : "";
}

function required(flag) {
  const result = value(flag);
  if (!result) throw new Error(`${flag} is required`);
  return result;
}

const root = required("--root");
const agentId = required("--agent-id");
const traceFile = path.join(root, "trace.ndjson");

function record(event) {
  fs.appendFileSync(traceFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

function parsedOutput(stdout) {
  const line = String(stdout || "").trim().split("\n").filter(Boolean).at(-1);
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function runPublicCli(traceAction, cliArgs) {
  const sourceRoot = required("--source-root");
  const command = path.join(sourceRoot, "dist", "app", "cli.mjs");
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    LARKIN_HOME: root,
    LARKIN_CONFIG_DIR: root,
    LARKIN_AGENT_ID: agentId,
  };
  const result = spawnSync(process.execPath, [command, ...cliArgs], {
    cwd: sourceRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  record({ action: traceAction, surface: "public-cli", argv: cliArgs, exit_code: result.status ?? 1,
    ...(traceAction === "audit_complete" ? { requested_outcome: value("--outcome"), requested_receipt: value("--receipt") } : {}),
    result: parsedOutput(result.stdout) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

if (action === "audit-read") {
  runPublicCli("audit_read", ["inbox", "audit", "--json"]);
}
if (action === "audit-complete") {
  runPublicCli("audit_complete", ["inbox", "audit", "complete", "--receipt", required("--receipt"), "--outcome", required("--outcome"), "--json"]);
}
if (action === "verify-read") {
  runPublicCli("verification_audit_read", ["inbox", "audit", "--json"]);
}
if (action === "history") {
  const target = required("--target");
  const anchor = required("--anchor");
  const history = JSON.parse(fs.readFileSync(path.join(root, "history.json"), "utf8"));
  record({ action: "fake_history", surface: "synthetic-cli-stub", target, anchor, result: history.result });
  process.stdout.write(`${JSON.stringify({ ok: true, synthetic: true, target, anchor, result: history.result })}\n`);
  process.exit(0);
}
if (action === "reply") {
  const target = required("--target");
  const anchor = required("--anchor");
  const text = required("--text");
  record({ action: "fake_send", surface: "synthetic-cli-stub", target, anchor, body: text });
  process.stdout.write(`${JSON.stringify({ ok: true, synthetic: true, target, anchor })}\n`);
  process.exit(0);
}

process.stderr.write("unknown inbox-audit eval gateway action\n");
process.exit(2);
