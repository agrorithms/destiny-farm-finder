#!/usr/bin/env bash
# SessionStart: record which PIDs already hold the dev port, and tell Claude.
#
# Deliberately does NOT kill anything. The snapshot is what lets the Stop hook
# distinguish "the user's server, already running" from "debris this session
# created and failed to clean up".
#
# Fires on ALL five SessionStart matchers (startup, resume, clear, compact,
# fork) — deliberately unmatched in settings.json. Narrowing it to `startup`
# looks tempting but breaks the mechanism: `clear` and `resume` are also
# SessionEnd reasons, so /clear deletes the state and then re-enters
# SessionStart. A hook that ignored `clear` would leave Stop with no baseline,
# and every port holder would be reported as session debris — exactly the
# failure R4.2 exists to prevent.
#
# Instead the write is made non-destructive: baseline and warned-set are
# established only when absent. A compact or clear mid-session therefore keeps
# both the true baseline and the already-warned PIDs, so the per-turn re-nag
# R4.3 forbids stays fixed.
#
# Known gap: `fork` assigns a fresh session_id, so a forked session starts with
# no baseline of its own. Accepted; recorded in the spec's non-goals.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_session_state

# Drop state left behind by sessions that never reached SessionEnd.
sweep_stale_state

if [ ! -f "$SNAPSHOT_FILE" ]; then
  dev_port_pids > "$SNAPSHOT_FILE"
  : > "$WARNED_FILE"
fi

PIDS="$(cat "$SNAPSHOT_FILE" 2>/dev/null)"
[ -z "$PIDS" ] && exit 0

OWNERS="$(describe_pids "$PIDS")"
jq -nc --arg ctx "A dev server was ALREADY running on port ${DEV_PORT} before this session started: ${OWNERS}. It is the user's, not yours. Reuse it instead of starting another, and never kill it without asking." \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
