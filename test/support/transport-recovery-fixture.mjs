import fs from "node:fs";
import path from "node:path";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";
import { createHostShell } from "../../dist/feishu/host-shell.mjs";
import { runAgentCli } from "../../dist/app/agent-cli.mjs";

export const fixtureAgentId = "cli_transportA1";
export const fixtureOtherId = "cli_transportB2";
export const fixtureStreamError = "stream disconnected before completion: stream closed before response.completed";
export async function createTransportFixture(root, { now = () => Date.now(), onPrompt, onCreate, storeDecorator = (store) => store } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  const stores = new Map([fixtureAgentId, fixtureOtherId].map((id) => [id, createAgentStateStore(root, id)]));
  const store = stores.get(fixtureAgentId);
  const sessions = [];
  let host, runtime;
  let serial = 0;
  const agents = [...stores.keys()].map((agentId) => ({ agentId, name: agentId, runtime: "codex", model: "fixture-model",
    feishuAppId: agentId, feishuProfile: agentId, larkConfigDir: path.join(stores.get(agentId).paths.root, "lark-cli-config"),
    workspaceDir: path.join(root, "agents", agentId), stateDir: stores.get(agentId).paths.root }));
  const current = () => sessions.filter((session) => session.agentId === fixtureAgentId).at(-1);
  const start = async () => {
    runtime = createRuntimeHost({ promptBuilder: new ContextPromptBuilder(), stateStoreFor: (id) => storeDecorator(stores.get(id)),
      assertOfficialCliReady: async () => {}, transportRecoveryPolicy: { now, stageTimeoutMs: 100 },
      adapterFor: () => ({ id: "codex", capabilities: {}, async probe() { return { runtime: "codex", state: "ready" }; }, async createSession(config) {
        const session = { agentId: config.agentId, sessionId: config.resumeSessionId || `session-${config.agentId}-${++serial}`,
          config, inputs: [], closes: [], listeners: new Set(),
          subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
          emit(event) { for (const fn of this.listeners) fn(event); },
          async prompt(input) { this.inputs.push(input); await onPrompt?.(input, this); return { status: "accepted", inputId: input.inputId }; },
          async busyInput(input) { return this.prompt(input); }, async close(reason) { this.closes.push(reason); } };
        await onCreate?.(config, session);
        sessions.push(session); return session;
      } }),
    });
    host = createHostShell({ env: { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-transport-fixture",
      LARKIN_AGENTS_CONFIG: JSON.stringify(agents), LARKIN_FEISHU_DRYRUN: "1", LARKIN_FEISHU_EVENT_FILE: path.join(root, "events.ndjson"), LARKIN_INBOUND_DROUGHT_SEC: "0" },
      runtimeHost: runtime, stateStoreForImpl: (_root, id) => stores.get(id), logImpl() {}, eventSourceStartDelayMs: 60_000,
      managedCliForAgent: () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} }),
      execFileImpl(_command, _args, _options, callback) { callback(null, JSON.stringify({ ok: true, data: { items: [] } }), ""); return {}; },
    });
    await host.start();
    for (const st of stores.values()) st.writeJson("status", { ...st.readJson("status", {}), connectedAt: new Date().toISOString() });
  };
  await start();
  return {
    root, store, stores, sessions, current, host: () => host, runtime: () => runtime,
    async fail({ messageId = "om_transport_failed", reason = fixtureStreamError, category = "provider" } = {}) {
      await host.ingest(fixtureAgentId, { message_id: messageId, event_id: `evt_${messageId}`, chat_id: "oc_transport", chat_type: "group",
        sender_id: "ou_transport_fixture", content: "ORIGINAL_SIDE_EFFECT_MUST_NOT_REPLAY", _mentioned_bot: true, _sender_is_bot: true });
      const input = current().inputs.at(-1);
      current().emit({ type: "turn-start" });
      current().emit({ type: "input-error", inputId: input.inputId, retryable: false, willRetry: false, errorCategory: category, message: reason });
      current().emit({ type: "turn-end", outcome: "error" });
    },
    async inspect() { return host.recoverTransportSession(fixtureAgentId, {}); },
    review(plan, disposition = "already-completed") { return { planToken: plan.token, decisions: plan.failures.map((failure) => ({ deliveryId: failure.deliveryId,
      target: failure.target, owner: fixtureAgentId, disposition, evidence: "Synthetic authoritative read-only receipt confirms completion.",
      ...(disposition === "resume" ? { instruction: "Finish only the verified remaining step." } : {}) })) }; },
    async commit(plan, review) { return host.recoverTransportSession(fixtureAgentId, { planToken: plan.token, review }); },
    async finish({ outcome = "success", poll = true } = {}) {
      const session = current(); session.emit({ type: "turn-start" });
      if (poll) {
        let stderr = "";
        const result = await runAgentCli(["inbox", "poll", "--target", "chat:oc_transport", "--limit", "1", "--json"],
          { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: fixtureAgentId },
          { io: { stdout() {}, stderr(value) { stderr += value; } } });
        if (result !== 0) throw new Error(`fixture poll failed: ${stderr}`);
      }
      session.emit({ type: "activity", activity: "text", text: "Read-only reconciliation completed." });
      session.emit({ type: "turn-end", outcome });
    },
    async restart() { await host.shutdown("synthetic restart"); await start(); },
    async close() { await host.shutdown("transport fixture complete"); },
  };
}
