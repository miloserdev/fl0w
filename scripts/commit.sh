#!/usr/bin/env bash
# Коммит от имени Claude: без GPG-подписи и без запросов пароля (см. CLAUDE.md, «Git»).
# Использование: scripts/commit.sh "тема" ["тело"]
# Глобальные настройки git и ключи не трогаются — только локальный конфиг этого репозитория.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

[ $# -ge 1 ] || { echo 'usage: scripts/commit.sh "subject" ["body"]' >&2; exit 2; }
git config --local user.name  >/dev/null || git config --local user.name  "Claude"
git config --local user.email >/dev/null || git config --local user.email "noreply@anthropic.com"

git add -A
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi

# секреты и данные сервера в коммит не попадают
if git diff --cached --name-only | grep -E '(^|/)(\.env(\..*)?|\.data/)|\.(pem|key)$' | grep -vE '(^|/)\.env\.example$' >/dev/null; then
  echo "refusing to commit: staged files look like secrets or server data:" >&2
  git diff --cached --name-only | grep -E '(^|/)(\.env(\..*)?|\.data/)|\.(pem|key)$' | grep -vE '(^|/)\.env\.example$' >&2
  exit 1
fi

msg="$1"
[ -n "${2:-}" ] && msg="$msg"$'\n\n'"$2"
msg="$msg"$'\n\n'"Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"

GIT_TERMINAL_PROMPT=0 git -c commit.gpgsign=false -c tag.gpgsign=false commit -q -m "$msg"
git log --oneline -1
