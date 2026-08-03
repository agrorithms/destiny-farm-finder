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

### R3 — Session start snapshot — **REMOVED 2026-08-03**

Formerly: record which PIDs hold the dev port at session start, so R4.2 could
diff against it; and inject context telling Claude a pre-existing server is the
user's.

Removed because the baseline file was the wrong primitive. It had to survive
`startup`, `resume`, `clear`, `compact` and `fork`, and it did not: `clear` and
`resume` are also SessionEnd *reasons*, so re-entry deleted the state and every
port holder then read as session debris — the exact failure R4.2 exists to
prevent. Reproduced 2026-08-03: `/clear` took snapshot `[12345] -> []` and
warned `[99999] -> []`. `fork` had no answer at all, since it assigns a fresh
`session_id` that no keying scheme can carry a baseline across.

R4.2 now decides the same question from process age, which requires no state, so
there is nothing to establish at session start and nothing to lose on re-entry.
R3.1's non-destructive-write rule goes with it; its rationale was also circular
(it justified itself by a failure mode that R4.4, added in the same edit, had
already made impossible).

The pre-existing-server briefing is not replaced. `guard-dev-server.sh` denies
at the moment it matters with a better-targeted message, and CLAUDE.md already
carries the standing instruction not to kill a server you did not start.

### R4 — Orphan reporting at session end
Report dev servers still running that this session started.

- R4.1 Must NOT kill anything — report only, including a ready-to-use kill
  command for the user. The user may be intentionally leaving a server running.
- R4.2 **Rewritten 2026-08-03.** Must distinguish session-created servers from
  pre-existing ones by **process age**: a dev-port holder younger than the
  `claude` process is one this session started.

  The session's age is found by walking UP the process tree to the nearest
  process with `comm=claude`. It must NOT be read from `$PPID` — see the
  constraint below, which records why that would silently disable the check.

  Accepted consequence, unchanged from the snapshot design: a server the USER
  starts mid-session in another terminal is younger than the session and will be
  reported. It was equally absent from the old baseline. The report is worded
  "started after this session began" rather than claiming Claude started it. The
  same applies to a `next dev` that restarts its own child mid-session.
- R4.3 Because the Stop event fires once per TURN (not once per session), a given
  PID must be reported EXACTLY ONCE per session, never re-nagged on subsequent
  turns. (Confirmed 2026-07-31 against the published hooks reference; previously
  assumed.) This is the only reason per-session state still exists.
- R4.4 Added 2026-07-31, **mechanism updated 2026-08-03**. Stop must FAIL OPEN:
  if the session age cannot be determined — no `claude` ancestor found, or a
  non-numeric result — it reports nothing. Reporting on an unusable age would
  hand the user a ready-to-run `kill` aimed at what may be their own server, the
  single outcome the no-kill design exists to prevent. A missed report only costs
  a stale server the user would notice anyway.

  This case cannot be tested end-to-end: every process a test spawns is a
  descendant of the real `claude`, so "no ancestor" is unreachable from inside a
  session. The decision logic is therefore split into a pure function
  (`classify_holders`, age passed in) which IS tested, and the ancestry walk
  (`session_age`), covered by a smoke test asserting it finds an ancestor.

### R5 — Per-session state isolation
Warned-PID state must be keyed per session, not per user, so two concurrent
Claude sessions in the same repo do not clobber each other.

- R5.1 Derive the key from the hook payload's `session_id`.
- R5.2 Degrade gracefully if `session_id` is absent — must not produce a
  malformed filename.
- R5.3 Added 2026-08-03. The state directory must be overridable by environment
  so the test suite can point at a throwaway path. The suite deletes its state
  directory repeatedly; against the live path that deletes the warned-PID file
  of any session currently running, silently disabling its orphan check for the
  rest of that session. This actually happened on 2026-07-31.

### R6 — State cleanup
Session state files must not pile up in /tmp.

- R6.1 ~~Delete the session's state on SessionEnd.~~ **REMOVED 2026-08-03.**
  The SessionEnd hook is gone. It was never a guarantee (see R6.2), and with the
  baseline snapshot removed the only remaining state is one warned-PID file per
  session, which the sweep handles.
