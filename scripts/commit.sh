#!/usr/bin/env bash
# Commit as the owner (user.name/user.email from git config): no GPG signature and no password prompts (see CLAUDE.md, "Git").
# Usage: scripts/commit.sh "subject" ["body"]
# Global git settings and keys are left untouched: signing is disabled only via -c flags for the duration of this command.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

[ $# -ge 1 ] || { echo 'usage: scripts/commit.sh "subject" ["body"]' >&2; exit 2; }
git config user.name >/dev/null && git config user.email >/dev/null || { echo "git user.name / user.email are not set" >&2; exit 2; }

git add -A
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi

# secrets and server data never get into a commit
if git diff --cached --name-only | grep -E '(^|/)(\.env(\..*)?|\.data/)|\.(pem|key)$' | grep -vE '(^|/)\.env\.example$' >/dev/null; then
  echo "refusing to commit: staged files look like secrets or server data:" >&2
  git diff --cached --name-only | grep -E '(^|/)(\.env(\..*)?|\.data/)|\.(pem|key)$' | grep -vE '(^|/)\.env\.example$' >&2
  exit 1
fi

msg="$1"
[ -n "${2:-}" ] && msg="$msg"$'\n\n'"$2"

GIT_TERMINAL_PROMPT=0 git -c commit.gpgsign=false -c tag.gpgsign=false commit -q -m "$msg"
git log --oneline -1
