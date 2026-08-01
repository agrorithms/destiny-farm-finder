# Shared helpers for the Claude Code hooks in this directory.
# Sourced, never executed directly — hence no shebang and mode 644.

DEV_PORT="${DEV_PORT:-3000}"

# Hook payloads arrive as JSON on stdin, and stdin can only be drained once.
# Read it here so every hook can query as many fields as it likes.
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

# Session state is set up on demand, NOT at source time. The three PreToolUse
# guards never touch it, and they run in parallel on every single Bash call —
# resolving the session id there would spend a second `jq` per guard per command
# to compute filenames nothing reads.
init_session_state() {
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
}

# Delete state from sessions that ended without firing SessionEnd (crash, or a
# SIGINT exit if those skip cleanup — unconfirmed). Cleanup must never depend
# on a graceful exit.
#
# Stop touches both of a live session's files every turn, so the two never age
# apart and only genuinely dead sessions reach 7 days.
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

# One-line human description of a PID list, for the messages the user reads.
describe_pids() {
  ps -o pid=,args= -p ${1} 2>/dev/null | cut -c1-100 | paste -sd'; ' -
}

# Drop the BODY of every heredoc, keeping the line that opens it.
#
# invokes() matches per line, so a heredoc whose body line begins with a matched
# command — `cat > spec.md <<EOF` documenting `npm run dev`, for instance —
# reads as a real invocation and gets denied. Spec R1.3 names doc edits
# explicitly, and a false positive costs more than a missed match: it blocks
# legitimate work, and it does so precisely when a server IS running, which is
# when you are most likely to be writing about one.
#
# The `(^|[^<])` guard is load-bearing: without it, `grep x <<<"y"` matches
# starting at the SECOND `<` of the here-string, adopts `y` as a terminator, and
# silently swallows every following line. A here-string is not a heredoc.
strip_heredocs() {
  local line term="" out=""
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$term" ]; then
      # Inside a body: drop every line until the terminator closes it.
      [[ "$line" =~ ^[[:space:]]*${term}[[:space:]]*$ ]] && term=""
      continue
    fi
    out+="$line"$'\n'
    if [[ "$line" =~ (^|[^<])\<\<-?[[:space:]]*[\"\']?([A-Za-z_][A-Za-z0-9_]*)[\"\']? ]]; then
      term="${BASH_REMATCH[2]}"
    fi
  done <<<"$1"
  printf '%s' "$out"
}

# Blank the contents of balanced quoted spans.
#
# invokes() splits on shell separators, so a separator INSIDE a quoted string
# would open a bogus command position: `git commit -m "stop it; npm run dev"`
# would read as a real invocation. Emptying quoted spans first removes the whole
# class, and costs nothing for real invocations — those are never quoted, and a
# quoted argument that merely precedes one (`cd "my dir" && npm run dev`) still
# leaves the command itself intact.
#
# Double quotes are processed first so an apostrophe inside them
# (`git commit -m "don't"`) is consumed as ordinary text rather than opening a
# span of its own.
blank_quoted() {
  sed "s/\"[^\"]*\"/\"\"/g; s/'[^']*'/''/g" <<<"$1"
}

# True if $1 actually INVOKES one of the alternatives in ERE $2, rather than
# merely mentioning it. A plain substring grep denies `echo "npm run dev"`,
# `grep -r "npm run dev" .`, or editing this very file — verified the hard way,
# by having this hook block its own test harness.
#
# This is a best-effort backstop against a forgetful Claude, not an
# evasion-proof gate: the thing it guards against is a model that ran
# `npm run dev` without checking the port, and such a model writes the plain
# form or a common wrapper. `sh -c "npm run dev"` is a KNOWN, accepted bypass —
# nested quoting is where regex stops paying, and nothing in the incident
# history involved it. There is a test pinning that gap so it is not
# "fixed" by accident.
#
# Method: strip heredoc bodies, blank quoted spans, then split on shell
# separators so that every command position starts a line. A match must then sit
# at the start of a line, after any run of VAR=value assignments and wrapper
# commands, and be followed by whitespace or end-of-line.
invokes() {
  local cmd
  cmd="$(strip_heredocs "$1")"
  cmd="$(blank_quoted "$cmd")"
  cmd="$(tr ';&|()' '\n' <<<"$cmd")"
  grep -qE '^[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|then|do|else|elif|nohup|exec|command|stdbuf|env|timeout[[:space:]]+[0-9]+[smhd]?)[[:space:]]+)*('"$2"')([[:space:]]|$)' <<<"$cmd"
}

# Emit a PreToolUse decision. $1 = "deny" | "ask", $2 = reason shown to Claude
# and to you. Exit 0 either way — the decision travels in the JSON, not the
# exit code.
decide() {
  jq -nc --arg d "$1" --arg reason "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$reason}}'
  exit 0
}

deny() { decide deny "$1"; }
ask()  { decide ask  "$1"; }
