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
# Overridable so the test suite can point at a throwaway dir — it deletes its
# state dir repeatedly, which against the live path would wipe the warned-PID
# file of any session currently running.
HOOK_STATE_DIR="${HOOK_STATE_DIR:-/tmp/claude-hooks-$(id -u)}"

# Session state is set up on demand, NOT at source time. The three PreToolUse
# guards never touch it, and they run in parallel on every single Bash call —
# resolving the session id there would spend a second `jq` per guard per command
# to compute a filename nothing reads.
#
# Only ONE file remains. The session-start baseline snapshot is gone: orphan
# detection now compares process ages (see session_age / holders_younger_than), so
# there is nothing to record when a session begins.
init_session_state() {
  mkdir -p "$HOOK_STATE_DIR" 2>/dev/null
  chmod 700 "$HOOK_STATE_DIR" 2>/dev/null

  # Session id, sanitised for use in a filename. Falls back to a fixed name so a
  # missing session_id degrades to shared-file behaviour rather than producing
  # "warned-.txt".
  SESSION_KEY="$(hook_field '.session_id' | tr -cd 'A-Za-z0-9_-' | cut -c1-64)"
  [ -z "$SESSION_KEY" ] && SESSION_KEY="nosession"

  # PIDs already reported to the user, so Stop warns once instead of every turn.
  WARNED_FILE="$HOOK_STATE_DIR/warned-$SESSION_KEY.txt"
}

# Delete state from sessions that are long gone.
#
# This is now the ONLY cleanup — the SessionEnd hook is gone, and it was never a
# guarantee anyway (it does not fire on a hard kill, and whether a Ctrl+C exit
# reaches it was never established). Running from Stop means it sweeps every
# turn rather than only when a new session starts in this repo.
sweep_stale_state() {
  find "$HOOK_STATE_DIR" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null || true
}

# Strip leading and trailing whitespace. PID sets travel as space-joined
# strings; this was open-coded as the same sed in three places.
trim() {
  sed 's/^[[:space:]]*//; s/[[:space:]]*$//' <<<"$1"
}

# Age in seconds of the Claude Code session this hook is running under, or empty
# if it cannot be determined.
#
# Walks UP the process tree looking for `claude`. Do not shortcut this to $PPID:
# a hook's parent is a per-invocation `/bin/sh -c` wrapper whose own age is
# always 0. Reading that instead would classify every port holder as older than
# the session, so nothing would ever be reported and the check would be silently
# dead. Verified by instrumenting a live hook:
#
#   hook ppid=10987
#   10987  1464  0     /bin/sh -c "$CLAUDE_PROJECT_DIR/.claude/hooks/..."
#    1464    10  2778  claude
#
# The walk rather than a fixed depth of two, because that wrapper is a harness
# implementation detail that may change.
#
# Empty return is meaningful: it means FAIL OPEN. Callers must report nothing.
session_age() {
  local p ppid comm
  p="$PPID"
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
    read -r ppid comm <<<"$(ps -o ppid=,comm= -p "$p" 2>/dev/null)"
    [ -z "$ppid" ] && return 0          # process vanished mid-walk
    if [ "$comm" = "claude" ]; then
      ps -o etimes= -p "$p" 2>/dev/null | tr -d ' '
      return 0
    fi
    p="$ppid"
  done
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
  trim "$(tr '\n' ' ' <<<"$pids")"
}

# PIDs of a genuine `next build`. The decisive cmdline is
#   node <repo>/node_modules/.bin/next build
# The [n] bracket keeps the pattern from matching this script's own cmdline.
next_build_pids() {
  trim "$(pgrep -f '[n]ode_modules/.bin/next build' 2>/dev/null | tr '\n' ' ')"
}

# Of the PIDs in $2..., echo those younger than session age $1 — i.e. the ones
# this session started. Replaces the session-start baseline snapshot.
#
# Why age rather than a recorded baseline: the snapshot had to survive /clear,
# resume, compact and fork, and it did not — SessionEnd fires on `clear` and
# `resume`, so re-entering deleted the baseline and every port holder then read
# as debris. Process age needs no state, so there is nothing to lose.
#
# Kept pure (age passed in, not looked up) so the fail-open path can be tested.
# It cannot be staged end-to-end: everything a test spawns is a descendant of
# the real `claude`, so "no ancestor" is unreachable from inside a session.
#
# Every non-numeric or empty age FAILS OPEN and reports nothing. Reporting on a
# bad age would hand the user a kill command aimed at their own server.
#
# Known and accepted: a server the USER starts mid-session, in another terminal,
# is younger than the session and will be reported. The snapshot design had the
# identical hole — it was not in the baseline either — so this is not a
# regression. The message is worded accordingly.
holders_younger_than() {
  local age="$1"; shift
  local pid hage out=""
  [ -z "$age" ] && return 0
  case "$age" in ''|*[!0-9]*) return 0 ;; esac
  for pid in $*; do
    hage="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "$hage" in ''|*[!0-9]*) continue ;; esac
    [ "$hage" -lt "$age" ] && out="$out $pid"
  done
  trim "$out"
}

