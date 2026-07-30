# Shared helpers for the Claude Code hooks in this directory.
# Sourced, never executed directly.

DEV_PORT="${DEV_PORT:-3000}"

# Hook payloads arrive as JSON on stdin, and stdin can only be drained once.
# Read it here so every hook can query as many fields as it likes.
# The tty check keeps a manual `./guard-build.sh` from hanging on `cat`.
# The tty check keeps an interactive `./guard-build.sh` from blocking on cat;
# the timeout covers the closed-stdin case, where cat blocks anyway. A hook that
# hangs stalls the tool call it is gating until the harness timeout fires.
if [ -t 0 ]; then
  HOOK_INPUT='{}'
else
  HOOK_INPUT="$(timeout 2 cat)"
fi
[ -z "$HOOK_INPUT" ] && HOOK_INPUT='{}'

# hook_field '.tool_input.command' -> value, or empty string.
hook_field() {
  jq -r "$1 // \"\"" <<<"$HOOK_INPUT" 2>/dev/null
}

# Per-session state lives in one directory so it can be swept in a single find.
HOOK_STATE_DIR="/tmp/claude-hooks-$(id -u)"
mkdir -p "$HOOK_STATE_DIR" 2>/dev/null
chmod 700 "$HOOK_STATE_DIR" 2>/dev/null

# Session id, sanitised for use in a filename. Falls back to a fixed name so a
# missing session_id degrades to the old shared-file behaviour rather than
# producing "devserver-.txt".
SESSION_KEY="$(hook_field '.session_id' | tr -cd 'A-Za-z0-9_-' | cut -c1-64)"
[ -z "$SESSION_KEY" ] && SESSION_KEY="nosession"

# Port holders at session start — the baseline the Stop hook diffs against.
SNAPSHOT_FILE="$HOOK_STATE_DIR/devserver-$SESSION_KEY.txt"
# PIDs already reported to the user, so Stop warns once instead of every turn.
WARNED_FILE="$HOOK_STATE_DIR/warned-$SESSION_KEY.txt"

# Delete state from sessions that ended without firing SessionEnd (crash, or a
# SIGINT exit if those skip cleanup — unconfirmed). Cleanup must never depend
# on a graceful exit.
sweep_stale_state() {
  find "$HOOK_STATE_DIR" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null || true
}

# PIDs currently listening on the dev port. Empty if the port is free.
#
# Port-based, not pgrep-based: `pgrep -f "next dev"` matches the hook's own
# shell wrapper (the whole command string lands in its cmdline), so it
# false-positives on every single invocation.
#
# NOT lsof: under WSL2 `lsof -ti:3000` exits 1 even when a server is plainly
# listening — lsof cannot read this kernel's network sockets. Verified by hand;
# using it here would make every port hook a silent no-op. `ss` is the primary,
# `fuser` the fallback.
dev_port_pids() {
  local pids
  pids="$(ss -ltnpH "sport = :${DEV_PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)"
  [ -z "$pids" ] && pids="$(fuser "${DEV_PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u)"
  echo "$pids" | tr '\n' ' ' | sed 's/^ *//; s/ *$//'
}

# PIDs of a genuine `next build`. The decisive cmdline is
#   node <repo>/node_modules/.bin/next build
# The [n] bracket keeps the pattern from matching this script's own cmdline.
next_build_pids() {
  pgrep -f '[n]ode_modules/.bin/next build' 2>/dev/null | tr '\n' ' ' | sed 's/ $//'
}

# True if $1 actually INVOKES one of the alternatives in ERE $2, rather than
# merely mentioning it. A plain substring grep denies `echo "npm run dev"`,
# `grep -r "npm run dev" .`, or editing this very file — verified the hard way,
# by having this hook block its own test harness.
#
# A real invocation sits at a command position: start of a line, or after a
# separator (; & | && ||), optionally preceded by VAR=value assignments so
# `PORT=3001 npm run dev` still matches. A quoted mention is preceded by a
# quote character, which is not a separator, so it no longer matches.
invokes() {
  grep -qE "(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*($2)([[:space:]]|\$)" <<<"$1"
}

# Emit a PreToolUse denial. $1 = reason shown to Claude and to you.
deny() {
  jq -nc --arg reason "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}
