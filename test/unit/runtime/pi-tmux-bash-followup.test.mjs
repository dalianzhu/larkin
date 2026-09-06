import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  buildTmuxBashFollowUpMessage,
  extractTmuxBashFollowUp,
} from "../../../src/runtime/pi-tmux-bash-followup.ts";

test("extractTmuxBashFollowUp reads completion custom messages and ignores lookalikes", () => {
  const completion = buildTmuxBashFollowUpMessage("tmux-bash-completion", "Command finished (exit 0)");
  assert.deepEqual(extractTmuxBashFollowUp([completion]), {
    kind: "tmux-bash-completion",
    key: "tmux-bash-completion:Command finished (exit 0)",
  });
  assert.equal(extractTmuxBashFollowUp([{
    role: "assistant",
    content: "ordinary assistant text mentioning tmux-bash-completion",
  }]), null);
  assert.equal(extractTmuxBashFollowUp([{
    role: "assistant",
    content: [{ type: "custom", customType: "subagent-notification", content: "other" }],
  }]), null);
});

test("extractTmuxBashFollowUp prefers completion over poll in the same payload", () => {
  const poll = buildTmuxBashFollowUpMessage("tmux-bash-poll", "still running");
  const completion = buildTmuxBashFollowUpMessage("tmux-bash-completion", "done");
  assert.deepEqual(extractTmuxBashFollowUp([poll, completion]), {
    kind: "tmux-bash-completion",
    key: "tmux-bash-completion:done",
  });
});
