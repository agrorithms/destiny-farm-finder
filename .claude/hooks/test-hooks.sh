#!/usr/bin/env bash
# Full behavioural test for the .claude/hooks suite. Run: bash .claude/hooks/test-hooks.sh
cd /home/louisagro/destinyCode/destiny-farm-finder || exit 1
H=.claude/hooks

# Run against a throwaway state dir, NOT the live one.
#
# The suite rm -rf's its state dir several times. Pointed at the real
# /tmp/claude-hooks-$(id -u), that deletes the warned-PID file of any session
# currently running — silently disabling its orphan check for the rest of the
# session. Exported before lib.sh is sourced so the hooks under test inherit it.
export HOOK_STATE_DIR="/tmp/claude-hooks-test-$$"
D="$HOOK_STATE_DIR"
trap 'rm -rf "$HOOK_STATE_DIR"' EXIT

source "$H/lib.sh" < /dev/null

pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi
}
m() { invokes "$1" "$2" && echo match || echo nomatch; }

echo "=== A. invokes() matcher: real invocations must MATCH ==="
DEVPAT='npm run dev|next dev'
while IFS= read -r c; do
  check "invocation: $c" "match" "$(m "$c" "$DEVPAT")"
done <<'INVOCATIONS'
npm run dev
cd app && npm run dev
PORT=3001 npm run dev
next dev
npm run dev -- --turbo
INVOCATIONS

echo
echo "=== A2. bypasses closed by the wrapper allowlist / anchor fix ==="
# Each of these slipped past the original matcher. They are forms Claude
# genuinely emits, so a silent bypass here means the guard simply never fires.
while IFS= read -r c; do
  check "closed bypass: $c" "match" "$(m "$c" "$DEVPAT")"
done <<'BYPASSES'
nohup npm run dev &
env npm run dev
(npm run dev)
x=$(npm run dev)
if true; then npm run dev; fi
for i in 1; do npm run dev; done
BYPASSES
check "closed bypass: timeout 600 npm run build" "match" \
  "$(m 'timeout 600 npm run build' 'npm run build')"

echo
echo "=== A3. sh -c stays an ACCEPTED bypass (pinned deliberately) ==="
# Nested quoting is where regex stops paying and nothing in the incident
# history involved it. This assertion exists so the gap cannot be closed by
# accident without someone re-reading the trade-off.
check "accepted bypass: sh -c" "nomatch" "$(m 'sh -c "npm run dev"' "$DEVPAT")"

echo
echo "=== B. invokes() matcher: mere mentions must NOT match ==="
while IFS= read -r c; do
  check "mention: $c" "nomatch" "$(m "$c" "$DEVPAT")"
done <<'MENTIONS'
echo "npm run dev"
grep -r "npm run dev" .
echo '{"tool_input":{"command":"npm run dev"}}' | ./hook.sh
git commit -m "document npm run dev"
echo "first; npm run dev second"
MENTIONS
# yarn/pnpm were unrequested scope creep; this repo is npm-only.
check "mention: yarn dev (out of scope)" "nomatch" "$(m 'yarn dev' "$DEVPAT")"

echo
echo "=== B2. heredoc bodies are not invocations (spec R1.3) ==="
# Writing docs about `npm run dev` used to be denied — and only while a server
# was running, i.e. exactly when you are most likely to be documenting one.
HEREDOC='cat > docs/x.md <<EOF
npm run dev
EOF'
check "heredoc body -> nomatch" "nomatch" "$(m "$HEREDOC" "$DEVPAT")"
HEREDOC_Q="cat > docs/x.md <<'EOF'
npm run dev
EOF"
check "quoted heredoc body -> nomatch" "nomatch" "$(m "$HEREDOC_Q" "$DEVPAT")"
# The opener line itself, and anything after the terminator, still count.
HEREDOC_AFTER='cat > docs/x.md <<EOF
some text
EOF
npm run dev'
check "invocation after heredoc -> match" "match" "$(m "$HEREDOC_AFTER" "$DEVPAT")"
# `<<<` is a here-string, not a heredoc — must not swallow the rest.
check "here-string is not a heredoc" "match" "$(m 'grep x <<<"y"
npm run dev' "$DEVPAT")"

