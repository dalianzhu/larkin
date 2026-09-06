export const TMUX_BASH_COMPLETION_TYPE = "tmux-bash-completion";
export const TMUX_BASH_POLL_TYPE = "tmux-bash-poll";
export const SUBAGENT_NOTIFICATION_TYPE = "subagent-notification";

export interface AutonomousPiFollowUp {
  customType: string;
  key: string;
}

function isAutonomousCustomType(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== SUBAGENT_NOTIFICATION_TYPE;
}

function followUpKey(customType: string, content: string): string {
  return `${customType}:${content}`;
}

function collectFollowUps(node: unknown, found: AutonomousPiFollowUp[] = [], seen = new Set<string>()): AutonomousPiFollowUp[] {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const item of node) collectFollowUps(item, found, seen);
    return found;
  }
  if (typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  if (isAutonomousCustomType(record.customType) && typeof record.content === "string") {
    const key = followUpKey(record.customType, record.content);
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ customType: record.customType, key });
    }
  }
  if (Array.isArray(record.content)) collectFollowUps(record.content, found, seen);
  if (Array.isArray(record.messages)) collectFollowUps(record.messages, found, seen);
  if (Array.isArray(record.parts)) collectFollowUps(record.parts, found, seen);
  return found;
}

/**
 * Native Pi triggerTurn/followUp custom messages occupy an autonomous turn.
 * Canonical subagent-notification stays on the historical host-wake path.
 */
export function extractAutonomousPiFollowUp(messages: unknown): AutonomousPiFollowUp | null {
  const found = collectFollowUps(messages);
  return found.find((item) => item.customType === TMUX_BASH_COMPLETION_TYPE) ?? found[0] ?? null;
}

export function buildAutonomousFollowUpMessage(customType: string, content: string): {
  role: "assistant";
  content: Array<{ type: "custom"; customType: string; content: string }>;
} {
  return {
    role: "assistant",
    content: [{ type: "custom", customType, content }],
  };
}

export function buildTmuxBashFollowUpMessage(kind: typeof TMUX_BASH_COMPLETION_TYPE | typeof TMUX_BASH_POLL_TYPE, content: string) {
  return buildAutonomousFollowUpMessage(kind, content);
}
