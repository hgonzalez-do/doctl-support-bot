#!/usr/bin/env bash
# Start an indexing job on the Gradient Knowledge Base and wait for it to finish.
# Run by the curator agent after docs are synced to Spaces.
#
# Required env:
#   DIGITALOCEAN_ACCESS_TOKEN   DO API token with GenAI write access
#   KB_UUID                     knowledge base UUID
#   KB_DATA_SOURCE_UUID         UUID of the Spaces data source inside the KB
# Optional env:
#   REINDEX_TIMEOUT_SECONDS     default 900
set -euo pipefail

: "${DIGITALOCEAN_ACCESS_TOKEN:?DIGITALOCEAN_ACCESS_TOKEN is required}"
: "${KB_UUID:?KB_UUID is required}"
: "${KB_DATA_SOURCE_UUID:?KB_DATA_SOURCE_UUID is required}"
TIMEOUT="${REINDEX_TIMEOUT_SECONDS:-900}"
API="https://api.digitalocean.com/v2/gen-ai"

auth=(-H "Authorization: Bearer $DIGITALOCEAN_ACCESS_TOKEN" -H "Content-Type: application/json")

echo "Starting indexing job for knowledge base $KB_UUID ..."
resp="$(curl -sS -X POST "${auth[@]}" "$API/indexing_jobs" \
  -d "{\"knowledge_base_uuid\":\"$KB_UUID\",\"data_source_uuids\":[\"$KB_DATA_SOURCE_UUID\"]}")"

job_uuid="$(printf '%s' "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("job",{}).get("uuid",""))')"
if [ -z "$job_uuid" ]; then
  echo "Failed to start indexing job. Response:"; echo "$resp"; exit 1
fi
echo "Indexing job: $job_uuid"

start=$(date +%s)
while :; do
  status_json="$(curl -sS "${auth[@]}" "$API/indexing_jobs/$job_uuid")"
  status="$(printf '%s' "$status_json" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("job",{}); print(d.get("status",""), d.get("phase",""))')"
  echo "  $(date -u +%H:%M:%S) $status"
  case "$status" in
    *COMPLETED*) echo "Indexing finished."; exit 0 ;;
    *FAILED*|*CANCEL*) echo "Indexing did not complete: $status"; echo "$status_json"; exit 1 ;;
  esac
  if [ $(( $(date +%s) - start )) -ge "$TIMEOUT" ]; then
    echo "Timed out after ${TIMEOUT}s waiting for indexing job $job_uuid"; exit 1
  fi
  sleep 15
done
