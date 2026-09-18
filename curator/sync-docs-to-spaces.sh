#!/usr/bin/env bash
# Sync docs/ to the Spaces bucket that backs the Gradient Knowledge Base.
# Run by the curator agent after it commits new docs. Safe to run repeatedly.
#
# Required env:
#   SPACES_ACCESS_KEY, SPACES_SECRET_KEY   Spaces access key pair
#   SPACES_REGION                           e.g. nyc3
#   SPACES_BUCKET                           bucket name
# Optional env:
#   SPACES_PREFIX                           key prefix inside the bucket (default: docs)
set -euo pipefail

: "${SPACES_ACCESS_KEY:?SPACES_ACCESS_KEY is required}"
: "${SPACES_SECRET_KEY:?SPACES_SECRET_KEY is required}"
: "${SPACES_REGION:?SPACES_REGION is required}"
: "${SPACES_BUCKET:?SPACES_BUCKET is required}"
SPACES_PREFIX="${SPACES_PREFIX:-docs}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The sandbox has Python; install the AWS CLI on first use if it is missing.
if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found; installing with pip..."
  python3 -m pip install --quiet --user awscli
  export PATH="$HOME/.local/bin:$PATH"
fi

export AWS_ACCESS_KEY_ID="$SPACES_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SPACES_SECRET_KEY"
export AWS_DEFAULT_REGION="us-east-1"   # Spaces ignores the region name but the CLI wants one
ENDPOINT="https://${SPACES_REGION}.digitaloceanspaces.com"

echo "Syncing $ROOT/docs -> s3://$SPACES_BUCKET/$SPACES_PREFIX/"
aws s3 sync "$ROOT/docs" "s3://$SPACES_BUCKET/$SPACES_PREFIX/" \
  --endpoint-url "$ENDPOINT" \
  --delete \
  --exclude ".*" \
  --acl private
echo "Sync complete."
