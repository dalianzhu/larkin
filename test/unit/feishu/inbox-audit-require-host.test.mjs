import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import { inboxAuditRegistryFile, readInboxAuditTargets } from "../../../dist/agent/missed-outbound-scan.mjs";

const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

async function waitFor(condition, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} did not settle`);
}

test("Host ingest records only originally wake=true group traffic into the audit registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-host-"));
  const agentId = "cli_inboxAuditHostA1";
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId),
    larkConfigDir: path.join(root, "state", "agents", agentId, "lark-cli-config"),
  };
  const env = {
    LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-inbox-audit-host",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
  };
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async deliver() { return { status: "accepted" }; },
    async stop() {},
    async shutdown() {},
  };
  const host = createHostShell({
    env, runtimeHost, eventSourceStartDelayMs: 60_000,
    managedCliForAgent: testManagedCli,
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_human", name: "Human" }] } }), "");
      return {};
    },
  });
  const event = {
    chat_id: CHAT, chat_type: "group", sender_id: "ou_human", message_id: "om_unmentioned",
    event_id: "ev_unmentioned", content: "hello", thread_id: null,
    _mentioned_bot: false, _mention_all: false, _sender_is_bot: false, _scan_authority: true,
  };
  try {
    await host.ingest(agentId, event, { wake: false });
    assert.equal(readInboxAuditTargets(inboxAuditRegistryFile(root), agentId).targets.length, 0);
    await host.ingest(agentId, { ...event, source_seq: 999, message_id: "om_mentioned", event_id: "ev_mentioned" }, { wake: true });
    const audit = readInboxAuditTargets(inboxAuditRegistryFile(root), agentId);
    assert.deepEqual(audit.targets.map((row) => row.anchor), ["om_mentioned"]);
    assert.equal(audit.targets[0].target, `chat:${CHAT}`);
    assert.equal(JSON.parse(fs.readFileSync(inboxAuditRegistryFile(root), "utf8")).targets[0].source_seq, 2, "Host uses canonical append sequence, never an external event field");
  } finally {
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a held audit lock persists the Host retry intent and recovers it after release", { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-host-retry-"));
  const agentId = "cli_inboxAuditRetryA1";
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId),
    larkConfigDir: path.join(root, "state", "agents", agentId, "lark-cli-config"),
  };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-inbox-audit-retry", LARKIN_AGENTS_CONFIG: JSON.stringify([agent]) };
  const host = createHostShell({ env, runtimeHost: { subscribe() { return () => {}; }, async start() {}, async deliver() { return { status: "accepted" }; }, async stop() {}, async shutdown() {} }, eventSourceStartDelayMs: 60_000, managedCliForAgent: testManagedCli,
    execFileImpl(_command, _args, _options, callback) { callback(null, JSON.stringify({ ok: true, data: { items: [] } }), ""); return {}; } });
  const registry = inboxAuditRegistryFile(root);
  const lock = `${registry}.mutation-lock`;
  const started = path.join(root, "lock-started");
  const release = path.join(root, "lock-release");
  const child = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const { acquireProcessLock } = require(process.argv[1]);
const held = acquireProcessLock(process.argv[2], require("node:path").basename(process.execPath));
fs.writeFileSync(process.argv[3], "ready");
const timer = setInterval(() => { if (fs.existsSync(process.argv[4])) { clearInterval(timer); held.release(); process.exit(0); } }, 10);
`, path.join(ROOT, "dist", "platform", "process-state.cjs"), lock, started, release], { stdio: "ignore" });
  try {
    await waitFor(() => fs.existsSync(started), "lock holder");
    await host.ingest(agentId, { chat_id: CHAT, chat_type: "group", sender_id: "ou_human", message_id: "om_retry_after_lock", event_id: "ev_retry_after_lock", content: "retry", thread_id: null, _sender_is_bot: false, _scan_authority: true }, { wake: true });
    assert.equal(readInboxAuditTargets(registry, agentId).targets.length, 0, "the held registry lock prevents immediate indexing");
    assert.equal(fs.existsSync(path.join(root, "inbox-audit-retry.json")), true, "canonical wake eligibility is durably queued for reconciliation");
    fs.writeFileSync(release, "release");
    await new Promise((resolve, reject) => { child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock holder exit ${code}`))); child.once("error", reject); });
    await waitFor(() => readInboxAuditTargets(registry, agentId).targets.some((row) => row.anchor === "om_retry_after_lock"), "reconciled audit target");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
