import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";

test("native Codex delivery remains steerable while child threads start, fail and finish", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  const writes = [];
  const notify = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
  child.stdin = { write(line, cb) {
    const req = JSON.parse(line); writes.push(req); cb?.();
    if (req.id) queueMicrotask(() => {
      const result = req.method === "thread/start" ? { thread: { id: "root-thread" } }
        : req.method === "turn/start" ? { turn: { id: "root-turn" } } : {};
      const wrongSteer = req.method === "turn/steer"
        && (req.params.threadId !== "root-thread" || req.params.expectedTurnId !== "root-turn");
      child.stdout.write(`${JSON.stringify({ id: req.id, ...(wrongSteer
        ? { error: { message: "expected active turn id child-turn but found root-turn" } } : { result }) })}\n`);
      if (req.method === "turn/start") notify("turn/started", { threadId: "root-thread", turn: { id: "root-turn" } });
    });
    return true;
  } };
  const native = createNativeRuntimeAdapter("codex", { spawn: () => child });
  const adapter = { ...native, async probe() { return { runtime: "codex", state: "ready" }; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), assertOfficialCliReady: () => {} });
  const events = []; host.subscribe(event => events.push(event));
  const agentId = "cli_subagentDelivery";
  const deliver = (id) => host.deliver(agentId, { message_id: id, chat_id: "oc_subagent", content: "review task" });
  try {
    await host.start([{ agentId, name: "reviewer", runtime: "codex", model: "model", workspaceDir: "/tmp" }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await deliver("om_root")).status, "accepted");
    notify("thread/started", { thread: { id: "child-thread" } });
    notify("turn/started", { threadId: "child-thread", turn: { id: "child-turn" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await deliver("om_during_child")).status, "accepted");
    notify("error", { threadId: "child-thread", turnId: "child-turn", error: { message: "child failed" }, willRetry: false });
    notify("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "failed" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.isBusy(agentId), true);
    assert.equal((await deliver("om_after_child")).status, "accepted");
    assert.equal(writes.filter(req => req.method === "turn/start").length, 1);
    assert.equal(writes.filter(req => req.method === "turn/steer").length, 2);
    assert.equal(events.filter(event => event.type === "delivery" && ["error", "deferred"].includes(event.status)).length, 0);
    assert.equal(events.filter(event => event.type === "activity" && event.detailKind === "turn_ended").length, 0);
    notify("turn/completed", { threadId: "root-thread", turn: { id: "root-turn", status: "completed" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.isBusy(agentId), false);
    assert.equal(events.filter(event => event.type === "activity" && event.detailKind === "turn_ended").length, 1);
  } finally {
    await host.shutdown("done"); child.stdout.destroy(); child.stderr.destroy();
  }
});
