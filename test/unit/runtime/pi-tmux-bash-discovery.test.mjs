import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE = path.join(ROOT, "test/fixtures/pi-tmux-bash-0.0.12.json");

test("Larkin does not ship a Pi plugin discovery or source-scanning module", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "src/runtime/pi-tmux-bash-discovery.ts")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "src/runtime/pi-autonomous-followup.ts")), false);
  const adapter = fs.readFileSync(path.join(ROOT, "src/runtime/runtime-adapters.ts"), "utf8");
  assert.doesNotMatch(adapter, /discoverUserPiTmuxBash|inspectTmuxBashGitRootRequirement|extractAutonomousPiFollowUp/);
  assert.doesNotMatch(adapter, /git init/);
});

test("optional install fixture records published 0.0.12 without redistributing the plugin", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.equal(fixture.name, "@richardgill/pi-tmux-bash");
  assert.equal(fixture.version, "0.0.12");
  assert.equal(fixture.requiresGitRepository, true);
  assert.equal(fixture.redistributed, false);
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /Pi loads it itself/);
  assert.match(readme, /does not run `git init`/);
  assert.match(readme, /ordinary Larkin directories stay on native bash/);
});

test("package.json wires the opt-in tmux-bash eval and drops the retired scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["test:eval:pi-tmux-bash"],
    "bun run build && LARKIN_RUN_PI_TMUX_BASH_EVAL=1 bun test --max-concurrency 1 test/live/pi-tmux-bash-live.test.mjs",
  );
  assert.equal(pkg.scripts["test:eval:pi-bash-timeout"], undefined);
  assert.equal(pkg.scripts["test:eval:pi-subagents-background"], undefined);
  assert.equal(pkg.dependencies["@richardgill/pi-tmux-bash"], undefined);
});
