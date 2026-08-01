#!/usr/bin/env bash
# Stop: warn if this session leaves behind a dev server that wasn't there when
# it started. Surfaces the orphan while you can still see it, instead of on
# your next `npm run dev` three days later.
#
# Stop fires once per TURN, not once per session, so a PID is reported exactly
# once and then recorded in WARNED_FILE. Without that, a dev server legitimately
# started mid-session would nag at the end of every subsequent turn.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_session_state

# No baseline => fail open, silently.
#
# Without this check, a missing or unreadable snapshot is indistinguishable from
# "the port was empty at session start", so every holder gets reported as debris
# — complete with a ready-to-run `kill`, aimed at what may well be the user's
# own server. That is the one outcome the whole no-kill design exists to
# prevent. A missed report only costs a stale server the user would notice
# anyway, so the asymmetry decides it.
[ -f "$SNAPSHOT_FILE" ] || exit 0

# Keep this session's state young. The 7-day sweep otherwise ages the two files
# independently — the snapshot is written once and never touched again, while
# WARNED_FILE is appended to on any turn that finds an orphan — so a session
# alive past a week would lose its baseline and keep its warned set. Stop runs
# every turn, so touching here makes the pair age as a unit by construction.
touch "$SNAPSHOT_FILE" "$WARNED_FILE" 2>/dev/null

NOW="$(dev_port_pids)"
[ -z "$NOW" ] && exit 0

BEFORE="$(cat "$SNAPSHOT_FILE" 2>/dev/null || echo "")"
WARNED="$(cat "$WARNED_FILE" 2>/dev/null || echo "")"

NEW=""
for pid in $NOW; do
  # Present at session start? Then it's the user's, not ours.
  grep -qw "$pid" <<<"$BEFORE" && continue
  # Already reported once? Stay quiet.
  grep -qw "$pid" <<<"$WARNED" && continue
  NEW="$NEW $pid"
done
NEW="$(echo "$NEW" | sed 's/^ *//; s/ *$//')"
[ -z "$NEW" ] && exit 0

# Record before reporting, so a failure downstream can't cause a repeat nag.
for pid in $NEW; do echo "$pid" >> "$WARNED_FILE"; done

OWNERS="$(describe_pids "$NEW")"
jq -nc --arg msg "Dev server still running on port ${DEV_PORT}, started during this session: ${OWNERS}  ->  kill ${NEW}  (reported once; will not repeat for these PIDs)" \
  '{systemMessage:$msg}'
