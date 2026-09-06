import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  buildAutonomousFollowUpMessage,
  buildTmuxBashFollowUpMessage,
  extractAutonomousPiFollowUp,
} from "../../../src/runtime/pi-autonomous-followup.ts";

test("extractAutonomousPiFollowUp reads generic custom followUp and ignores lookalikes", () => {
  const followUp = buildAutonomousFollowUpMessage("extension-followup", "Command finished (exit 0)");
  assert.deepEqual(extractAutonomousPiFollowUp([followUp]), {
    customType: "extension-followup",
    key: "extension-followup:Command finished (exit 0)",
  });
  assert.equal(extractAutonomousPiFollowUp([{
    role: "assistant",
    content: "ordinary assistant text mentioning tmux-bash-completion",
  }]), null);
  assert.equal(extractAutonomousPiFollowUp([{
    role: "assistant",
    content: [{ type: "custom", customType: "subagent-notification", content: "other" }],
  }]), null);
});

test("extractAutonomousPiFollowUp prefers tmux-bash-completion over other custom types", () => {
  const poll = buildTmuxBashFollowUpMessage("tmux-bash-poll", "still running");
  const completion = buildTmuxBashFollowUpMessage("tmux-bash-completion", "done");
  assert.deepEqual(extractAutonomousPiFollowUp([poll, completion]), {
    customType: "tmux-bash-completion",
    key: "tmux-bash-completion:done",
  });
});