# One-line human description of a PID list, for the messages the user reads.
describe_pids() {
  ps -o pid=,args= -p ${1} 2>/dev/null | cut -c1-100 | paste -sd'; ' -
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
#
# Defined before strip_heredocs because that function calls it.
blank_quoted() {
  sed "s/\"[^\"]*\"/\"\"/g; s/'[^']*'/''/g" <<<"$1"
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
# OPENER DETECTION IS QUOTE-AWARE, and must stay that way (bug S-1). A `<<`
# inside a quoted string — `echo "a << B"` — is not a heredoc opener, but when it
# was read as one it adopted a terminator that never arrived and discarded every
# following line. That silently turned all three guards into no-ops: the command
# they were meant to gate sat on a later line and was simply never seen.
#
# Detection therefore runs on a PROBE copy of the line, never on the line itself:
#
#   1. Rewrite `<<'EOF'` / `<<"EOF"` to bare `<<EOF`. This must happen FIRST.
#      Blanking quotes without it eats the terminator, the opener stops being
#      recognised, and real heredoc bodies leak back into the match — and
#      `<<'EOF'` is the most common form in this repo.
#   2. Blank remaining quoted spans, so a `<<` inside a string disappears.
#   3. Match the opener on the result; keep the ORIGINAL line in the output.
#
# Doing it this way makes the function independent of whether the caller has
# already blanked quotes — which matters because invokes_strict() deliberately
# does not.
#
# The `(^|[^<])` guard is separate and also load-bearing: without it,
# `grep x <<<"y"` matches starting at the SECOND `<` of the here-string, adopts
# `y` as a terminator, and swallows the rest. A here-string is not a heredoc.
strip_heredocs() {
  local line probe term="" out=""
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$term" ]; then
      # Inside a body: drop every line until the terminator closes it.
      [[ "$line" =~ ^[[:space:]]*${term}[[:space:]]*$ ]] && term=""
      continue
    fi
    out+="$line"$'\n'
    probe="$(sed -E "s/<<-?[[:space:]]*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]/<<\1/g" <<<"$line")"
    probe="$(blank_quoted "$probe")"
    if [[ "$probe" =~ (^|[^<])\<\<-?[[:space:]]*([A-Za-z_][A-Za-z0-9_]*) ]]; then
      term="${BASH_REMATCH[2]}"
    fi
  done <<<"$1"
  printf '%s' "$out"
}

# Shell keywords and wrapper commands that may sit between the start of a
# command position and the real command. Shared by invokes() and
# invokes_strict() so the two cannot drift apart.
#
# `timeout` takes an argument, hence the trailing duration. `stdbuf`, `command`
# and `exec` have no incident history behind them, unlike nohup/env/timeout —
# they are kept because removing them opens a gap for no measurable gain.
HOOK_WRAPPERS='([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|then|do|else|elif|nohup|exec|command|stdbuf|env|timeout[[:space:]]+[0-9]+[smhd]?)'

# Commands gated by R7 (guard-destructive.sh). Lives here, not in the hook, so
# the tests assert against the same pattern production uses — they had already
# drifted to an older, narrower copy once.
#
# `git clean` is deliberately NOT here: it needs the per-clause dry-run
# exemption in invokes_real_git_clean().
HOOK_DESTRUCTIVE='npm uninstall|npm rm|npm remove|npm prune|git reset --hard|git checkout --|git restore|rm -[a-zA-Z]*[rR][a-zA-Z]*'

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
  grep -qE "^[[:space:]]*(${HOOK_WRAPPERS}[[:space:]]+)*($2)([[:space:]]|$)" <<<"$cmd"
}