- R6.2 SessionEnd is NOT guaranteed (unconfirmed whether a Ctrl+C exit reaches
  it; will not fire on a hard kill). Cleanup must therefore not depend on a
  graceful exit — an age-based sweep is the actual guarantee. **Updated
  2026-08-03:** the sweep now runs from the Stop hook, i.e. every turn, rather
  than only when a new session starts in this repo. That closes the gap where a
  hard kill left state until someone happened to start another session here.

### R7 — Guard against destructive overreach
Package removal, recursive deletes, and commands that discard work or untracked
files must prompt rather than run freely.

- R7.1 Amended 2026-07-31. Originally met by `permissions.ask` rules alone.
  Those are prefix-matched, so `cd . && npm uninstall sqlite3` slipped past —
  and an `&&` chain is the shape the original incident actually took. Now also a
  PreToolUse hook (`guard-destructive.sh`) emitting
  `permissionDecision: "ask"`, which inherits the separator splitting and
  therefore catches the command wherever it sits. The `permissions.ask`
  rules are retained as a second layer.
- R7.2 Recursive deletes (`rm -r`, `-rf`, `-fr`, `-R`) are gated. Plain
  `rm -f <file>` is deliberately NOT — prompting on every single-file delete
  would train the prompt to be ignored.

  **Extended 2026-08-03** to commands that destroy work or untracked files:
  `git clean`, `git reset --hard`, `git checkout --`, `git restore`. Driven by
  auditing what `git clean -fdx` removes in THIS repo — `data/` (9.0G), `.env`,
  `.claude/plans/`, `certificates/`, `docs/handoffs/`, none of them recoverable
  from git — while `rm -rf` was already gated and `git clean` was not.
  `git clean -n` / `--dry-run` is exempt: a dry run destroys nothing and is how
  you find out what a real clean would take. Plain `git checkout <branch>` and a
  soft/mixed `git reset` are not matched.
- R7.3 **Added 2026-08-03 — untracked-path rule.** Any `rm` naming a path git is
  ignoring must ask, regardless of flags.

  R7.2's flag rule cannot see `rm data/raid-tracker.db`: it is a file, so no
  recursive flag is involved. That is the live 9.0G database whose only backups
  are manual snapshots. Same for `rm .env`, which is not in git at all.

  Resolved dynamically with `git check-ignore` (~2ms, and only after the
  destructive matcher has already fired) rather than a hardcoded list of
  precious paths. Of the 20 gitignored entries in this repo only about five are
  regenerable (`.next/`, `node_modules/`, `dist/`, `next-env.d.ts`,
  `tsconfig.tsbuildinfo`); the rest cannot be recovered by any command. A
  hand-drafted list was already missing `docs/handoffs/`, `certificates/`,
  `scripts/cleanup/`, `seeds.txt` and an untracked script when it was first
  written, and would drift again on every `.gitignore` change.

  No regenerable-path exemption is needed: the noisy cases (`rm -rf .next`,
  `rm -rf node_modules`) are already gated by R7.2, so this rule only adds
  coverage for non-recursive `rm`, where the regenerable paths are things nobody
  types.

  Deliberate consequence: CLAUDE.md's restore procedure step
  `rm data/raid-tracker.db-wal` now prompts. That is a rarely-run, deliberately
  dangerous step and is exactly what this rule is for.
- R7.4 **Added 2026-08-03.** R7 matches with `invokes_strict()`, which differs
  from `invokes()` in two ways: quoted spans are NOT blanked (so
  `sh -c "rm -rf x"` is visible), and `sh -c` / `bash -c` are accepted as
  wrappers. See "Matching policy" for why the trade-off inverts here.

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
**Scoped to R1/R2 on 2026-08-03** — see the R7 inversion below.

`invokes()` is a **best-effort backstop against a forgetful Claude, not an
evasion-proof gate.** The thing it guards against is a model that ran
`npm run dev` without checking the port; such a model writes the plain form or a
common wrapper, not a deliberately obfuscated one.

The consequence that orders everything else **for R1 and R2**: a false positive
costs more than a bypass. A bypass means the guard is silent. A false positive
blocks legitimate work — and in the Stop hook's case, a false *orphan report*
hands the user a `kill` aimed at a server that may be theirs. Every ambiguous
case therefore fails open.

### The inversion at R7

**This policy does not apply to R7, and importing it there was an error** (review
finding P-3). R1/R2 emit `deny`, so a false positive blocks real work at exactly
the wrong moment. R7 emits `ask`, so a false positive costs one keystroke —
while a miss costs `node_modules`, `data/` or `.env`. The asymmetry reverses,
and R7 is therefore matched with `invokes_strict()`.

