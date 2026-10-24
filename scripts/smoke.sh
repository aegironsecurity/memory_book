#!/usr/bin/env bash
# Checks the live deployment end to end with curl: gate, wrong code, note, a tiny photo through S3, CORS, host lock.
# Leaves one note and one 1 KB test photo from "Smoke Test" in the book. Hide them on the host page.
#
#   scripts/smoke.sh https://main.d1abc23def.amplifyapp.com [1966]
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ORIGIN="${1:-}"
CODE="${2:-1966}"
[[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "Give the Amplify address, like https://main.d1abc23def.amplifyapp.com"
need curl "Run this from AWS CloudShell."
need jq "Run this from AWS CloudShell."
need aws "Run this from AWS CloudShell."
need openssl "Run this from AWS CloudShell."
EVENT_ID="$(event_id)"
API="$(stack_output ApiUrl)"
GUEST="$(openssl rand -hex 16)"
FAILS=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected $3, got $2)"; fi; }
has() { # description, grep pattern, text, failure message
  if grep -q "$2" <<<"$3"; then pass "$1"; else fail "$4"; fi
}

post() { # path, token, json
  curl -sS -m 20 -X POST "$API$1" -H 'content-type: application/json' -H "origin: $ORIGIN" \
    ${2:+-H "authorization: Bearer $2"} -d "$3"
}
code_of() { # same as post but prints only the HTTP status
  curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "$API$1" -H 'content-type: application/json' -H "origin: $ORIGIN" -d "$2"
}

echo "Site:  $ORIGIN"
echo "API:   $API"

echo "Web page"
check "site answers 200" "$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$ORIGIN/")" 200
check "host page answers 200" "$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$ORIGIN/host.html")" 200
HDRS="$(curl -sSI -m 20 "$ORIGIN/" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
has "security headers present" '^content-security-policy:' "$HDRS" "Content-Security-Policy header missing (check customHttp.yml was picked up)"
has "config.js points at this API" "apiUrl: '$API'" "$(cat "$ROOT/frontend/js/config.js")" "frontend/js/config.js does not match the API address. Re-run deploy.sh and push."

echo "Gate"
check "wrong code is refused" "$(code_of /guest/start "{\"eventId\":\"$EVENT_ID\",\"code\":\"0000\",\"guestId\":\"$GUEST\"}")" 401
check "unknown link is refused" "$(code_of /guest/start "{\"eventId\":\"$(printf '0%.0s' {1..32})\",\"code\":\"$CODE\",\"guestId\":\"$GUEST\"}")" 404
START="$(post /guest/start "" "{\"eventId\":\"$EVENT_ID\",\"code\":\"$CODE\",\"guestId\":\"$GUEST\"}")"
TOKEN="$(jq -r '.token // empty' <<<"$START")"
if [ -n "$TOKEN" ]; then pass "right code gives a token (guest of honor: $(jq -r .guestOfHonor <<<"$START"))"; else fail "right code did not work: $START"; fi

echo "CORS"
PRE="$(curl -sSI -m 20 -X OPTIONS "$API/guest/memories" -H "origin: $ORIGIN" -H 'access-control-request-method: POST' -H 'access-control-request-headers: authorization,content-type' | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
has "API allows the site origin" "^access-control-allow-origin: $ORIGIN" "$PRE" "API CORS does not allow $ORIGIN"

echo "Memories"
ID1="$(printf '%09x' "$(date +%s)")-$(openssl rand -hex 8)"
NOTE="$(post /guest/memories "$TOKEN" "{\"id\":\"$ID1\",\"kind\":\"note\",\"name\":\"Smoke Test\",\"text\":\"Smoke test note, please ignore.\"}")"
check "note is saved" "$(jq -r .status <<<"$NOTE")" complete

ID2="$(printf '%09x' "$(date +%s)")-$(openssl rand -hex 8)"
PHOTO="$STATE_DIR/smoke.jpg"
{ printf '\xff\xd8\xff'; head -c 1021 /dev/zero; } >"$PHOTO"
CREATE="$(post /guest/memories "$TOKEN" "{\"id\":\"$ID2\",\"kind\":\"photo\",\"name\":\"Smoke Test\",\"caption\":\"test\",\"contentType\":\"image/jpeg\",\"sizeBytes\":1024,\"durationSec\":0}")"
check "photo upload starts" "$(jq -r .status <<<"$CREATE")" pending
PARTS="$(post "/guest/memories/$ID2/parts" "$TOKEN" '{"partNumbers":[1]}')"
URL="$(jq -r '.urls[0].url // empty' <<<"$PARTS")"
if [ -n "$URL" ]; then
  RES="$(curl -sS -m 30 -D - -o /dev/null -X PUT --data-binary "@$PHOTO" -H "origin: $ORIGIN" "$URL" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  has "browser style PUT to S3 works" '^http/[0-9.]* 200' "$RES" "S3 refused the upload: $(head -1 <<<"$RES")"
  has "S3 CORS allows the site origin" "^access-control-allow-origin: $ORIGIN" "$RES" "S3 CORS does not allow $ORIGIN"
else
  fail "no upload address came back: $PARTS"
fi
DONE="$(post "/guest/memories/$ID2/complete" "$TOKEN" '{}')"
check "photo completes with the right size and type" "$(jq -r .status <<<"$DONE")" complete

echo "Host lock"
check "host list needs a sign in" "$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$API/host/memories")" 401

echo
if [ "$FAILS" -eq 0 ]; then echo "All checks passed."; else echo "$FAILS check(s) failed."; exit 1; fi
