#!/usr/bin/env bash
# SessionStart: record which PIDs already hold the dev port, and tell Claude.
#
# Deliberately does NOT kill anything. The snapshot is what lets the Stop hook
# distinguish "the user's server, already running" from "debris this session
# created and failed to clean up".
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Drop state left behind by sessions that never reached SessionEnd.
sweep_stale_state

PIDS="$(dev_port_pids)"
echo "$PIDS" > "$SNAPSHOT_FILE"
: > "$WARNED_FILE"

[ -z "$PIDS" ] && exit 0

OWNERS="$(ps -o pid=,args= -p ${PIDS} 2>/dev/null | cut -c1-100 | paste -sd'; ' -)"
jq -nc --arg ctx "A dev server was ALREADY running on port ${DEV_PORT} before this session started: ${OWNERS}. It is the user's, not yours. Reuse it instead of starting another, and never kill it without asking." \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
