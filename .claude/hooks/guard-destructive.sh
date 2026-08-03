#!/usr/bin/env bash
# PreToolUse(Bash): make package removal and recursive deletes ASK first.
#
# Why this exists: a previous session ran `npm uninstall sqlite3` when only the
# package.json entry was wanted, and had to be interrupted by hand.
#
# Why a hook rather than the permissions.ask rules alone: those rules are
# prefix-matched, so `cd . && npm uninstall sqlite3` slips straight past them —
# and an `&&` chain is exactly the shape the original incident took. invokes()
# splits on shell separators, so it catches the command wherever it sits.
# The permissions.ask rules in settings.json are kept as a second layer.
#
# Decision is "ask", not "deny": these are legitimate commands that need a
# human in the loop, not forbidden ones.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CMD="$(hook_field '.tool_input.command')"

# Three independent rules, any of which asks:
#
# R7.2 — the flag rule. `rm -[a-zA-Z]*[rR][a-zA-Z]*` covers -r, -rf, -fr, -R and
#   friends. Plain `rm -f somefile` is deliberately NOT matched: a single-file
#   delete is not the overreach this guards against, and prompting on every one
#   would train the prompt to be ignored.
#
#   `git reset --hard` and `git checkout --` destroy uncommitted work, which in
#   this workflow is routinely the only copy. Plain `git checkout <branch>` and
#   a soft/mixed `git reset` are not matched. The pattern itself lives in
#   lib.sh as HOOK_DESTRUCTIVE so the tests cannot assert against a stale copy.
#
# R7.2b — `git clean`, handled separately because of its dry-run exemption.
#   Added after auditing what `git clean -fdx` removes HERE: data/ (9.0G),
#   .env, .claude/plans/, certificates/, docs/handoffs/ — none of it in git. It
#   was completely ungated while `rm -rf` was gated.
#
# R7.3 — the untracked-path rule. Any rm naming a gitignored path, whatever its
#   flags. This is what catches `rm data/raid-tracker.db`, which needs no -r.
#
# Each rule is checked independently. An earlier version let the git-clean
# dry-run exemption `exit 0` for the whole hook, so an unrelated `head -n 20`
# elsewhere in the command disabled the rm rules too.

if invokes_strict "$CMD" "$HOOK_DESTRUCTIVE"; then
  ask "This command removes packages, discards work, or recursively deletes files.
Command: ${CMD}
Confirm this is what you want. If only a package.json entry should change, edit package.json directly instead of uninstalling."
fi

if invokes_real_git_clean "$CMD"; then
  ask "This git clean deletes untracked files, which git cannot restore.
Command: ${CMD}
In this repo an unrestricted clean removes data/ (the live database), .env, certificates/, .claude/plans/ and docs/handoffs/ — none of them recoverable.
Run it with -n first to see what it would take."
fi

if rm_touches_ignored "$CMD"; then
  ask "This rm names a path that is NOT in git — deleting it cannot be undone with git.
Command: ${CMD}
In this repo that includes data/ (the live database, backed up only by manual snapshots), .env, certificates/, .claude/plans/ and docs/handoffs/.
Confirm the path is really disposable."
fi
