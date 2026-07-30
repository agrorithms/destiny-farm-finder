#!/usr/bin/env bash
# SessionEnd: delete this session's state files.
#
# Fires on /clear, resume, logout, prompt_input_exit, and other terminations.
# It does NOT reliably fire on a hard kill, and whether a Ctrl+C exit reaches it
# is unconfirmed — which is why sweep_stale_state() at SessionStart is the real
# guarantee against pileup, not this.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

rm -f "$SNAPSHOT_FILE" "$WARNED_FILE" 2>/dev/null
exit 0