Accepted cost of the stricter matcher: dropping quote-blanking means a separator
inside a quoted string opens a command position, so
`git commit -m "stop; rm -rf x"` asks. Pinned by a test.

Heredoc stripping is retained even for R7. Writing documentation about
`rm -rf` is common in this repo — this spec does it repeatedly — and a heredoc
body is unambiguously not an invocation.

## Constraints / environment facts established during the work

- WSL2: `lsof -ti:3000` exits 1 even when a server is listening. `ss` and
  `fuser` both work. This was verified by hand against a live server.
- `pgrep -f "next dev"` self-matches the hook's own shell wrapper.
- A real production build's decisive cmdline is
  `node <repo>/node_modules/.bin/next build` — NOT `npm run build`.

  **Verified against a real build 2026-08-03** (it had been asserted but never
  executed — every test only checked "allow when nothing is running"):

  ```
  10514 sh -c npm run next-build && npm run build:scripts
  10515 npm run next-build
  10526 sh -c next build
  10527 node /home/.../node_modules/.bin/next build      <- the one that matches
  10582 node /home/.../.next/build/webpack-loaders.js 35907
  10595 node /home/.../.next/build/postcss.js 40903
  ```

  `next_build_pids()` returned `[10527]` only — not the two `sh -c` wrappers,
  not the npm wrapper, not the webpack/postcss workers — and a second
  `npm run build` was denied.
- **A hook's `$PPID` is NOT the `claude` process.** It is a per-invocation
  `/bin/sh -c` wrapper whose own `etimes` is always 0. Established 2026-08-03 by
  instrumenting a live hook:

  ```
  hook pid=10989 ppid=10987
  10987  1464  0     /bin/sh -c "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-build.sh
   1464    10  2778  claude
  ```

  This is load-bearing for R4.2. Reading `$PPID`'s age would yield 0, classify
  every port holder as older than the session, and silently disable the orphan
  check while every test still passed. The session age must be found by walking
  up to the nearest `comm=claude`, not at a fixed depth — the wrapper is a
  harness implementation detail that may change.
- A Bash *tool call*'s `$PPID` **is** `claude` directly; only hooks get the extra
  `sh -c` layer. Do not generalise from one to the other.
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

- **`sh -c "npm run dev"` bypasses R1/R2's `invokes()`.** Nested quoting is where
  regex stops paying, and nothing in the incident history involved it. Pinned by
  an assertion in `test-hooks.sh` §A3 that asserts it still does NOT match.

  **Scoped 2026-08-03:** R7 no longer has this gap — `invokes_strict()` closes
  it (R7.4). Keeping it open for R1/R2 is close to forced rather than merely
  preferred: those still blank quotes, so `sh -c "npm run dev"` becomes
  `sh -c ""` before matching and the wrapper would have nothing to match
  against. Closing it there would mean R1/R2 dropping quote-blanking too and
  inheriting its false positives — on a `deny`.
- ~~**A forked session has no baseline of its own.**~~ **Closed 2026-08-03.**
  There is no baseline. `fork` inherits the same or a newer `claude` process, so
  the R4.2 age comparison holds without any state to carry across.
- **Whether a Ctrl+C×2 exit reaches `SessionEnd` is still unverified.** The
  published reference rules it neither in nor out; `other` may cover it.
  Deliberately not settled, and now moot: there is no SessionEnd hook, and
  R6.2's sweep runs from Stop.
- **A server the user starts mid-session, in another terminal, is reported as
  session debris.** It is younger than the `claude` process. Inherited from the
  snapshot design, which had the same hole for the same reason. Mitigated by
  wording, not by mechanism.
- **The three `PreToolUse` guards are not merged.** Measured 2026-08-03: three
  guards cost ~89ms sequentially, but the harness runs them in parallel, so real
  cost is roughly the slowest single guard (~30ms). Merging would save ~0
  wall-clock while colocating three now-divergent matching strategies and losing
  the per-guard `statusMessage`. Consequence: precedence when a command matches
  two guards is the harness's undocumented behaviour, not ours.
- **`yarn`/`pnpm` are out of scope.** Guards matched them originally as
  unrequested scope creep; this repo is npm-only and the patterns were narrowed.
