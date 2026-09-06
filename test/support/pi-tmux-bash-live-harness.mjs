import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_PLUGIN = { name: "@richardgill/pi-tmux-bash", version: "0.0.12" };
export const UPSTREAM_NON_GIT_ERROR = /not in a git repository/i;
export const INTENDED_EVAL_SCRIPT = "test:eval:pi-tmux-bash";
export const INTENDED_EVAL_COMMAND =
  "bun run build && LARKIN_RUN_PI_TMUX_BASH_EVAL=1 bun test --max-concurrency 1 test/live/pi-tmux-bash-live.test.mjs";
export const HEADLESS_PI_RPC_PREFIX = ["--mode", "rpc", "--no-session", "--no-context-files"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function userPiAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent");
}

export function resolveUserInstalledTmuxBashPackage(env = process.env) {
  const agentDir = userPiAgentDir(env);
  const candidates = [
    path.join(agentDir, "npm", "node_modules", PINNED_PLUGIN.name),
    path.join(agentDir, "node_modules", PINNED_PLUGIN.name),
  ];
  const settingsFile = path.join(agentDir, "settings.json");
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      const packages = Array.isArray(settings.packages) ? settings.packages : [];
      for (const entry of packages) {
        const spec = String(entry || "").replace(/^npm:/, "");
        if (spec === PINNED_PLUGIN.name || spec.startsWith(`${PINNED_PLUGIN.name}@`)) {
          candidates.unshift(path.join(agentDir, "npm", "node_modules", PINNED_PLUGIN.name));
        }
      }
    } catch {
      // settings are only a discovery hint
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const manifestFile = path.join(resolved, "package.json");
    if (!fs.existsSync(manifestFile)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (manifest.name === PINNED_PLUGIN.name && manifest.version === PINNED_PLUGIN.version) {
        return resolved;
      }
    } catch {
      // skip unreadable manifests
    }
  }
  return null;
}

export function resolveTmuxBashPackagePath(env = process.env) {
  const configured = String(env.LARKIN_PI_TMUX_BASH_PACKAGE || "").trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (!fs.existsSync(path.join(resolved, "package.json"))) {
      throw new Error(`LARKIN_PI_TMUX_BASH_PACKAGE is not a package directory: ${resolved}`);
    }
    return resolved;
  }
  return resolveUserInstalledTmuxBashPackage(env);
}

