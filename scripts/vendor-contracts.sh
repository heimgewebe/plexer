#!/bin/bash
set -e

# Configuration
# Default to main, but allow override via env var for CI pinning
COMMIT_SHA="${COMMIT_SHA:-main}"
METAREPO_BASE_URL="https://raw.githubusercontent.com/heimgewebe/metarepo/${COMMIT_SHA}/contracts/plexer"
TARGET_DIR="src/vendor/schemas/plexer"

mkdir -p "$TARGET_DIR"

echo "Vendoring contracts from metarepo..."

validate_json() {
  local target="$1"
  if command -v jq >/dev/null 2>&1; then
    jq . "$target" >/dev/null 2>&1
  else
    node -e "JSON.parse(require('fs').readFileSync('$target','utf8'))" >/dev/null 2>&1
  fi
}

# Function to download a schema
vendor_schema() {
  local filename=$1
  local url="${METAREPO_BASE_URL}/${filename}"
  local target="${TARGET_DIR}/${filename}"

  echo "Downloading $filename..."
  # Use curl if available, otherwise wget
  if command -v curl >/dev/null 2>&1; then
    curl -sSL --fail "$url" -o "$target" || { echo "Failed to download $url"; exit 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$target" || { echo "Failed to download $url"; exit 1; }
  else
    echo "Error: neither curl nor wget found."
    exit 1
  fi

  # Validation (basic check if it's JSON)
  if ! validate_json "$target"; then
     echo "Error: Downloaded file $filename is not valid JSON."
     exit 1
  fi
}

# Active download execution
vendor_schema "delivery.report.v1.schema.json"
vendor_schema "failed_event.v1.schema.json"
vendor_schema "event.envelope.v1.schema.json"

echo "Vendoring complete."
