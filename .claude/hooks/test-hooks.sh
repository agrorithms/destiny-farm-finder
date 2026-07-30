#!/usr/bin/env bash
# Full behavioural test for the .claude/hooks suite. Run: bash .claude/hooks/test-hooks.sh
cd /home/louisagro/destinyCode/destiny-farm-finder || exit 1
H=.claude/hooks
D="/tmp/claude-hooks-$(id -u)"
source "$H/lib.sh" < /dev/null

pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi
}

echo "=== A. invokes() matcher: real invocations must MATCH ==="
DEVPAT='npm run dev|yarn dev|pnpm dev|next dev'
for c in "npm run dev" "cd app && npm run dev" "PORT=3001 npm run dev" "next dev" "npm run dev -- --turbo"; do
  invokes "$c" "$DEVPAT" && r=match || r=nomatch
  check "invocation: $c" "match" "$r"
done

echo
echo "=== B. invokes() matcher: mere mentions must NOT match ==="
while IFS= read -r c; do
  invokes "$c" "$DEVPAT" && r=match || r=nomatch
  check "mention: $c" "nomatch" "$r"
done <<'MENTIONS'
echo "npm run dev"
grep -r "npm run dev" .
echo '{"tool_input":{"command":"npm run dev"}}' | ./hook.sh
git commit -m "document npm run dev"
MENTIONS

echo
echo "=== C. build matcher ==="
BLDPAT='npm run build|npm run next-build|yarn build|pnpm build|next build'
invokes "npm run build" "$BLDPAT" && r=match || r=nomatch; check "invocation: npm run build" "match" "$r"
invokes 'echo "npm run build"' "$BLDPAT" && r=match || r=nomatch; check "mention: echo npm run build" "nomatch" "$r"

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
trap '[ -n "$STARTED_LISTENER" ] && kill "$STARTED_LISTENER" 2>/dev/null' EXIT
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

echo
echo "=== E. SessionEnd cleanup deletes only its own session ==="
rm -rf "$D"
printf '{"session_id":"sessAAA"}' | $H/session-start-snapshot.sh > /dev/null
printf '{"session_id":"sessBBB"}' | $H/session-start-snapshot.sh > /dev/null
printf '{"session_id":"sessAAA"}' | $H/session-end-cleanup.sh
remaining=$(ls -1 "$D" | tr '\n' ' ' | sed 's/ $//')
check "only B's files remain" "devserver-sessBBB.txt warned-sessBBB.txt" "$remaining"

echo
echo "=== F. sweep removes state older than 7 days ==="
touch -d '10 days ago' "$D/devserver-deadsession.txt"
touch -d '10 days ago' "$D/warned-deadsession.txt"
before=$(ls -1 "$D" | wc -l)
printf '{"session_id":"sessCCC"}' | $H/session-start-snapshot.sh > /dev/null
after=$(ls -1 "$D" | grep -c deadsession)
check "stale files present before sweep" "4" "$before"
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
