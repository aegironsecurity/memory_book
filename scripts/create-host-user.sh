#!/usr/bin/env bash
# Creates (or resets the password of) the one host user. No email is sent: you type the password here.
#
#   scripts/create-host-user.sh jon@aegironsecurity.com
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

EMAIL="${1:-}"
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "Give the host email address, like you@example.com"
need aws "Run this from AWS CloudShell."
POOL="$(stack_output UserPoolId)"
[ -n "$POOL" ] && [ "$POOL" != "None" ] || die "Could not find the user pool. Run scripts/deploy.sh first."

if aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$EMAIL" >/dev/null 2>&1; then
  echo "User $EMAIL exists. Setting a new password."
else
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
    --user-attributes "Name=email,Value=$EMAIL" "Name=email_verified,Value=true" \
    --message-action SUPPRESS >/dev/null
  echo "Created user $EMAIL."
fi

echo "Choose a password: at least 12 characters with upper case, lower case, a number and a symbol."
read -r -s -p "Password: " PW1
echo
read -r -s -p "Again: " PW2
echo
[ "$PW1" = "$PW2" ] || die "The two passwords did not match."
[ "${#PW1}" -ge 12 ] || die "That password is shorter than 12 characters."

# The password goes through a private temp file so it never shows up in the process list.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"
if command -v jq >/dev/null 2>&1; then
  jq -n --arg pool "$POOL" --arg user "$EMAIL" --arg pw "$PW1" \
    '{UserPoolId: $pool, Username: $user, Password: $pw, Permanent: true}' >"$TMP"
else
  need node "Install jq or Node.js, or run this from AWS CloudShell."
  MB_POOL="$POOL" MB_USER="$EMAIL" MB_PW="$PW1" node -e 'const e = process.env;
    process.stdout.write(JSON.stringify({UserPoolId: e.MB_POOL, Username: e.MB_USER, Password: e.MB_PW, Permanent: true}));' >"$TMP"
fi
# aws.exe on Windows needs a Windows path for file://.
TMP_ARG="$TMP"
command -v cygpath >/dev/null 2>&1 && TMP_ARG="$(cygpath -w "$TMP")"
aws cognito-idp admin-set-user-password --cli-input-json "file://$TMP_ARG"
echo "Done. Sign in at your site's /host.html with $EMAIL"
