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

# `rm -[a-zA-Z]*[rR][a-zA-Z]*` covers -r, -rf, -fr, -R and friends. Plain
# `rm -f somefile` is deliberately NOT matched — a single-file delete is not
# the overreach this guards against, and prompting on every one would train
# the prompt to be ignored.
invokes "$CMD" 'npm uninstall|npm rm|npm remove|npm prune|rm -[a-zA-Z]*[rR][a-zA-Z]*' || exit 0

ask "This command removes packages or recursively deletes files.
Command: ${CMD}
Confirm this is what you want. If only a package.json entry should change, edit package.json directly instead of uninstalling."
