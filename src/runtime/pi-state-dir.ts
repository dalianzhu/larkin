import path from "node:path";

/** Same implicit root the Pi adapter uses when `stateDir` is omitted. */
export function effectivePiStateDir(input: { workspaceDir: string; stateDir?: string }): string {
  return input.stateDir ?? path.join(input.workspaceDir, ".larkin");
}
