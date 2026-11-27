#!/usr/bin/env bash
# Runs one command as the factory's GitHub identity (L-0031).
#
# Mints a 1-hour installation token scoped to this repository, then runs the
# command with that token in GH_TOKEN, a git credential helper that reads it
# from the environment, and the factory bot as commit author. The token is
# never printed.
#
# Protected core (L-0001): this script issues credentials.
#
# One-time setup by an approver: the GitHub App credentials, stored outside the
# repository, in ~/.config/straight-facts/github-app.json and github-app.pem.
#
# Usage: scripts/as-factory.sh <command> [args...]
#   e.g. scripts/as-factory.sh gh pr create --fill
set -euo pipefail

CONF=${STRAIGHT_FACTS_CONFIG:-"$HOME/.config/straight-facts"}
API=https://api.github.com
REPO=$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')

json_field() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
require() { [ -n "$2" ] && [ "$2" != null ] || { echo "as-factory: could not obtain $1" >&2; exit 1; }; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

APP_ID=$(json_field "$CONF/github-app.json" app_id)
SLUG=$(json_field "$CONF/github-app.json" slug)

now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$APP_ID" | b64url)
signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$CONF/github-app.pem" | b64url)
JWT="$header.$payload.$signature"

INSTALLATION_ID=$(curl -fsS -H "Authorization: Bearer $JWT" -H "Accept: application/vnd.github+json" \
	"$API/repos/$REPO/installation" | jq -r .id)
TOKEN=$(curl -fsS -X POST -H "Authorization: Bearer $JWT" -H "Accept: application/vnd.github+json" \
	-d "{\"repositories\":[\"${REPO#*/}\"]}" \
	"$API/app/installations/$INSTALLATION_ID/access_tokens" | jq -r .token)
BOT_ID=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$API/users/$SLUG%5Bbot%5D" | jq -r .id)
require "installation id" "$INSTALLATION_ID"
require "installation token" "$TOKEN"
require "bot user id" "$BOT_ID"

export GH_TOKEN="$TOKEN"
export GIT_AUTHOR_NAME="$SLUG[bot]" GIT_COMMITTER_NAME="$SLUG[bot]"
export GIT_AUTHOR_EMAIL="$BOT_ID+$SLUG[bot]@users.noreply.github.com"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# Replace every configured credential helper with one that answers from GH_TOKEN.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper
export GIT_CONFIG_VALUE_1='!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f'

exec "$@"
