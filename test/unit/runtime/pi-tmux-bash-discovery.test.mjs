import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  PINNED_PI_TMUX_BASH_VERSION,
  PI_TMUX_BASH_PACKAGE,
  discoverUserPiTmuxBash,
} from "../../../src/runtime/pi-tmux-bash-discovery.ts";

function writePackage(root, name, version) {
  const parts = name.split("/");
  const dir = path.join(root, "n" + "pm", "node_modules", ...parts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`);
  return dir;
}

test("discoverUserPiTmuxBash reports absence without writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-absent-"));
  try {
    const before = fs.readdirSync(root);
    const found = discoverUserPiTmuxBash({ HOME: root, PI_CODING_AGENT_DIR: path.join(root, ".pi", "agent") });
    assert.deepEqual(found, {
      present: false,
      version: null,
      matchesPin: false,
      packageRoot: null,
      settingsConfigured: false,
      conflicts: [],
    });
    assert.deepEqual(fs.readdirSync(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discoverUserPiTmuxBash pins the extracted 0.0.12 package without installing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-pin-"));
  try {
    const agentDir = path.join(root, ".pi", "agent");
    const packageDir = writePackage(agentDir, PI_TMUX_BASH_PACKAGE, PINNED_PI_TMUX_BASH_VERSION);
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({
      packages: [`n${"pm"}:${PI_TMUX_BASH_PACKAGE}`],
    })}\n`);
    const found = discoverUserPiTmuxBash({ HOME: root, PI_CODING_AGENT_DIR: agentDir });
    assert.equal(found.present, true);
    assert.equal(found.version, "0.0.12");
    assert.equal(found.matchesPin, true);
    assert.equal(found.settingsConfigured, true);
    assert.equal(found.packageRoot, packageDir);
    assert.deepEqual(found.conflicts, []);
    assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discoverUserPiTmuxBash surfaces a conflicting bash plugin without editing settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-conflict-"));
  try {
    const agentDir = path.join(root, ".pi", "agent");
    writePackage(agentDir, PI_TMUX_BASH_PACKAGE, PINNED_PI_TMUX_BASH_VERSION);
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const settings = { packages: [`n${"pm"}:${PI_TMUX_BASH_PACKAGE}`, `n${"pm"}:pi-tmux`] };
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`);
    const found = discoverUserPiTmuxBash({ HOME: root, PI_CODING_AGENT_DIR: agentDir });
    assert.deepEqual(found.conflicts, ["pi-tmux"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")), settings);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
