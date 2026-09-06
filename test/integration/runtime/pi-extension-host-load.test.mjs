import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { resolvePiProcessExtensionArgs } from "../../../dist/runtime/runtime-adapters.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("Pi process extension args inject only the Larkin tmux bundle off Windows", () => {
  const unix = resolvePiProcessExtensionArgs({
    distribution: "external",
    piCommand: "pi",
    env: {},
    platform: "linux",
  });
  assert.equal(unix[0], "-e");
  assert.match(unix[1], /pi-tmux\.bundle\.js$/);
  assert.deepEqual(resolvePiProcessExtensionArgs({
    distribution: "external",
    piCommand: "pi",
    env: {},
    platform: "win32",
  }), []);
  for (const name of [
    "pi-bash-timeout.bundle.js",
    "pi-subagents.bundle.js",
    "pi-supervised-command.bundle.js",
    "pi-subagent-record-watchdog.bundle.js",
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, "dist/runtime", name)), false, name);
  }
});
