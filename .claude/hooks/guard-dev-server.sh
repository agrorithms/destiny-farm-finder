#!/usr/bin/env bash
# PreToolUse(Bash): refuse to start a second dev server on the dev port.
#
# Why this exists: a previous session killed only the `npm` wrapper when
# shutting down, leaving an orphaned `next dev` squatting on port 3000, which
# then blocked the user's own `npm run dev`. Documentation can't prevent that;
# this can. Deny is the right call over auto-kill: the process holding 3000 is
# just as likely to be the user's deliberately-started server as it is debris.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CMD="$(hook_field '.tool_input.command')"

# Only interested in commands that actually START a dev server, not ones that
# merely mention it (echo, grep, a heredoc writing docs).
invokes "$CMD" 'npm run dev|next dev' || exit 0

PIDS="$(dev_port_pids)"
[ -z "$PIDS" ] && exit 0

OWNERS="$(describe_pids "$PIDS")"
deny "Port ${DEV_PORT} is already in use — do not start a second dev server.
Holding process(es): ${OWNERS}
This may be the user's own server. Do NOT kill it unsolicited. Either reuse it (curl http://localhost:${DEV_PORT}) or ask the user first.
If it is confirmed orphaned debris, kill the real PID (not the npm wrapper): kill ${PIDS}"
