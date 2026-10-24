# Shared settings and helpers. Sourced by the other scripts, not run on its own.
# shellcheck shell=bash

REGION="${AWS_REGION:-us-west-2}"
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
STACK="${STACK_NAME:-memory-book-don-manuel}"
HONOREE="Don Manuel"
export HONOREE
# Uploads close Monday 2026-10-26 17:00 America/Los_Angeles (decision D27).
CLOSES_AT="2026-10-27T00:00:00Z"
export CLOSES_AT

# On Windows (Git Bash) aws.exe ends lines with CRLF, which would leak a carriage return into every
# captured value. Strip it there. CloudShell and Linux are unaffected.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    aws() { command aws "$@" | tr -d '\r'; }
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.deploy"
mkdir -p "$STATE_DIR"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed. $2"
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

event_id() {
  [ -s "$STATE_DIR/event-id" ] || die "No event id found in .deploy/event-id. Run scripts/deploy.sh first."
  tr -d '[:space:]' <"$STATE_DIR/event-id"
}

code_hash() { # event id, code
  printf '%s' "$1:$2" | sha256sum | cut -d' ' -f1
}