# S-1 regression. A `<<` inside a QUOTED string is not a heredoc opener. When it
# was treated as one, it adopted a terminator that never arrived and discarded
# every following line — silently turning all three guards into no-ops. This is
# the highest-severity bug the suite has caught; do not delete this assertion.
check "quoted << does not open a heredoc" "match" "$(m 'echo "a << B"
npm run dev' "$DEVPAT")"
check "quoted << (destructive pattern)" "match" "$(m 'echo "a << B"
rm -rf node_modules' 'rm -[a-zA-Z]*[rR][a-zA-Z]*')"
# The quoted-terminator form must still be recognised as a REAL heredoc — the
# naive fix for the above (blanking quotes before detecting) breaks exactly this.
check "quoted-terminator heredoc still strips body" "nomatch" "$(m "cat > f <<'EOF'
npm run dev
EOF" "$DEVPAT")"
check "double-quoted-terminator heredoc still strips body" "nomatch" "$(m 'cat > f <<"EOF"
npm run dev
EOF' "$DEVPAT")"
check "<<- dash form still strips body" "nomatch" "$(m 'cat <<-EOF
npm run dev
EOF' "$DEVPAT")"

echo
echo "=== C. build matcher ==="
BLDPAT='npm run build|npm run next-build|next build'
check "invocation: npm run build" "match" "$(m 'npm run build' "$BLDPAT")"
check "mention: echo npm run build" "nomatch" "$(m 'echo "npm run build"' "$BLDPAT")"

echo
echo "=== C2. destructive matcher (R7) ==="
DESTPAT='npm uninstall|npm rm|npm remove|npm prune|rm -[a-zA-Z]*[rR][a-zA-Z]*'
while IFS= read -r c; do
  check "destructive: $c" "match" "$(m "$c" "$DESTPAT")"
done <<'DESTRUCTIVE'
npm uninstall sqlite3
cd . && npm uninstall sqlite3
npm prune
rm -rf node_modules
rm -fr build
DESTRUCTIVE
check "destructive: mention" "nomatch" "$(m 'echo "npm uninstall sqlite3"' "$DESTPAT")"
# Single-file deletes are deliberately not gated — prompting on every one
# would train the prompt to be ignored.
check "destructive: rm -f single file not gated" "nomatch" "$(m 'rm -f /tmp/x' "$DESTPAT")"

echo
echo "=== C3. invokes_strict(): R7 sees inside quotes, R1/R2 still do not ==="
# Spec's matching policy says "a false positive costs more than a bypass". That
# was derived from R1/R2, where the decision is DENY and a false positive blocks
# real work. R7 emits ASK, so the asymmetry inverts: a missed `rm -rf` destroys
# state, a false prompt costs one keystroke. invokes_strict() therefore skips
# quote-blanking and allows an `sh -c` wrapper.
ms() { invokes_strict "$1" "$2" && echo match || echo nomatch; }
DESTPAT='npm uninstall|npm rm|npm remove|npm prune|git clean|git reset --hard|git checkout --|git restore|rm -[a-zA-Z]*[rR][a-zA-Z]*'
check "strict: sh -c \"rm -rf x\"" "match" "$(ms 'sh -c "rm -rf x"' "$DESTPAT")"
check "strict: bash -c 'npm uninstall y'" "match" "$(ms "bash -c 'npm uninstall y'" "$DESTPAT")"
# ...while R1/R2 keep the pinned §A3 bypass. Adding the wrapper there would do
# nothing anyway: they blank quotes first, so sh -c "npm run dev" -> sh -c "".
check "lenient: sh -c \"npm run dev\" still bypasses" "nomatch" "$(m 'sh -c "npm run dev"' "$DEVPAT")"
# A bare mention is still not an invocation even without quote-blanking: the
# match must sit at the start of a command position, and `echo` is not a wrapper.
check "strict: echo \"rm -rf x\" is not an invocation" "nomatch" "$(ms 'echo "rm -rf x"' "$DESTPAT")"
# ACCEPTED false positive, pinned. Dropping blank_quoted means a separator inside
# a quoted string opens a command position. Costs one keystroke on an `ask`.
check "strict: accepted false positive on quoted separator" "match" \
  "$(ms 'git commit -m "stop; rm -rf x"' "$DESTPAT")"

