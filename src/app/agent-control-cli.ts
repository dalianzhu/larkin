import fs from "node:fs";
import { loadConfig } from "../platform/config.js";
import { requestAgentEnqueue, type AgentEnqueueResponse } from "./local-control.js";

interface AgentControlCliIo { stdout(value: string): void; stderr(value: string): void }

interface EnqueueArguments {
  agentId: string;
  idempotencyKey: string;
  contentFile: string;
}

function parseEnqueueArguments(args: readonly string[]): EnqueueArguments {
  if (args[0] !== "enqueue") throw new Error("unsupported agent subcommand");
  const values = new Map<string, string>();
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      if (json) throw new Error(`duplicate flag: ${token}`);
      json = true;
      continue;
    }
    if (!["--agent", "--idempotency-key", "--content-file"].includes(token)) {
      throw new Error(token.startsWith("-") ? `unknown flag: ${token}` : `unexpected positional: ${token}`);
    }
    if (values.has(token)) throw new Error(`duplicate flag: ${token}`);
    const value = args[index + 1];
    if (!value || (value.startsWith("-") && !(token === "--content-file" && value === "-"))) {
      throw new Error(`missing value: ${token}`);
    }
    values.set(token, value);
    index += 1;
  }
  if (!json) throw new Error("--json is required");
  const agentId = values.get("--agent") || "";
  const idempotencyKey = values.get("--idempotency-key") || "";
  const contentFile = values.get("--content-file") || "";
  if (!/^cli_[A-Za-z0-9]+$/.test(agentId)) throw new Error("--agent requires an exact App ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(idempotencyKey)) throw new Error("invalid --idempotency-key");
  if (!contentFile) throw new Error("--content-file is required");
  return { agentId, idempotencyKey, contentFile };
}

function readContent(file: string): string {
  const content = fs.readFileSync(file === "-" ? 0 : file, "utf8");
  if (!content.trim() || content.includes("\u0000") || Buffer.byteLength(content) > 32_768) {
    throw new Error("content must be 1..32768 bytes and contain no NUL");
  }
  return content;
}

export async function runAgentControlCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { request?: typeof requestAgentEnqueue; io?: AgentControlCliIo; readContent?: typeof readContent } = {},
): Promise<number> {
  const io = dependencies.io ?? { stdout: (value) => process.stdout.write(value), stderr: (value) => process.stderr.write(value) };
  const fail = (code: string, message: string, agentId = "invalid"): number => {
    io.stdout(`${JSON.stringify({ ok: false, agent_id: agentId, status: "error", code, error: message }, null, 2)}\n`);
    return 1;
  };
  let parsed: EnqueueArguments;
  try { parsed = parseEnqueueArguments(args); }
  catch (error) { return fail("invalid_arguments", error instanceof Error ? error.message : String(error)); }
  if (typeof env.LARKIN_AGENT_ID === "string" && env.LARKIN_AGENT_ID.trim()) {
    return fail("user_authority_required", "agent enqueue is available only from a user terminal", parsed.agentId);
  }
  let content: string;
  try { content = (dependencies.readContent ?? readContent)(parsed.contentFile); }
  catch (error) { return fail("content_unavailable", error instanceof Error ? error.message : String(error), parsed.agentId); }
  try {
    const loaded = loadConfig(env);
    const result = await (dependencies.request ?? requestAgentEnqueue)({
      larkinHome: loaded.config.larkinHome, agentId: parsed.agentId, idempotencyKey: parsed.idempotencyKey,
      content,
    });
    io.stdout(`${JSON.stringify({
      ok: result.ok, agent_id: result.agentId, status: result.status,
      ...(result.messageId ? { message_id: result.messageId } : {}),
      ...(result.deliveryId ? { delivery_id: result.deliveryId } : {}),
      ...(result.code ? { code: result.code } : {}), ...(result.error ? { error: result.error } : {}),
    }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: Pick<AgentEnqueueResponse, "ok" | "status"> & { agent_id: string; code: string; error: string } = {
      ok: false, agent_id: parsed.agentId, status: "error",
      code: /timeout/i.test(message) ? "control_timeout" : "control_unavailable", error: message,
    };
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  process.exitCode = await runAgentControlCli(args, env);
}
