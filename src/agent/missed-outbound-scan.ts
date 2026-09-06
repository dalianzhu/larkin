import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireProcessLock } from "../platform/process-state.js";

/** Historical reminder loops are deliberately unrelated to this bounded audit registry. */
export const INBOX_AUDIT_LEGACY_MIGRATION_NON_GOAL = "New versions no longer create missed-outbound loops; existing indistinguishable historical loops are not migrated or deleted automatically.";
export const MAX_INBOX_AUDIT_TARGETS = 96;
const MAX_STORED_TARGETS = MAX_INBOX_AUDIT_TARGETS;
export const MAX_INBOX_AUDIT_REGISTRY_BYTES = 64 * 1024;
export const MAX_INBOX_AUDIT_REGISTRY_ROWS = MAX_INBOX_AUDIT_TARGETS;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const CHAT = /^oc_[A-Za-z0-9]+$/;
const THREAD = /^omt_[A-Za-z0-9]+$/;
const ANCHOR = /^om_[A-Za-z0-9_-]+$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(["no-finding", "handled"]);

export interface InboxAuditTarget { target: string; anchor: string; observed_at: string }
export type InboxAuditOutcome = "no-finding" | "handled";
type AuditStatus = "pending" | "completed";
interface StoredTarget extends InboxAuditTarget {
  agent_id: string;
  generation: string;
  status: AuditStatus;
  completed_at?: string;
  completed_anchor?: string;
  completed_outcome?: InboxAuditOutcome;
}
interface AuditRegistry { version: 3; targets: StoredTarget[] }
interface ReceiptPayload { v: 1; agent_id: string; target: string; anchor: string; revision: string }

export function inboxAuditRegistryFile(larkinHome: string): string { return path.join(larkinHome, "inbox-audit.json"); }

function parseTarget(event: { chat_id?: string; thread_id?: string | null; message_id?: string }): { target: string; anchor: string } | null {
  const chatId = String(event.chat_id || "");
  const threadId = event.thread_id ? String(event.thread_id) : "";
  const anchor = String(event.message_id || "");
  if (!CHAT.test(chatId) || !ANCHOR.test(anchor) || (threadId && !THREAD.test(threadId))) return null;
  return { target: threadId ? `thread:${chatId}:${threadId}` : `chat:${chatId}`, anchor };
}

function emptyRegistry(): AuditRegistry { return { version: 3, targets: [] }; }

