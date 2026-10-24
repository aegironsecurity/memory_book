#!/usr/bin/env bash
# Copies every original file and the memory records to ./export so you can build the book offline.
# Resumable: run it again and only new files are copied.
#
#   scripts/export.sh
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need aws "Run this from AWS CloudShell."
need jq "Run this from AWS CloudShell."
BUCKET="$(stack_output BucketName)"
TABLE="$(stack_output TableName)"
EVENT_ID="$(event_id)"
OUT="$ROOT/export"
mkdir -p "$OUT/files"

echo "Copying files from s3://$BUCKET/events/$EVENT_ID/ ..."
aws s3 sync "s3://$BUCKET/events/$EVENT_ID/" "$OUT/files/" --only-show-errors

echo "Saving memory records..."
aws dynamodb scan --table-name "$TABLE" \
  --filter-expression 'PK = :p AND begins_with(SK, :m)' \
  --expression-attribute-values "{\":p\":{\"S\":\"EVENT#$EVENT_ID\"},\":m\":{\"S\":\"MEM#\"}}" \
  --consistent-read --output json |
  jq 'def unwrap: if type == "object" then (if has("S") then .S elif has("N") then (.N | tonumber) elif has("BOOL") then .BOOL elif has("NULL") then null elif has("L") then (.L | map(unwrap)) elif has("M") then (.M | map_values(unwrap)) else map_values(unwrap) end) else . end;
      [.Items[] | map_values(unwrap) | del(.PK, .SK, .uploadId, .key, .thumbKey, .guestId)] | sort_by(.id)' >"$OUT/memories.json"

echo "Done: $(jq length "$OUT/memories.json") records, $(find "$OUT/files" -type f | wc -l | tr -d ' ') files in $OUT"