echo
echo "=== C4. destructive git commands (R7, D7) ==="
# git clean -fdx here removes data/ (9.0G), .env, .claude/plans/, certificates/
# and docs/handoffs/ — none of them recoverable from git. It was entirely
# ungated while `rm -rf` was gated.
check "git clean -fdx" "match" "$(ms 'git clean -fdx' "$DESTPAT")"
check "git clean in a chain" "match" "$(ms 'cd . && git clean -fd' "$DESTPAT")"
check "git reset --hard" "match" "$(ms 'git reset --hard origin/main' "$DESTPAT")"
check "git checkout -- ." "match" "$(ms 'git checkout -- .' "$DESTPAT")"
check "git restore ." "match" "$(ms 'git restore .' "$DESTPAT")"
# Switching branches is not destructive and must stay silent.
check "git checkout main (not gated)" "nomatch" "$(ms 'git checkout main' "$DESTPAT")"
check "git reset (soft) not gated" "nomatch" "$(ms 'git reset HEAD~1' "$DESTPAT")"

echo
echo "=== D. guard end-to-end (port 3000 occupied) ==="
# Occupy the port ourselves so the suite is self-contained. The guards only ask
# "is anything listening on 3000", so a bare netcat listener is a faithful
# stand-in for a real dev server and starts in milliseconds rather than seconds.
STARTED_LISTENER=""
if [ -z "$(dev_port_pids)" ]; then
  nc -l 3000 >/dev/null 2>&1 &
  STARTED_LISTENER=$!
  for _ in $(seq 1 20); do [ -n "$(dev_port_pids)" ] && break; sleep 0.2; done
fi
trap 'rm -rf "$HOOK_STATE_DIR"; [ -n "$STARTED_LISTENER" ] && kill "$STARTED_LISTENER" 2>/dev/null' EXIT
echo "  (port 3000 holders: [$(dev_port_pids)])"
# A silent hook emits NO output at all (that is what "allow" looks like), so
# assert on raw output: empty = allowed, else parse the decision.
decision() { # decision <script> <command-json-string>
  local out
  out=$(printf '{"session_id":"sessAAA","tool_input":{"command":%s}}' "$2" | "$1")
  [ -z "$out" ] && { echo "allow"; return; }
  jq -r '.hookSpecificOutput.permissionDecision // "malformed"' <<<"$out"
}
check "real dev invocation while port busy -> deny" "deny" "$(decision $H/guard-dev-server.sh '"npm run dev"')"
check "quoted mention while port busy -> allow" "allow" "$(decision $H/guard-dev-server.sh '"echo \"npm run dev\""')"
check "unrelated command -> allow" "allow" "$(decision $H/guard-dev-server.sh '"git status"')"
check "build with no build running -> allow" "allow" "$(decision $H/guard-build.sh '"npm run build"')"
check "npm uninstall in && chain -> ask" "ask" "$(decision $H/guard-destructive.sh '"cd . && npm uninstall sqlite3"')"
check "quoted uninstall mention -> allow" "allow" "$(decision $H/guard-destructive.sh '"echo \"npm uninstall x\""')"

