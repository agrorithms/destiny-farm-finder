# Spec — Claude Code hooks + CLAUDE.md workflow section

This spec was agreed in conversation (no ticket). It is the originating
requirement set for the change under review.

## Background / motivation

A usage-insights report on the user's Claude Code sessions identified recurring
friction. Two root causes were selected for action:

1. **Environment debris.** Claude previously killed only the `npm` wrapper when
   shutting down a dev server, leaving an orphaned `next dev` holding port 3000,
   which then blocked the user's own `npm run dev`. Concurrent `next build` runs
   collided on the Next.js build lock. A separate incident: Claude ran
   `npm uninstall sqlite3` when the user only wanted the `package.json` entry
   removed, and had to be interrupted.
2. **Workflow renegotiated every session.** The user repeatedly had to interrupt
   mid-session with "do not write or execute anything" because Claude began
   planning/editing during what was meant to be a discussion. CLAUDE.md documented
   domain conventions but nothing about how the user wants to be worked with.

Explicit framing agreed with the user: documentation is advisory and only works
if the model honours it; hooks are enforcement and run regardless. The problems
above are hook-shaped, not prose-shaped.

## Requirements

### R1 — Dev-server port guard
Prevent starting a second dev server when the dev port (3000) is already held.

- R1.1 Must DENY the tool call, not kill the existing process. Rationale agreed
  explicitly: the process holding 3000 is as likely to be the user's own
  deliberately-started server as it is debris. An auto-kill design
  (`lsof -ti:3000 | xargs kill -9`, as the insights report suggested) was
  REJECTED for this reason.
- R1.2 The denial message must name the holding PID(s), warn that the server may
  be the user's, and instruct that the real `next dev`/`next-server` PID be
  killed rather than the npm wrapper.
- R1.3 Must fire only for commands that actually START a dev server, not for
  commands that merely mention one (echo, grep, commit messages, doc edits).
  Amended 2026-07-31: "mention" explicitly includes **heredoc bodies** and
  **quoted spans**. Writing documentation via `cat > f <<EOF` used to be denied,
  and only while a server was running — i.e. exactly when one is most likely to
  be documenting one. A false positive is more expensive than a missed match
  (see "Matching policy" below), so both classes are now stripped before
  matching.

### R2 — Build-lock guard
Prevent a second `next build` while one is running. Deny with the colliding PID.
Same mention-vs-invocation requirement as R1.3.

### R3 — Session start snapshot
Record which PIDs hold the dev port at session start, and inject context telling
Claude a pre-existing server is the user's, to be reused not killed.
Must kill nothing.

- R3.1 Added 2026-07-31. The SessionStart hook fires on ALL FIVE matchers
  (`startup`, `resume`, `clear`, `compact`, `fork`) and must therefore be
  **non-destructive**: it establishes the baseline and the warned set only when
  they are absent.

  Narrowing the matcher to `startup` was considered and REJECTED. `clear` and
  `resume` are also SessionEnd *reasons*, so `/clear` deletes the state and then
  re-enters SessionStart; a hook that ignored `clear` would leave Stop with no
  baseline at all, and every port holder would be reported as session debris —
  precisely the failure R4.2 exists to prevent. The defect was that the write was
  unconditional, not that the hook fired too often.

### R4 — Orphan reporting at session end
Report dev servers still running that were NOT present at session start.

- R4.1 Must NOT kill anything — report only, including a ready-to-use kill
  command for the user. The user may be intentionally leaving a server running.
- R4.2 Must distinguish session-created servers from pre-existing ones via the
  R3 snapshot.
- R4.3 Because the Stop event fires once per TURN (not once per session), a given
  PID must be reported EXACTLY ONCE per session, never re-nagged on subsequent
  turns. (Confirmed 2026-07-31 against the published hooks reference; previously
  assumed.)
- R4.4 Added 2026-07-31. Stop must FAIL OPEN: if no baseline snapshot exists it
  reports nothing. A missing or unreadable snapshot would otherwise be
  indistinguishable from "the port was empty at session start", so the user's own
  server gets reported as debris together with a ready-to-run `kill` — the single
  outcome the no-kill design exists to prevent. A missed report only costs a stale
  server the user would notice anyway.

### R5 — Per-session state isolation
Snapshot and warned-PID state must be keyed per session, not per user, so two
concurrent Claude sessions in the same repo do not clobber each other's baseline.

- R5.1 Derive the key from the hook payload's `session_id`.
- R5.2 Degrade gracefully if `session_id` is absent — must not produce a
  malformed filename.

### R6 — State cleanup
Session state files must not pile up in /tmp.

- R6.1 Delete the session's state on SessionEnd.
- R6.2 SessionEnd is NOT guaranteed (unconfirmed whether a Ctrl+C exit reaches
  it; will not fire on a hard kill). Cleanup must therefore not depend on a
  graceful exit — an age-based sweep is required as the actual guarantee.

### R7 — Guard against package-removal overreach
`npm uninstall` / `rm` / `remove` / `prune` must prompt rather than run freely.

