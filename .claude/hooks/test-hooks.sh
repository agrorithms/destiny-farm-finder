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
echo "=== E. SessionEnd cleanup deletes only its own session ==="
rm -rf "$D"
printf '{"session_id":"sessAAA"}' | $H/session-start-snapshot.sh > /dev/null
printf '{"session_id":"sessBBB"}' | $H/session-start-snapshot.sh > /dev/null
printf '{"session_id":"sessAAA"}' | $H/session-end-cleanup.sh
remaining=$(ls -1 "$D" | tr '\n' ' ' | sed 's/ $//')
check "only B's files remain" "devserver-sessBBB.txt warned-sessBBB.txt" "$remaining"

echo
echo "=== E2. SessionStart is non-destructive on re-entry (/clear, /compact) ==="
# The core fix. SessionStart fires on all five matchers; if it re-baselined and
# truncated the warned set each time, a compact would both adopt this session's
# own server as pre-existing AND restart the per-turn nag R4.3 forbids.
rm -rf "$D"
printf '{"session_id":"sessRE"}' | $H/session-start-snapshot.sh > /dev/null
echo "99991 99992" > "$D/devserver-sessRE.txt"
echo "77771" > "$D/warned-sessRE.txt"
printf '{"session_id":"sessRE"}' | $H/session-start-snapshot.sh > /dev/null
check "baseline preserved across re-entry" "99991 99992" "$(cat "$D/devserver-sessRE.txt")"
check "warned set preserved across re-entry" "77771" "$(cat "$D/warned-sessRE.txt")"

echo
echo "=== E3. Stop fails OPEN when there is no baseline ==="
# A missing snapshot must not read as "the port was empty at session start" —
# that would report the user's own server as debris, with a kill command.
rm -rf "$D"; mkdir -p "$D"
out="$(printf '{"session_id":"sessNONE"}' | $H/stop-orphan-check.sh)"
check "no snapshot -> silent" "" "$out"
check "no snapshot -> file not created" "no" "$(ls "$D/devserver-sessNONE.txt" >/dev/null 2>&1 && echo yes || echo no)"

echo
echo "=== E4. Stop refreshes mtime so the sweep can't split the pair ==="
rm -rf "$D"
printf '{"session_id":"sessAGE"}' | $H/session-start-snapshot.sh > /dev/null
touch -d '10 days ago' "$D/devserver-sessAGE.txt" "$D/warned-sessAGE.txt"
printf '{"session_id":"sessAGE"}' | $H/stop-orphan-check.sh > /dev/null
check "snapshot mtime refreshed" "0" "$(find "$D" -name 'devserver-sessAGE.txt' -mtime +7 | wc -l)"
check "warned mtime refreshed" "0" "$(find "$D" -name 'warned-sessAGE.txt' -mtime +7 | wc -l)"

echo
echo "=== F. sweep removes state older than 7 days ==="
rm -rf "$D"
printf '{"session_id":"sessAAA"}' | $H/session-start-snapshot.sh > /dev/null
printf '{"session_id":"sessBBB"}' | $H/session-start-snapshot.sh > /dev/null
touch -d '10 days ago' "$D/devserver-deadsession.txt"
touch -d '10 days ago' "$D/warned-deadsession.txt"
before=$(ls -1 "$D" | wc -l)
printf '{"session_id":"sessCCC"}' | $H/session-start-snapshot.sh > /dev/null
after=$(ls -1 "$D" | grep -c deadsession)
check "stale files present before sweep" "6" "$before"
check "stale files gone after sweep" "0" "$after"

echo
echo "=== G. missing session_id falls back, does not create 'devserver-.txt' ==="
printf '{}' | $H/session-start-snapshot.sh > /dev/null
ls "$D/devserver-nosession.txt" >/dev/null 2>&1 && r=yes || r=no
check "fallback file created" "yes" "$r"
ls "$D/devserver-.txt" >/dev/null 2>&1 && r=yes || r=no
check "no malformed empty-key file" "no" "$r"

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