echo
echo "=== D2. R7.3 untracked-path rule (any rm naming a gitignored path) ==="
# `rm data/raid-tracker.db` needs no -r flag: it is a file. 9.0G, gitignored,
# backed up only by manual snapshots, and completely ungated by the flag rule.
# Resolved dynamically via `git check-ignore` rather than a hardcoded list — a
# hand-written list of "precious" paths was already missing docs/handoffs/,
# certificates/, scripts/cleanup/ and seeds.txt when it was first drafted.
check "rm of the live database -> ask" "ask" "$(decision $H/guard-destructive.sh '"rm data/raid-tracker.db"')"
check "rm -f of the WAL sidecar -> ask" "ask" "$(decision $H/guard-destructive.sh '"rm -f data/raid-tracker.db-wal"')"
check "rm .env -> ask" "ask" "$(decision $H/guard-destructive.sh '"rm .env"')"
# Tracked source is recoverable from git; deleting it must not prompt.
check "rm of a tracked source file -> allow" "allow" "$(decision $H/guard-destructive.sh '"rm src/lib/db/queries.ts"')"
check "rm outside the repo -> allow" "allow" "$(decision $H/guard-destructive.sh '"rm /tmp/scratch-file"')"
# A dry run destroys nothing; prompting on it is pure noise.
check "git clean -ndx (dry run) -> allow" "allow" "$(decision $H/guard-destructive.sh '"git clean -ndx"')"
check "git clean --dry-run -> allow" "allow" "$(decision $H/guard-destructive.sh '"git clean --dry-run -x"')"
check "git clean -fdx -> ask" "ask" "$(decision $H/guard-destructive.sh '"git clean -fdx"')"
# The token scan must not glob-expand; -rf already gates this, so the assertion
# is really "the scan did not crash or hang on an unmatched glob".
check "rm -rf with a glob -> ask" "ask" "$(decision $H/guard-destructive.sh '"rm -rf /tmp/nonexistent-dir-*"')"

echo
echo "=== E. classify_holders(): the orphan decision, as a pure function ==="
# Replaces the whole session-start-snapshot mechanism. A port holder is this
# session's debris if it is YOUNGER than the session itself.
#
# Split out as a pure function on purpose: session_age() does the ancestry walk
# and nothing else, so the decision logic can be tested with synthetic ages and
# no sleeps. The fail-open case in particular CANNOT be staged end-to-end —
# every process a test spawns is a descendant of the real `claude`, so "no
# ancestor" is unreachable from inside a session.
sleep 300 & YOUNG=$!            # age 0
OLD=1                           # init, older than any session
check "young holder is session debris"  "$YOUNG" "$(classify_holders 500 "$YOUNG")"
check "old holder is pre-existing"      ""       "$(classify_holders 500 "$OLD")"
check "mixed: only the young one"       "$YOUNG" "$(classify_holders 500 "$OLD $YOUNG")"
# FAIL OPEN (R4.4). An unknown session age must mean silence, never "report
# everything" — that would hand the user a kill command aimed at their own
# server, the single outcome the no-kill design exists to prevent.
check "empty age -> report nothing"     ""       "$(classify_holders "" "$OLD $YOUNG")"
check "non-numeric age -> report nothing" ""     "$(classify_holders "wat" "$YOUNG")"
check "zero age -> report nothing"      ""       "$(classify_holders 0 "$YOUNG")"
check "dead pid is skipped"             ""       "$(classify_holders 500 "999999")"
kill "$YOUNG" 2>/dev/null

echo
echo "=== E2. session_age(): the ancestry walk ==="
# Cannot assert a VALUE — it depends on when this session started. What it can
# assert is that the walk finds a claude ancestor at all. This is the one guard
# against the mistake that nearly shipped: $PPID is a per-invocation `sh -c`
# wrapper with etimes=0, NOT the claude process. A fixed-depth lookup would have
# read 0, classified every holder as pre-existing, and silently gone dead.
AGE="$(session_age)"
check "finds a claude ancestor" "yes" "$([ -n "$AGE" ] && echo yes || echo no)"
check "age is numeric"          "yes" "$(case "$AGE" in ''|*[!0-9]*) echo no;; *) echo yes;; esac)"
check "age is plausible (>0s)"  "yes" "$([ "${AGE:-0}" -gt 0 ] && echo yes || echo no)"

echo
echo "=== E3. Stop hook end-to-end: reports once, then stays quiet (R4.3) ==="
# Stop fires once per TURN, not once per session, so an orphan must be reported
# exactly once. Uses a spare port so a real dev server on 3000 is untouched.
rm -rf "$D"
export DEV_PORT=3999
nc -l 3999 >/dev/null 2>&1 &
ORPHAN=$!
for _ in $(seq 1 20); do [ -n "$(dev_port_pids)" ] && break; sleep 0.2; done
first="$(printf '{"session_id":"sessSTOP"}' | $H/stop-orphan-check.sh)"
second="$(printf '{"session_id":"sessSTOP"}' | $H/stop-orphan-check.sh)"
check "first turn reports the orphan" "yes" \
  "$(jq -e --arg p "$ORPHAN" '.systemMessage | test($p)' <<<"$first" >/dev/null 2>&1 && echo yes || echo no)"