export function packageHasResolvableDependencies(packageDir) {
  let current = path.resolve(packageDir);
  for (let i = 0; i < 6; i += 1) {
    const modules = path.join(current, "node_modules");
    if (fs.existsSync(path.join(modules, "zod"))
      && fs.existsSync(path.join(modules, "@richardgill", "lib"))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

export function resolveTmuxBashLoadMode(env = process.env) {
  const explicit = String(env.LARKIN_PI_TMUX_BASH_LOAD || "").trim();
  if (explicit === "discovery" || explicit === "extension") return explicit;
  return resolveTmuxBashPackagePath(env) ? "extension" : "discovery";
}

export function readPinnedPluginManifest(packageDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (manifest.name !== PINNED_PLUGIN.name || manifest.version !== PINNED_PLUGIN.version) {
    throw new Error(`expected ${PINNED_PLUGIN.name}@${PINNED_PLUGIN.version}, got ${manifest.name}@${manifest.version}`);
  }
  return manifest;
}

export function snapshotUserPiSettings(env = process.env) {
  const agentDir = userPiAgentDir(env);
  const settings = path.join(agentDir, "settings.json");
  if (!fs.existsSync(settings)) return { agentDir, settings, exists: false, stat: null, content: null };
  const stat = fs.statSync(settings);
  return {
    agentDir,
    settings,
    exists: true,
    stat: { mtimeMs: stat.mtimeMs, size: stat.size },
    content: fs.readFileSync(settings, "utf8"),
  };
}

export function assertUserPiSettingsUnchanged(snapshot, env = process.env) {
  const current = snapshotUserPiSettings(env);
  if (current.exists !== snapshot.exists) {
    throw new Error("live harness must not create or delete user Pi settings");
  }
  if (!snapshot.exists) return;
  if (current.stat.mtimeMs !== snapshot.stat.mtimeMs || current.stat.size !== snapshot.stat.size
    || current.content !== snapshot.content) {
    throw new Error("live harness must not modify user Pi settings");
  }
}

export function prepareIsolatedTmuxBashPackage(sourceDir, destDir) {
  readPinnedPluginManifest(sourceDir);
  if (packageHasResolvableDependencies(sourceDir)) return path.resolve(sourceDir);
  fs.cpSync(sourceDir, destDir, { recursive: true });
  const install = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-fund", "--no-audit"], {
    cwd: destDir,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (install.status !== 0) {
    throw new Error(`isolated npm install failed: ${install.stderr || install.stdout}`);
  }
  readPinnedPluginManifest(destDir);
  return destDir;
}

export function buildPiRpcArgs({ packagePath, loadMode, model, extraArgs = [] }) {
  const args = [...HEADLESS_PI_RPC_PREFIX, ...extraArgs];
  if (model) args.push("--model", model);
  if (loadMode === "extension") {
    if (!packagePath) throw new Error("extension load mode requires a local package path");
    args.push("--no-extensions", "-e", packagePath);
  }
  return args;
}

export function assertHeadlessExtensionFixtureArgs(args, packagePath) {
  if (!Array.isArray(args)) throw new Error("Pi RPC args must be an array");
  for (const flag of HEADLESS_PI_RPC_PREFIX) {
    if (!args.includes(flag)) throw new Error(`headless Pi fixture missing ${flag}`);
  }
  if (!args.includes("--no-extensions")) throw new Error("headless Pi fixture missing --no-extensions");
  const extensionIndex = args.indexOf("-e");
  if (extensionIndex < 0) throw new Error("headless Pi fixture missing -e");
  if (packagePath && args[extensionIndex + 1] !== packagePath) {
    throw new Error(`headless Pi fixture -e path mismatch: ${args[extensionIndex + 1]}`);
  }
  return true;
}

export function createIsolatedTmuxWorkspace(prefixOrOptions = "larkin-tmux-eval-") {
  const options = typeof prefixOrOptions === "string" ? { prefix: prefixOrOptions } : { ...prefixOrOptions };
  const prefix = options.prefix || "larkin-tmux-eval-";
  const gitFixture = options.git !== false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workDir = path.join(root, "work");
  const extConfigDir = path.join(root, "ext-config");
  const outputDir = path.join(root, "tmux-out");
  const packageDir = path.join(root, "package");
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(extConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (gitFixture) {
    const init = spawnSync("git", ["init"], { cwd: workDir, encoding: "utf8" });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr || init.stdout}`);
  }
  const sessionName = `larkin-tmux-${path.basename(root).replace(/[^a-zA-Z0-9-]/g, "").slice(-16)}`;
  const config = {
    tmuxSessionScope: "global",
    globalTmuxSessionName: sessionName,
    tmuxWindowScope: "pi-session",
    outputDir,
    autoCloseWindowsOnCompletion: false,
    defaultTimeoutSeconds: 5,
    defaultTimeoutAction: "background",
    maxTimeoutSeconds: 60,
  };
  fs.writeFileSync(path.join(extConfigDir, "tmux-bash.jsonc"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { root, workDir, extConfigDir, outputDir, packageDir, sessionName, config, gitFixture };
}

export function childEnvForIsolatedPi(workspace, env = process.env) {
  return {
    ...env,
    NO_COLOR: "1",
    PI_EXTENSION_CONFIG_DIR: workspace.extConfigDir,
    PI_OFFLINE: env.PI_OFFLINE || "",
  };
}

export function standingPromptFile(workspace, content) {
  const file = path.join(workspace.root, "standing-prompt.md");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

export function listIsolatedTmuxWindows(sessionName) {
  const listed = spawnSync("tmux", [
    "list-windows", "-t", sessionName, "-F", "#{window_id}\t#{window_name}\t#{pane_pid}\t#{pane_current_command}",
  ], { encoding: "utf8" });
  if (listed.status !== 0) return [];
  return listed.stdout.split("\n").filter(Boolean).map((line) => {
    const [id, name, panePid, command] = line.split("\t");
    return { id, name, panePid, command };
  });
}

export function discoverIsolatedTmuxWindows(workspace) {
  const fromSession = listIsolatedTmuxWindows(workspace.sessionName);
  if (fromSession.length > 0) return fromSession;
  if (!fs.existsSync(workspace.outputDir)) return [];
  const names = fs.readdirSync(workspace.outputDir);
  const ids = new Set();
  for (const name of names) {
    const match = /(@\d+)/.exec(name);
    if (match) ids.add(match[1]);
  }
  return [...ids].map((id) => ({ id, name: "", panePid: "", command: "output-dir" }));
}

export function killIsolatedTmuxSession(sessionName) {
  if (!sessionName || !sessionName.startsWith("larkin-tmux-")) return;
  spawnSync("tmux", ["kill-session", "-t", sessionName], { encoding: "utf8" });
}

export function waitFor(trace, predicate, timeoutMs = 240_000, intervalMs = 250) {
  const existing = trace.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = trace.find(predicate);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("eval wait timeout"));
      }
    }, intervalMs);
  });
}

export function spawnPiRpc({ args, cwd, env }) {
  const command = env.LARKIN_PI_COMMAND || "pi";
  return spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
}

export function repoRoot() {
  return ROOT;
}
