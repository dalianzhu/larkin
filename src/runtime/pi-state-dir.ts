import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Same implicit root the Pi adapter uses when `stateDir` is omitted. */
export function effectivePiStateDir(input: { workspaceDir: string; stateDir?: string }): string {
  return input.stateDir ?? path.join(input.workspaceDir, ".larkin");
}

/** 单层 0700 目录：拒绝 symlink，也不顺着父目录 link 往外建。 */
export function ensurePrivateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  try {
    const existing = fs.lstatSync(resolved);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`unsafe private directory: ${resolved}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      const parentStat = fs.lstatSync(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error(`unsafe private directory parent: ${parent}`);
    }
    fs.mkdirSync(resolved, { mode: 0o700 });
    const created = fs.lstatSync(resolved);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`unsafe private directory: ${resolved}`);
  }
  if (process.platform !== "win32") fs.chmodSync(resolved, 0o700);
}

/** 原子写 0600 文件；目标已是 symlink 时拒绝，避免落到目录外。 */
export function writePrivateAtomic(file: string, content: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${path.basename(file)} must not be a symlink`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}
