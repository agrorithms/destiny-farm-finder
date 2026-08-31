#!/usr/bin/env bash
# PreToolUse(Bash): refuse to start a second `next build` concurrently.
#
# Why this exists: concurrent builds collided on the Next.js build lock during
# the OG-image work, wasting a full build cycle each time.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CMD="$(hook_field '.tool_input.command')"

# `npm run build` chains next-build; match both it and a direct next build.
# invokes() rather than a substring grep — see the note in lib.sh.
invokes "$CMD" 'npm run build|npm run next-build|next build' || exit 0

PIDS="$(next_build_pids)"
[ -z "$PIDS" ] && exit 0

deny "A 'next build' is already running (PID ${PIDS}) — a second one will collide on the Next.js build lock.
Wait for it to finish, or ask the user whether to stop it. Do not start a parallel build."
