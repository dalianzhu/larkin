import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Pinned external package version used by validation. Larkin does not install or embed it. */
export const PINNED_PI_TMUX_BASH_VERSION = "0.0.12";
export const PI_TMUX_BASH_PACKAGE = "@richardgill/pi-tmux-bash";
/** Published 0.0.12 runBashInTmux/executeTool call getGitRoot(ctx.cwd) and fail outside a git repository. */
export const PINNED_PI_TMUX_BASH_REQUIRES_GIT_REPOSITORY = true;

export interface UserPiTmuxBashDiscovery {
  present: boolean;
  version: string | null;
  matchesPin: boolean;
  packageRoot: string | null;
  settingsConfigured: boolean;
  conflicts: string[];
  requiresGitRepository: boolean | null;
  workspaceCompatible: boolean | null;
}

export interface DiscoverUserPiTmuxBashOptions {
  /** Workspace cwd to compare against the pinned git-root gate. Never initializes git. */
  cwd?: string;
}

function userPiAgentDir(env: NodeJS.ProcessEnv): string {
  return env.PI_CODING_AGENT_DIR || path.join(env.HOME || process.env.HOME || "", ".pi", "agent");
}

function assertRegularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("user Pi path is not a regular file");
  }
}

function readRegularFile(file: string): string {
  assertRegularFile(file);
  return fs.readFileSync(file, "utf8");
}

function packageSpecifierName(entry: string): string | null {
  const value = entry.trim();
  if (!value) return null;
  const withoutScheme = value.replace(/^(?:npm|file|link):/i, "");
  const at = withoutScheme.startsWith("@") ? withoutScheme.slice(1).lastIndexOf("@") : withoutScheme.lastIndexOf("@");
  const name = at > 0 ? withoutScheme.slice(0, at + (withoutScheme.startsWith("@") ? 1 : 0)) : withoutScheme;
  return name || null;
}

function isConflictingBashPlugin(name: string): boolean {
  if (name === PI_TMUX_BASH_PACKAGE) return false;
  return /(?:^|\/)(?:pi-tmux-bash|tmux-bash|pi-tmux|pi-bash-timeout)$/i.test(name)
    || /pi-tmux-bash|tmux-bash/i.test(name);
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) return "";
  const next = source.indexOf("export const ", start + `export const ${name}`.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

/** Read-only source probe of a user-or-isolated package tree. Does not install or copy it. */
export function inspectTmuxBashGitRootRequirement(packageRoot: string): {
  runBashInTmuxRequiresGitRoot: boolean;
  executeToolRequiresGitRoot: boolean;
} {
  const source = readRegularFile(path.join(packageRoot, "src", "runtime.ts"));
  const requiresGitRoot = (name: string): boolean => {
    const body = functionSource(source, name);
    return body.includes("getGitRoot(ctx.cwd)") && /not in a git repository/i.test(body);
  };
  return {
    runBashInTmuxRequiresGitRoot: requiresGitRoot("runBashInTmux"),
    executeToolRequiresGitRoot: requiresGitRoot("executeTool"),
  };
}

/** Same read-only git lookup as published 0.0.12 getGitRoot. Never runs git init. */
export function readWorkspaceGitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const root = (result.stdout || "").trim();
  return root || null;
}

function emptyDiscovery(): UserPiTmuxBashDiscovery {
  return {
    present: false,
    version: null,
    matchesPin: false,
    packageRoot: null,
    settingsConfigured: false,
    conflicts: [],
    requiresGitRepository: null,
    workspaceCompatible: null,
  };
}

function workspaceCompatibility(requiresGitRepository: boolean | null, cwd: string | undefined): boolean | null {
  if (requiresGitRepository !== true || !cwd) return null;
  return readWorkspaceGitRoot(cwd) !== null;
}

/**
 * Read-only look at the user's Pi agent dir for a user-installed tmux-bash plugin.
 * Never writes, installs, git-inits, or injects `-e` arguments.
 */
export function discoverUserPiTmuxBash(
  env: NodeJS.ProcessEnv,
  options: DiscoverUserPiTmuxBashOptions = {},
): UserPiTmuxBashDiscovery {
  const agentDir = userPiAgentDir(env);
  const empty = emptyDiscovery();
  try {
    const conflicts = new Set<string>();
    let settingsConfigured = false;
    const settingsFile = path.join(agentDir, "settings.json");
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(readRegularFile(settingsFile)) as { packages?: unknown };
      const packages = settings.packages;
      if (Array.isArray(packages)) {
        for (const entry of packages) {
          if (typeof entry !== "string") continue;
          const name = packageSpecifierName(entry);
          if (!name) continue;
          if (name === PI_TMUX_BASH_PACKAGE) settingsConfigured = true;
          else if (isConflictingBashPlugin(name)) conflicts.add(name);
        }
      }
    }
    const packageRoots = [
      path.join(agentDir, "n" + "pm", "node_modules", "@richardgill", "pi-tmux-bash"),
      path.join(agentDir, "node_modules", "@richardgill", "pi-tmux-bash"),
    ];
    const packageRoot = packageRoots.find((root) => fs.existsSync(root)) ?? null;
    if (!packageRoot) {
      return { ...empty, settingsConfigured, conflicts: [...conflicts].sort() };
    }
    const manifest = JSON.parse(readRegularFile(path.join(packageRoot, "package.json"))) as {
      name?: unknown;
      version?: unknown;
    };
    if (manifest.name !== PI_TMUX_BASH_PACKAGE || typeof manifest.version !== "string" || !manifest.version) {
      return { ...empty, settingsConfigured, conflicts: [...conflicts].sort() };
    }
    const matchesPin = manifest.version === PINNED_PI_TMUX_BASH_VERSION;
    const requiresGitRepository = matchesPin ? PINNED_PI_TMUX_BASH_REQUIRES_GIT_REPOSITORY : null;
    return {
      present: true,
      version: manifest.version,
      matchesPin,
      packageRoot,
      settingsConfigured,
      conflicts: [...conflicts].sort(),
      requiresGitRepository,
      workspaceCompatible: workspaceCompatibility(requiresGitRepository, options.cwd),
    };
  } catch {
    return empty;
  }
}
