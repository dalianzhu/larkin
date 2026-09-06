export const TMUX_BASH_COMPLETION_TYPE = "tmux-bash-completion";
export const TMUX_BASH_POLL_TYPE = "tmux-bash-poll";

export type TmuxBashFollowUpKind = typeof TMUX_BASH_COMPLETION_TYPE | typeof TMUX_BASH_POLL_TYPE;

export interface TmuxBashFollowUp {
  kind: TmuxBashFollowUpKind;
  key: string;
}

function isFollowUpKind(value: unknown): value is TmuxBashFollowUpKind {
  return value === TMUX_BASH_COMPLETION_TYPE || value === TMUX_BASH_POLL_TYPE;
}

function followUpKey(kind: TmuxBashFollowUpKind, content: string): string {
  return `${kind}:${content}`;
}

function collectFollowUps(node: unknown, found: TmuxBashFollowUp[] = [], seen = new Set<string>()): TmuxBashFollowUp[] {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const item of node) collectFollowUps(item, found, seen);
    return found;
  }
  if (typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  if (isFollowUpKind(record.customType) && typeof record.content === "string") {
    const key = followUpKey(record.customType, record.content);
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ kind: record.customType, key });
    }
  }
  if (Array.isArray(record.content)) collectFollowUps(record.content, found, seen);
  if (Array.isArray(record.messages)) collectFollowUps(record.messages, found, seen);
  if (Array.isArray(record.parts)) collectFollowUps(record.parts, found, seen);
  return found;
}

/** Extract Pi followUp custom messages emitted by @richardgill/pi-tmux-bash. */
export function extractTmuxBashFollowUp(messages: unknown): TmuxBashFollowUp | null {
  const found = collectFollowUps(messages);
  return found.find((item) => item.kind === TMUX_BASH_COMPLETION_TYPE) ?? found[0] ?? null;
}

export function buildTmuxBashFollowUpMessage(kind: TmuxBashFollowUpKind, content: string): {
  role: "assistant";
  content: Array<{ type: "custom"; customType: TmuxBashFollowUpKind; content: string }>;
} {
  return {
    role: "assistant",
    content: [{ type: "custom", customType: kind, content }],
  };
}
