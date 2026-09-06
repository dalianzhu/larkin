import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const REMOVED = [
  "src/runtime/pi-bash-timeout-extension.ts",
  "src/runtime/pi-bash-timeout-injection.ts",
  "src/runtime/pi-subagent-injection.ts",
  "src/runtime/pi-supervised-command.ts",
  "src/runtime/pi-supervised-command-extension.ts",
  "src/runtime/pi-subagent-record-watchdog.ts",
  "src/runtime/pi-subagent-record-watchdog-injection.ts",
  "src/runtime/pi-extension-api.ts",
];
const REMOVED_BUNDLES = [
  "pi-bash-timeout.bundle.js",
  "pi-subagents.bundle.js",
  "pi-supervised-command.bundle.js",
  "pi-subagent-record-watchdog.bundle.js",
];

test("Larkin no longer ships injected Pi extension sources or bundles", () => {
  for (const relative of REMOVED) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), false, relative);
  }
  for (const name of REMOVED_BUNDLES) {
    assert.equal(fs.existsSync(path.join(ROOT, "dist/runtime", name)), false, name);
  }
  const adapter = fs.readFileSync(path.join(ROOT, "src/runtime/runtime-adapters.ts"), "utf8");
  const build = fs.readFileSync(path.join(ROOT, "scripts/build.mjs"), "utf8");
  const standalone = fs.readFileSync(path.join(ROOT, "scripts/release/standalone-entry.ts"), "utf8");
  assert.doesNotMatch(adapter, /resolvePiSubagentExtensionArg|resolvePiBashTimeoutExtensionArg|resolvePiSubagentRecordWatchdogExtensionArg/);
  assert.doesNotMatch(build, /bundlePiSubagentExtension|bundlePiBashTimeoutExtension|pi-subagents\.bundle/);
  assert.doesNotMatch(standalone, /pi-subagents\.bundle|pi-bash-timeout\.bundle|@tintinweb\/pi-subagents/);
});
