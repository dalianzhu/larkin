# Changelog

## 0.5.5

Pi no longer injects Larkin-managed `pi-subagents`, the 60-second bash timeout guard, or the supervised-command bundle. User-installed Pi packages load through normal Pi discovery; Larkin does not scan package settings or redistribute `@richardgill/pi-tmux-bash`. If published 0.0.12 is installed, it registers bash and then fails in a non-git directory; Larkin does not claim a native-bash fallback. Unowned Pi `turn_start` / `agent_settled` events occupy Runtime busy state and do not schedule a second host prompt. Historical `pi-subagent-ledger.json` files on disk are left inert and are no longer read.

## 0.5.4

Inbox Audit is now optional and off by default. The Dashboard and CLI support global and per-Agent switches and inspection gaps. Saving a gap updates scheduling without replacing Runtime sessions; editing a gap alone does not enable auditing. Only originally wake-eligible human group/topic work is audited.

Audit reads no longer mark work complete. Agents explicitly confirm a receipt after checking; receipts are scoped to an observation generation, and durable canonical sequence ordering protects newer work from stale completion or deferred registration. Contended registrations are retried durably. Unproven legacy audit-index rows are ignored while ordinary Inbox and conversation history remain intact.

## 0.5.3

External Pi initialization now runs with bounded concurrency and recovers from isolated startup-probe timeouts through the existing retry policy. Shutdown waits for pending initialization and closes late sessions. Generic Runtime and delivery failures show unavailable instead of incompatible, while explicit prerequisite failures and useful provider diagnostics are preserved. Recovery workflow tests wait for delivery consumption and Inbox watermarks to converge and isolate temporary state.

## 0.5.2

External pi now runs with the user's own Pi home; compaction settings move to the Agent workspace's `.pi/settings.json`; 0.5.0/0.5.1 started external pi with an empty agent dir and saw no logins. Stock pi 0.84.x does not emit `get_state.compactionCapabilities` (that handshake only existed for the bundled build); Larkin accepts the absence and keeps native compaction via the workspace settings file, while a present handshake must still match exactly.

## 0.5.1

External pi is accepted at 0.84.2 or newer instead of exactly 0.84.2; 0.5.0 refused newer pi and left every migrated Agent not ready.

## 0.5.0

BREAKING — builtin Pi is removed. Larkin supports only externally installed `pi`, `codex`, and `claude`. If the selected runtime is not installed, setup, runtime switch, and readiness fail with an explicit missing-install message.

Existing builtin-pi Agents migrate to external `pi` on first config load and keep their stored model. Larkin-owned Pi credential directories (`providers/pi/<agentId>/`) are deleted during that migration. Users must install and log in to `pi`, `codex`, or `claude` themselves.

The `pi-auth` and `pi-distribution` commands are removed. Invoking them returns the standard unknown-command error. Dashboard Provider Credentials and `/api/pi-auth/*` are gone.

`larkin setup --model <id>` again stores a catalog-validated model for the chosen runtime.