function assertSafeExistingFile(file: string, label: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function prepareRegistryDirectory(file: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("inbox audit registry directory is unsafe");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("inbox audit registry directory is not owned by the current user");
}

function load(file: string): AuditRegistry {
  let fd: number | undefined;
  let bytes: Buffer;
  try {
    assertSafeExistingFile(file, "inbox audit registry");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("inbox audit registry is not a regular file");
    const buffer = Buffer.alloc(MAX_INBOX_AUDIT_REGISTRY_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_INBOX_AUDIT_REGISTRY_BYTES) throw new Error("inbox audit registry exceeds the bounded byte limit");
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const value = JSON.parse(bytes.toString("utf8")) as { version?: unknown; targets?: unknown };
  // v1 had no wake provenance; v2 had no durable observation generation.
  // Neither can safely issue a completion receipt after this lifecycle upgrade.
  if (value?.version !== 3 || !Array.isArray(value.targets)) return emptyRegistry();
  if (value.targets.length > MAX_INBOX_AUDIT_REGISTRY_ROWS) throw new Error("inbox audit registry exceeds the bounded row limit");
  return { version: 3, targets: value.targets.flatMap((row): StoredTarget[] => {
    if (!row || typeof row !== "object") return [];
    const candidate = row as Partial<StoredTarget>;
    if (typeof candidate.target !== "string" || typeof candidate.anchor !== "string") return [];
    const parts = candidate.target.split(":");
    const parsed = parseTarget({
      chat_id: candidate.target.startsWith("chat:") ? candidate.target.slice(5) : parts[1],
      thread_id: candidate.target.startsWith("thread:") ? parts[2] : null,
      message_id: candidate.anchor,
    });
    const status = candidate.status === "completed" ? "completed" : candidate.status === "pending" ? "pending" : null;
    if (!status || typeof candidate.agent_id !== "string" || !candidate.agent_id || typeof candidate.generation !== "string" || !GENERATION.test(candidate.generation) || !parsed || candidate.target !== parsed.target
      || typeof candidate.observed_at !== "string" || !Number.isFinite(Date.parse(candidate.observed_at))) return [];
    const completed_at = typeof candidate.completed_at === "string" && Number.isFinite(Date.parse(candidate.completed_at)) ? candidate.completed_at : undefined;
    const completed_anchor = typeof candidate.completed_anchor === "string" && ANCHOR.test(candidate.completed_anchor) ? candidate.completed_anchor : undefined;
    const completed_outcome = OUTCOMES.has(String(candidate.completed_outcome)) ? candidate.completed_outcome as InboxAuditOutcome : undefined;
    return [{ agent_id: candidate.agent_id, generation: candidate.generation, ...parsed, observed_at: candidate.observed_at, status,
      ...(completed_at ? { completed_at } : {}), ...(completed_anchor ? { completed_anchor } : {}),
      ...(completed_outcome ? { completed_outcome } : {}) }];
  }) };
}

function save(file: string, registry: AuditRegistry): void {
  if (registry.targets.length > MAX_INBOX_AUDIT_REGISTRY_ROWS) throw new Error("inbox audit registry exceeds the bounded row limit");
  const serialized = `${JSON.stringify(registry)}\n`;
  if (Buffer.byteLength(serialized) > MAX_INBOX_AUDIT_REGISTRY_BYTES) throw new Error("inbox audit registry exceeds the bounded byte limit");
  prepareRegistryDirectory(file);
  assertSafeExistingFile(file, "inbox audit registry");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); fs.chmodSync(file, 0o600); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
}

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Serialize Host observers and CLI completion without replacing a newer registry snapshot. */
function mutate<T>(file: string, operation: (registry: AuditRegistry) => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const lockFile = `${file}.mutation-lock`;
  prepareRegistryDirectory(file);
  while (Date.now() <= deadline) {
    let lock: ReturnType<typeof acquireProcessLock> | undefined;
    try {
      assertSafeExistingFile(lockFile, "inbox audit mutation lock");
      lock = acquireProcessLock(lockFile, path.basename(process.execPath), { malformedGraceMs: 1_000 });
      const registry = load(file);
      const result = operation(registry);
      save(file, registry);
      return result;
    } catch (error) {
      if (lock || !/lock 已被|无法取得 lock|正在创建|暂不能接管|并发重试耗尽/.test(error instanceof Error ? error.message : String(error))) throw error;
      sleep(LOCK_RETRY_MS);
    } finally { lock?.release(); }
  }
  throw new Error("inbox audit registry busy: bounded lock contention");
}

function revision(row: Pick<StoredTarget, "agent_id" | "target" | "anchor" | "generation" | "status">): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({
    v: 2, agent_id: row.agent_id, target: row.target, anchor: row.anchor, generation: row.generation, status: row.status,
  })).digest("hex")}`;
}

function receipt(row: StoredTarget): string {
  const payload: ReceiptPayload = { v: 1, agent_id: row.agent_id, target: row.target, anchor: row.anchor, revision: revision(row) };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function parseReceipt(value: string): ReceiptPayload | null {
  try {
    const raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ReceiptPayload>;
    if (raw.v !== 1 || typeof raw.agent_id !== "string" || !raw.agent_id || typeof raw.target !== "string" || typeof raw.anchor !== "string"
      || typeof raw.revision !== "string" || !raw.revision.startsWith("sha256:")) return null;
    const parts = raw.target.split(":");
    const parsed = parseTarget({ chat_id: raw.target.startsWith("chat:") ? raw.target.slice(5) : parts[1], thread_id: raw.target.startsWith("thread:") ? parts[2] : null, message_id: raw.anchor });
    return parsed?.target === raw.target ? raw as ReceiptPayload : null;
  } catch { return null; }
}

export function observeInboxAuditTarget(file: string, agentId: string, event: {
  chat_id?: string; chat_type?: string; thread_id?: string | null; message_id?: string; wake?: boolean; _sender_is_bot?: boolean; _scan_authority?: boolean;
}, now = new Date()): boolean {
  if (event.wake !== true || event._scan_authority !== true || event._sender_is_bot !== false || event.chat_type !== "group") return false;
  const parsed = parseTarget(event);
  if (!parsed) return false;
  return mutate(file, (registry) => {
    const existing = registry.targets.find((row) => row.agent_id === agentId && row.target === parsed.target);
    if (existing?.status === "completed" && existing.anchor === parsed.anchor) return false;
    registry.targets = registry.targets.filter((row) => row.agent_id !== agentId || row.target !== parsed.target);
    registry.targets.unshift({ agent_id: agentId, generation: crypto.randomUUID(), ...parsed, observed_at: now.toISOString(), status: "pending" });
    registry.targets = registry.targets.slice(0, MAX_STORED_TARGETS);
    return true;
  });
}

function instruction(target: InboxAuditTarget, receiptValue: string): string {
  const history = target.target.startsWith("thread:") ? "Use larkin im +threads-messages-list for this exact thread." : "Use larkin im +chat-messages-list for this exact chat.";
  return `${history} Inspect first. When finished, run larkin inbox audit complete --receipt ${receiptValue} --outcome <no-finding|handled> --json. If a real finding needs a response, use the guarded reply path anchored at ${target.anchor}; otherwise stay silent.`;
}

function pendingRows(file: string, agentId: string): StoredTarget[] {
  return load(file).targets.filter((row) => row.agent_id === agentId && row.status === "pending").sort((left, right) => right.observed_at.localeCompare(left.observed_at));
}

export function hasPendingInboxAuditTargets(file: string, agentId: string): boolean { return pendingRows(file, agentId).length > 0; }

/** Public read is intentionally completion-free: a caller crash leaves the target pending. */
export function readInboxAuditTargets(file: string, agentId: string): {
  version: 3; targets: Array<InboxAuditTarget & { revision: string; receipt: string; instruction: string }>; has_more: boolean; no_finding: "stay_silent";
} {
  const rows = pendingRows(file, agentId);
  return { version: 3, targets: rows.slice(0, MAX_INBOX_AUDIT_TARGETS).map((row) => {
    const target = { target: row.target, anchor: row.anchor, observed_at: row.observed_at };
    const receiptValue = receipt(row);
    return { ...target, revision: revision(row), receipt: receiptValue, instruction: instruction(target, receiptValue) };
  }), has_more: rows.length > MAX_INBOX_AUDIT_TARGETS, no_finding: "stay_silent" };
}

export function completeInboxAuditTarget(file: string, agentId: string, receiptValue: string, outcome: string, now = new Date()): {
  completed: boolean; reason: "completed" | "already_completed" | "stale" | "invalid_receipt" | "invalid_outcome";
} {
  if (!OUTCOMES.has(outcome)) return { completed: false, reason: "invalid_outcome" };
  const decoded = parseReceipt(receiptValue);
  if (!decoded || decoded.agent_id !== agentId) return { completed: false, reason: "invalid_receipt" };
  return mutate(file, (registry) => {
    const row = registry.targets.find((candidate) => candidate.agent_id === decoded.agent_id && candidate.target === decoded.target);
    if (!row || row.anchor !== decoded.anchor) return { completed: false, reason: "stale" as const };
    if (row.status === "completed") return { completed: false, reason: "already_completed" as const };
    if (revision(row) !== decoded.revision) return { completed: false, reason: "stale" as const };
    row.status = "completed";
    row.completed_at = now.toISOString();
    row.completed_anchor = row.anchor;
    row.completed_outcome = outcome as InboxAuditOutcome;
    return { completed: true, reason: "completed" as const };
  });
}