check "report names a kill command" "yes" \
  "$(jq -re '.systemMessage' <<<"$first" 2>/dev/null | grep -q 'kill ' && echo yes || echo no)"
check "second turn stays silent (no re-nag)" "" "$second"
check "warned file records the pid" "yes" \
  "$(grep -qw "$ORPHAN" "$D/warned-sessSTOP.txt" 2>/dev/null && echo yes || echo no)"
kill "$ORPHAN" 2>/dev/null
# A holder older than the session is the user's, and must never be reported.
check "no port holder -> silent" "" "$(printf '{"session_id":"sessNONE"}' | $H/stop-orphan-check.sh)"
unset DEV_PORT

echo
echo "=== F. sweep removes warned state older than 7 days ==="
# R6.2. SessionEnd is gone, so the age-based sweep is now the ONLY cleanup, and
# it runs from Stop — every turn, rather than only when a new session starts in
# this repo. That closes review finding P-4.
rm -rf "$D"; mkdir -p "$D"
touch "$D/warned-livesession.txt"
touch -d '10 days ago' "$D/warned-deadsession.txt"
printf '{"session_id":"sessSWEEP"}' | $H/stop-orphan-check.sh > /dev/null
check "stale state swept"      "0" "$(ls -1 "$D" | grep -c deadsession)"
check "live state kept"        "1" "$(ls -1 "$D" | grep -c livesession)"

echo
echo "=== G. missing session_id falls back, does not create 'warned-.txt' ==="
# R5.2. Degrade to a fixed name rather than a malformed one.
rm -rf "$D"
export DEV_PORT=3999
nc -l 3999 >/dev/null 2>&1 &
ORPHAN2=$!
for _ in $(seq 1 20); do [ -n "$(dev_port_pids)" ] && break; sleep 0.2; done
printf '{}' | $H/stop-orphan-check.sh > /dev/null
kill "$ORPHAN2" 2>/dev/null
unset DEV_PORT
ls "$D/warned-nosession.txt" >/dev/null 2>&1 && r=yes || r=no
check "fallback file created" "yes" "$r"
ls "$D/warned-.txt" >/dev/null 2>&1 && r=yes || r=no
check "no malformed empty-key file" "no" "$r"

echo
echo "=== G2. build guard detects a running build ==="
# The detection path had NEVER been executed: every prior assertion only checked
# "allow when nothing is running". Stands in for a real `next build` with a
# process whose cmdline matches the decisive pattern. The real cmdline is
# confirmed separately by running an actual build — see the spec.
FAKEBUILD="$D/fake/node_modules/.bin"
mkdir -p "$FAKEBUILD"
printf '#!/usr/bin/env bash\nsleep 30\n' > "$FAKEBUILD/next"
chmod +x "$FAKEBUILD/next"
"$FAKEBUILD/next" build & FAKEBUILD_PID=$!
for _ in $(seq 1 20); do [ -n "$(next_build_pids)" ] && break; sleep 0.2; done
check "build running -> next_build_pids finds it" "yes" \
  "$([ -n "$(next_build_pids)" ] && echo yes || echo no)"
check "build running -> second build denied" "deny" "$(decision $H/guard-build.sh '"npm run build"')"
check "build running -> mention still allowed" "allow" "$(decision $H/guard-build.sh '"echo \"npm run build\""')"
kill "$FAKEBUILD_PID" 2>/dev/null
wait "$FAKEBUILD_PID" 2>/dev/null

echo
echo "=== H. manual run with no stdin must not hang ==="
# No /dev/tty in this environment, so the [ -t 0 ] branch cannot be exercised
# directly. Closing stdin is the adjacent risk: cat must not block forever.
timeout 5 $H/guard-build.sh <&- >/dev/null 2>&1; rc=$?
[ $rc -ne 124 ] && r=ok || r=hung
check "closed stdin: no hang" "ok" "$r"
echo "  SKIP  real-tty branch (no /dev/tty available here)"

echo
echo "================================"
echo "PASS: $pass   FAIL: $fail"
[ "$fail" -eq 0 ] || exit 1
