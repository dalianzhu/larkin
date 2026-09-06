import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { resolvePiProcessExtensionArgs } from "../../../dist/runtime/runtime-adapters.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("Pi process extension args stay empty so user-installed packages load through normal discovery", () => {
  assert.deepEqual(resolvePiProcessExtensionArgs({
    distribution: "external",
    piCommand: "pi",
    env: {},
    platform: process.platform,
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
