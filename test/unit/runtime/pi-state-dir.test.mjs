import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { effectivePiStateDir } from "../../../src/runtime/pi-state-dir.ts";

test("effectivePiStateDir matches the Pi adapter implicit root", () => {
  assert.equal(effectivePiStateDir({ workspaceDir: "/ws", stateDir: "/explicit" }), "/explicit");
  assert.equal(effectivePiStateDir({ workspaceDir: "/ws" }), path.join("/ws", ".larkin"));
});
