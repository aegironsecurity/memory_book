#!/usr/bin/env bash
# Deploys the whole back end into the AWS account you are signed in to, seeds the event, and writes
# frontend/js/config.js. Safe to run again: the event id and the seeded event are kept.
#
#   scripts/deploy.sh https://main.d1abc23def.amplifyapp.com [1966]
#
# Argument 1: the Amplify site address (no trailing slash). Argument 2: the 4 digit party code (default 1966).
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ORIGIN="${1:-}"
CODE="${2:-1966}"
[[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "Give the Amplify address first, like https://main.d1abc23def.amplifyapp.com (no slash at the end)."
[[ "$CODE" =~ ^[0-9]{4}$ ]] || die "The party code must be exactly 4 digits."

need aws "Run this from AWS CloudShell, where it is already installed."
need openssl "Run this from AWS CloudShell."
need sha256sum "Run this from AWS CloudShell."
[ -s "$ROOT/backend/dist/guest/index.mjs" ] && [ -s "$ROOT/backend/dist/host/index.mjs" ] \
  || die "backend/dist is missing. Run: (cd backend && npm ci && npm run build) and commit the result."

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Account $ACCOUNT, region $REGION, stack $STACK"

# 1. The event id is the secret in the guest link. Keep the same one across deploys.
if [ ! -s "$STATE_DIR/event-id" ]; then
  openssl rand -hex 16 >"$STATE_DIR/event-id"
  chmod 600 "$STATE_DIR/event-id"
fi
EVENT_ID="$(event_id)"
[[ "$EVENT_ID" =~ ^[0-9a-f]{32}$ ]] || die ".deploy/event-id is not 32 hex characters. Delete it to make a new one."

# 2. A private bucket that holds the packaged Lambda code.
ART="memory-book-artifacts-$ACCOUNT-$REGION"
if ! aws s3api head-bucket --bucket "$ART" 2>/dev/null; then
  echo "Creating artifact bucket $ART"
  aws s3api create-bucket --bucket "$ART" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$ART" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$ART" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
fi

# 3. Package and deploy.
cd "$ROOT"
aws cloudformation package --template-file template.yaml --s3-bucket "$ART" \
  --output-template-file "$STATE_DIR/packaged.yaml" >/dev/null
echo "Deploying the stack (first time takes about 3 minutes)..."
aws cloudformation deploy --template-file "$STATE_DIR/packaged.yaml" --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "AllowedOrigins=$ORIGIN" "EventId=$EVENT_ID"

API_URL="$(stack_output ApiUrl)"
TABLE="$(stack_output TableName)"
CLIENT_ID="$(stack_output UserPoolClientId)"
[ -n "$API_URL" ] && [ "$API_URL" != "None" ] || die "The stack did not report an API address. Check CloudFormation in the console."

CODE_NOTE=""
# 4. Seed the event once. If it exists already it is left alone (rotate the code from the host page instead).
OPENS_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ITEM="$(cat <<JSON
{
  "PK": {"S": "EVENT#$EVENT_ID"},
  "SK": {"S": "META"},
  "guestOfHonor": {"S": "$HONOREE"},
  "codeHash": {"S": "$(code_hash "$EVENT_ID" "$CODE")"},
  "codeVersion": {"N": "1"},
  "opensAt": {"S": "$OPENS_AT"},
  "closesAt": {"S": "$CLOSES_AT"}
}
JSON
)"
if OUT="$(aws dynamodb put-item --table-name "$TABLE" --item "$ITEM" \
  --condition-expression 'attribute_not_exists(PK)' 2>&1)"; then
  echo "Event created with party code $CODE."
  CODE_NOTE="$CODE"
elif grep -q ConditionalCheckFailedException <<<"$OUT"; then
  echo "Event already exists, left unchanged (party code not touched)."
  CODE_NOTE="unchanged (set when the event was first created, or the code you rotated to)"
else
  die "Could not seed the event: $OUT"
fi

# 5. Tell the web page where the API is.
cat >"$ROOT/frontend/js/config.js" <<JS
// Written by scripts/deploy.sh. Safe to commit: nothing here is secret.
export const CONFIG = {
  apiUrl: '$API_URL',
  region: '$REGION',
  userPoolClientId: '$CLIENT_ID',
  honoree: '$HONOREE',
};
JS

cat <<MSG

Done.

  Guest link (this is what the QR code holds):  $ORIGIN/#e=$EVENT_ID
  Host page:                                    $ORIGIN/host.html
  Party code:                                   $CODE_NOTE

Next:
  1. Put frontend/js/config.js (printed below) into your GitHub repo. Either edit that file on
     github.com and paste it in, or run: git add frontend/js/config.js && git commit -m "Configure API" && git push
     Amplify rebuilds the site in about a minute.
  2. scripts/create-host-user.sh jon@aegironsecurity.com
  3. scripts/smoke.sh $ORIGIN

----- frontend/js/config.js -----
MSG
cat "$ROOT/frontend/js/config.js"