# invokes() for the destructive guard, which is deliberately stricter.
#
# The spec's matching policy — "a false positive costs more than a bypass" — was
# derived from R1/R2, where the decision is DENY and a false positive blocks real
# work at exactly the wrong moment. For R7 the asymmetry INVERTS: the decision is
# ASK, so a false positive costs one keystroke, while a miss costs node_modules,
# data/ or .env. Two differences follow:
#
#   - Quoted spans are NOT blanked, so `sh -c "rm -rf x"` stays visible. This is
#     why strip_heredocs() had to become quote-aware on its own (bug S-1) rather
#     than relying on blank_quoted running first.
#   - `sh -c` / `bash -c` are accepted as wrappers, including the opening quote.
#
# The §A3 bypass stays pinned for R1/R2, and not merely by preference: those
# still blank quotes, so `sh -c "npm run dev"` becomes `sh -c ""` before matching
# and the wrapper would have nothing to match against. Closing it there would
# mean R1/R2 dropping quote-blanking too, and inheriting its false positives on
# a DENY.
#
# Known accepted cost: a separator inside a quoted string opens a command
# position, so `git commit -m "stop; rm -rf x"` asks. Pinned by a test.
invokes_strict() {
  local cmd
  cmd="$(strip_heredocs "$1")"
  cmd="$(tr ';&|()' '\n' <<<"$cmd")"
  grep -qE "^[[:space:]]*((sh|bash|zsh)[[:space:]]+-c[[:space:]]+['\"]?)?(${HOOK_WRAPPERS}[[:space:]]+)*($2)([[:space:]]|$)" <<<"$cmd"
}

# True if $1 is an `rm` that names a path git is ignoring.
#
# Motivation: `rm data/raid-tracker.db` needs no -r flag — it is a file — so the
# recursive-flag rule never sees it. That is 9.0G of database whose only backups
# are manual snapshots. Same for `rm .env`, which is not in git at all.
#
# Resolved dynamically rather than from a hardcoded list of precious paths. Of
# the 20 gitignored entries in this repo only ~5 are regenerable (.next/,
# node_modules/, dist/, next-env.d.ts, tsconfig.tsbuildinfo); the rest — .env,
# certificates/, .claude/plans/, docs/handoffs/, docs/tickets/, seeds.txt,
# scripts/cleanup/ — cannot be recovered by any command. A hand-maintained list
# was already missing five of those when first drafted, and would drift again
# every time .gitignore changes. `git check-ignore` costs ~2ms and only runs once
# the destructive matcher has already fired.
#
# No regenerable-path exemption is needed: the noisy cases (`rm -rf .next`,
# `rm -rf node_modules`) are already gated by the flag rule, so this only adds
# coverage for non-recursive rm, where the regenerable paths are things nobody
# types.
rm_touches_ignored() {
  local tok repo
  invokes_strict "$1" 'rm' || return 1
  repo="${CLAUDE_PROJECT_DIR:-$PWD}"

  # `local -` scopes shell options to this function, so the caller's globbing
  # setting is restored on return however we leave.
  local -
  # Globbing off: `rm -rf /tmp/foo-*` must not expand against the real
  # filesystem while we are only reading tokens.
  set -f
  # Quotes are stripped so `rm "data/raid-tracker.db"` is seen; separators
  # become spaces so a chained command's arguments are scanned too.
  for tok in $(tr ';&|()' '  ' <<<"$1" | tr -d "\"'"); do
    case "$tok" in
      -*|rm|sh|bash|zsh) continue ;;
    esac
    git -C "$repo" check-ignore -q -- "$tok" 2>/dev/null && return 0
  done
  return 1
}

# True if $1 contains a `git clean` that is NOT a dry run.
#
# Scoped per CLAUSE, which the first version was not. It grepped the whole
# command for any `-`-flag containing an `n`, so an unrelated `head -n 20`,
# `sort -n` or `grep -n` anywhere in the command exempted a real destructive
# clean — and because the caller then exited, it suppressed the rm rules for
# that call too. Both review axes caught it independently:
#
#   git clean -fdx                     -> ask
#   git clean -fdx && head -n 20 file  -> ALLOWED    (wrong)
#   grep -n foo x && git clean -fdx    -> ALLOWED    (wrong)
#
# A clean is exempt only when the clause that invokes it carries the dry-run
# flag itself. Anything else asks.
invokes_real_git_clean() {
  local clause
  while IFS= read -r clause; do
    invokes_strict "$clause" 'git clean' || continue
    # -n, -nd, --dry-run: this clause only looks, so let it through.
    grep -qE '(^|[[:space:]])(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)([[:space:]]|$)' <<<"$clause" && continue
    return 0
  done < <(tr ';&|' '\n' <<<"$(strip_heredocs "$1")")
  return 1
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
