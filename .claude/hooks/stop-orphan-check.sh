#!/usr/bin/env bash
# Stop: warn if this session leaves behind a dev server it started. Surfaces the
# orphan while you can still see it, instead of on your next `npm run dev` three
# days later.
#
# "This session started it" is decided by AGE, not by a recorded baseline: a
# port holder younger than the claude process is one this session created. The
# previous design snapshotted the port at SessionStart and diffed against it,
# which broke on /clear and resume (both are SessionEnd reasons, so re-entry
# deleted the baseline and every holder then read as debris) and had no answer
# for fork at all. Comparing ages needs no state, so there is nothing to lose,
# nothing to clean up, and no SessionStart/SessionEnd hooks.
#
# Stop fires once per TURN, not once per session, so a PID is reported exactly
# once and then recorded in WARNED_FILE (R4.3).
#
# Kills nothing, ever. The kill command is printed for the user to run.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_session_state

# The only cleanup left now that SessionEnd is gone. Runs every turn.
sweep_stale_state

# Keep this session's state young so the 7-day sweep only reaches dead sessions.
[ -f "$WARNED_FILE" ] && touch "$WARNED_FILE" 2>/dev/null

# FAIL OPEN (R4.4). No usable session age means silence. Reporting on a bad age
# would hand the user a ready-to-run kill aimed at what may be their own server
# — the one outcome the no-kill design exists to prevent. A missed report only
# costs a stale server the user would notice anyway.
AGE="$(session_age)"
[ -z "$AGE" ] && exit 0

NOW="$(dev_port_pids)"
[ -z "$NOW" ] && exit 0

# Younger than the session => this session started it.
NEW="$(holders_younger_than "$AGE" "$NOW")"
[ -z "$NEW" ] && exit 0

WARNED="$(cat "$WARNED_FILE" 2>/dev/null || echo "")"
REPORT=""
for pid in $NEW; do
  grep -qw "$pid" <<<"$WARNED" && continue
  REPORT="$REPORT $pid"
done
REPORT="$(trim "$REPORT")"
[ -z "$REPORT" ] && exit 0

# Record before reporting, so a failure downstream can't cause a repeat nag.
for pid in $REPORT; do echo "$pid" >> "$WARNED_FILE"; done

# Wording note: this says "after this session began", not "you started it".
# A server the user starts mid-session in another terminal is also younger than
# the session and will land here. Rare, and cheaper than the alternative of
# staying quiet about real debris.
OWNERS="$(describe_pids "$REPORT")"
jq -nc --arg msg "Dev server on port ${DEV_PORT} started after this session began, and is still running: ${OWNERS}  ->  kill ${REPORT}  (reported once; will not repeat for these PIDs)" \
  '{systemMessage:$msg}'
