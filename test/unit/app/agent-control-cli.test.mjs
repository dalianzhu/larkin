import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { runAgentControlCli } from "../../../dist/app/agent-control-cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("public agent enqueue reads content outside argv and emits stable JSON", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-agent-enqueue-cli-"));
  const agentId = "cli_enqueuePublicA1";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 4, serverId: "server-test",
    mentionPolicy: "require", activeAgent: agentId, agents: { [agentId]: { runtime: "codex", model: "default" } } }), { mode: 0o600 });
  let stdout = "", request;
  try {
    const code = await runAgentControlCli(["enqueue", "--agent", agentId, "--idempotency-key", "quality-gate:flow-1",
      "--content-file", "-", "--json"], { ...process.env, LARKIN_CONFIG_DIR: root }, {
        readContent() { return "inspect release"; },
        async request(input) { request = input; return { ok: true, agentId, messageId: "external_1234",
          status: "accepted", deliveryId: "delivery-1" }; },
        io: { stdout: (value) => { stdout += value; }, stderr() {} },
      });
    assert.equal(code, 0);
    assert.deepEqual(request, { larkinHome: root, agentId, idempotencyKey: "quality-gate:flow-1",
      content: "inspect release" });
    assert.deepEqual(JSON.parse(stdout), { ok: true, agent_id: agentId, status: "accepted",
      message_id: "external_1234", delivery_id: "delivery-1" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("agent enqueue rejects unsafe or incomplete requests before control access", async () => {
  const cases = [
    [[], /unsupported agent subcommand/],
    [["enqueue", "--json", "--agent", "cli_x", "--idempotency-key", "bad key", "--content-file", "-"], /idempotency/],
    [["enqueue", "--json", "--agent", "cli_x", "--idempotency-key", "key", "--chat-id", "oc_x", "--content-file", "-"], /unknown flag/],
  ];
  for (const [argv, expected] of cases) {
    let stdout = "", calls = 0;
    const code = await runAgentControlCli(argv, {}, { readContent() { return "content"; },
      async request() { calls += 1; throw new Error("must not run"); },
      io: { stdout: (value) => { stdout += value; }, stderr() {} } });
    assert.equal(code, 1);
    assert.equal(calls, 0);
    assert.match(JSON.parse(stdout).error, expected);
  }
});

test("agent enqueue is user-only and help documents stdin delivery", async () => {
  let stdout = "", calls = 0;
  const code = await runAgentControlCli(["enqueue", "--json", "--agent", "cli_x", "--idempotency-key", "key",
    "--content-file", "-"], { LARKIN_AGENT_ID: "cli_runtime" }, {
      readContent() { return "content"; }, async request() { calls += 1; throw new Error("must not run"); },
      io: { stdout: (value) => { stdout += value; }, stderr() {} },
    });
  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(stdout).code, "user_authority_required");

  const help = spawnSync(process.execPath, [path.join(ROOT, "dist/app/cli.mjs"), "agent", "--help"], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /larkin agent enqueue/);
  assert.match(help.stdout, /--content-file <path\|->/);
});