- R7.1 Amended 2026-07-31. Originally met by `permissions.ask` rules alone.
  Those are prefix-matched, so `cd . && npm uninstall sqlite3` slipped past —
  and an `&&` chain is the shape the original incident actually took. Now also a
  PreToolUse hook (`guard-destructive.sh`) emitting
  `permissionDecision: "ask"`, which inherits `invokes()`'s separator splitting
  and therefore catches the command wherever it sits. The `permissions.ask`
  rules are retained as a second layer.
- R7.2 Recursive deletes (`rm -r`, `-rf`, `-fr`, `-R`) are gated. Plain
  `rm -f <file>` is deliberately NOT — prompting on every single-file delete
  would train the prompt to be ignored.

### R8 — CLAUDE.md workflow section
Add a section encoding standing preferences so they are not renegotiated each
session:
- Discussion is the default; implementation is opt-in and requires an explicit
  trigger ("implement it", "go ahead", "execute the plan").
- Evidence before root-cause claims: state 2-3 hypotheses plus the check that
  would confirm/kill each; drop a hypothesis when contradicted rather than
  refining it; do not treat the user's most recent change as a privileged suspect.
- Checkpoint builds touching more than ~8 files (progress file + WIP commits),
  because the user reviews diffs before they land.
- Verification: point at the existing `verify` skill; run lint/build/test and
  report real output; state plainly when browser-side behaviour is unverified
  (no headless browser is installed).
- Environment: kill real PIDs not npm wrappers; never kill a server you did not
  start without asking; `lsof` cannot see network sockets under WSL2.

## Matching policy

Added 2026-07-31, because it decides every trade-off in `invokes()`.

`invokes()` is a **best-effort backstop against a forgetful Claude, not an
evasion-proof gate.** The thing it guards against is a model that ran
`npm run dev` without checking the port; such a model writes the plain form or a
common wrapper, not a deliberately obfuscated one.

The consequence that orders everything else: **a false positive costs more than a
bypass.** A bypass means the guard is silent. A false positive blocks legitimate
work — and in the Stop hook's case, a false *orphan report* hands the user a
`kill` aimed at a server that may be theirs. Every ambiguous case therefore
fails open.

## Constraints / environment facts established during the work

- WSL2: `lsof -ti:3000` exits 1 even when a server is listening. `ss` and
  `fuser` both work. This was verified by hand against a live server.
- `pgrep -f "next dev"` self-matches the hook's own shell wrapper.
- A real production build's decisive cmdline is
  `node <repo>/node_modules/.bin/next build` — NOT `npm run build`.
- Hook contract: JSON payload on stdin (readable once), JSON decision on stdout,
  exit 0 even when denying.

Confirmed 2026-07-31 against `https://code.claude.com/docs/en/hooks` and the
published settings schema — previously assumed:

- `SessionStart` matchers are `startup | resume | clear | compact | fork`. This
  spec originally predated `fork`.
- `SessionEnd` reasons are `clear | resume | logout | prompt_input_exit |
  bypass_permissions_disabled | other`.
- All matching `PreToolUse` hooks run **in parallel**, so every guard registered
  against `Bash` runs on every Bash call. Guards must exit cheaply on the common
  case — all three return before any `ss`/`pgrep` runs.
- `PreToolUse` `permissionDecision` accepts `ask`, not only `allow`/`deny`. This
  is what lets R7 be a hook.
- The settings schema is published at
  `https://json.schemastore.org/claude-code-settings.json` and defines
  `hookMatcher`/`hookCommand` with `additionalProperties: false`, so a misspelled
  key (`mather` for `matcher`, which would silently disable a hook) is a real
  validation error. The previous `$schema` value was the JSON Schema
  *meta-schema*, which validated nothing.

## Explicit non-goals

- No hook may kill any process. Detect and report only.
- Not intended to handle dev ports other than 3000 (known limitation, accepted).
- `next_build_pids` is not repo-scoped (known limitation, accepted).

Added 2026-07-31 — accepted limitations, each pinned by a test or recorded here
so it is not "fixed" by accident:

- **`sh -c "npm run dev"` bypasses `invokes()`.** Nested quoting is where regex
  stops paying, and nothing in the incident history involved it. Pinned by an
  assertion in `test-hooks.sh` §A3 that asserts it still does NOT match.
- **A forked session has no baseline of its own.** `fork` assigns a fresh
  `session_id`, so no keying scheme carries the parent's snapshot across. Stop
  fails open (R4.4), so the consequence is silence, not a false report.
- **Whether a Ctrl+C×2 exit reaches `SessionEnd` is still unverified.** The
  published reference rules it neither in nor out; `other` may cover it.
  Deliberately not settled, because it changes no code: R6.2's age-based sweep is
  justified by hard-kill alone.
- **`yarn`/`pnpm` are out of scope.** Guards matched them originally as
  unrequested scope creep; this repo is npm-only and the patterns were narrowed.
