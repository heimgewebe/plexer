#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/prove-runtime-usefulness.sh [--receipt PATH] [--keep-workdir] [--runner docker|host]

Proves the narrow Plexer usefulness path:
  Grabowski-shaped agent.run.completed event -> Plexer /v1/events -> Chronik agent.ledger -> read-back.

Environment:
  CHRONIK_REPO          Path to a local Chronik checkout (default: /home/alex/repos/chronik)
  PLEXER_PROOF_RUNNER  docker or host (default: docker)
USAGE
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHRONIK_REPO="${CHRONIK_REPO:-/home/alex/repos/chronik}"
RUNNER="${PLEXER_PROOF_RUNNER:-docker}"
KEEP_WORKDIR="${PLEXER_PROOF_KEEP_WORKDIR:-0}"
RECEIPT_PATH="${PLEXER_PROOF_RECEIPT:-$ROOT/data/proofs/runtime-usefulness.receipt.json}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --receipt)
      RECEIPT_PATH="$2"
      shift 2
      ;;
    --keep-workdir)
      KEEP_WORKDIR=1
      shift
      ;;
    --runner)
      RUNNER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if [[ ! -f "$CHRONIK_REPO/app.py" ]]; then
  echo "ERROR: CHRONIK_REPO does not look like a Chronik checkout: $CHRONIK_REPO" >&2
  exit 66
fi
if [[ ! -x "$CHRONIK_REPO/.venv/bin/uvicorn" ]]; then
  echo "ERROR: Chronik uvicorn not found at $CHRONIK_REPO/.venv/bin/uvicorn" >&2
  echo "Run Chronik setup first; this proof intentionally does not mutate Chronik dependencies." >&2
  exit 69
fi
if [[ "$RUNNER" != "docker" && "$RUNNER" != "host" ]]; then
  echo "ERROR: runner must be docker or host" >&2
  exit 64
fi
if [[ "$RUNNER" == "docker" ]] && ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker runner requested but docker is not available" >&2
  exit 69
fi

free_port() {
  python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

wait_http() {
  local url="$1"
  local label="$2"
  local token="${3:-}"
  for _ in $(seq 1 100); do
    if [[ -n "$token" ]]; then
      if curl -fsS --max-time 1 -H "X-Auth: $token" "$url" >/dev/null 2>&1; then
        return 0
      fi
    else
      if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 0.1
  done
  echo "ERROR: timed out waiting for $label at $url" >&2
  return 1
}

WORKDIR="$(mktemp -d -t plexer-runtime-usefulness.XXXXXX)"
CHRONIK_PORT="$(free_port)"
PLEXER_PORT="$(free_port)"
TOKEN="proof-token-$(python3 - <<'PY'
import secrets
print(secrets.token_hex(12))
PY
)"
CHRONIK_DATA_DIR="$WORKDIR/chronik-data"
PLEXER_DATA_DIR="$WORKDIR/plexer-data"
CHRONIK_URL="http://127.0.0.1:$CHRONIK_PORT"
PLEXER_URL="http://127.0.0.1:$PLEXER_PORT"
CONTAINER_NAME="plexer-runtime-usefulness-$$"
chronik_pid=""
plexer_pid=""
started_at="$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'))
PY
)"

cleanup() {
  local rc=$?
  set +e
  if [[ -n "$chronik_pid" ]]; then
    kill "$chronik_pid" >/dev/null 2>&1 || true
    wait "$chronik_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$RUNNER" == "docker" ]]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  elif [[ -n "$plexer_pid" ]]; then
    kill "$plexer_pid" >/dev/null 2>&1 || true
    wait "$plexer_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_WORKDIR" != "1" ]]; then
    rm -rf "$WORKDIR"
  else
    echo "INFO: kept proof workdir: $WORKDIR" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

mkdir -p "$CHRONIK_DATA_DIR" "$PLEXER_DATA_DIR" "$(dirname "$RECEIPT_PATH")"

(
  cd "$CHRONIK_REPO"
  exec env \
    CHRONIK_TOKEN="$TOKEN" \
    CHRONIK_DATA_DIR="$CHRONIK_DATA_DIR" \
    CHRONIK_HOST=127.0.0.1 \
    CHRONIK_PORT="$CHRONIK_PORT" \
    CHRONIK_LOG_LEVEL=INFO \
    CHRONIK_INTEGRITY_ENABLED=0 \
    .venv/bin/uvicorn app:app --host 127.0.0.1 --port "$CHRONIK_PORT"
) >"$WORKDIR/chronik.log" 2>&1 &
chronik_pid=$!
wait_http "$CHRONIK_URL/health" "Chronik" "$TOKEN"

if [[ "$RUNNER" == "docker" ]]; then
  (
    cd "$ROOT"
    exec docker run --rm --name "$CONTAINER_NAME" --network host \
      -e PORT="$PLEXER_PORT" \
      -e HOST=127.0.0.1 \
      -e CHRONIK_URL="$CHRONIK_URL" \
      -e CHRONIK_TOKEN="$TOKEN" \
      -e PLEXER_DATA_DIR=/proof-data \
      -v "$ROOT:/repo" \
      -v "$PLEXER_DATA_DIR:/proof-data" \
      -w /repo \
      node:20.19.0-alpine \
      sh -lc 'corepack enable >/tmp/plexer-corepack.log 2>&1 && pnpm install --store-dir /tmp/plexer-pnpm-store --frozen-lockfile >/tmp/plexer-pnpm-install.log 2>&1 && pnpm run build >/tmp/plexer-build.log 2>&1 && exec node dist/index.js'
  ) >"$WORKDIR/plexer.log" 2>&1 &
  plexer_pid=$!
else
  (
    cd "$ROOT"
    pnpm install --store-dir /tmp/plexer-proof-pnpm-store --frozen-lockfile >/tmp/plexer-proof-pnpm-install.log 2>&1
    pnpm run build >/tmp/plexer-proof-build.log 2>&1
    exec env \
      PORT="$PLEXER_PORT" \
      HOST=127.0.0.1 \
      CHRONIK_URL="$CHRONIK_URL" \
      CHRONIK_TOKEN="$TOKEN" \
      PLEXER_DATA_DIR="$PLEXER_DATA_DIR" \
      node dist/index.js
  ) >"$WORKDIR/plexer.log" 2>&1 &
  plexer_pid=$!
fi
wait_http "$PLEXER_URL/health" "Plexer"

HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
RUN_ID="plexer-runtime-usefulness-$(date +%s)-$$"
EVENT_ID="evt-$RUN_ID"
EVENT_PATH="$WORKDIR/event.json"
SEND_RESPONSE_PATH="$WORKDIR/send-response.json"
READBACK_PATH="$WORKDIR/chronik-readback.json"
DIAGNOSTICS_PATH="$WORKDIR/plexer-critical-sink.json"

python3 - "$EVENT_PATH" "$EVENT_ID" "$RUN_ID" "$BRANCH" "$HEAD_SHA" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, event_id, run_id, branch, head_sha = sys.argv[1:]
event = {
    "schema_version": "agent-run-event.v0",
    "event_id": event_id,
    "kind": "agent.run.completed",
    "ts": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "source": {
        "repo": "heimgewebe/grabowski",
        "component": "grabowski-proof-runner",
        "run_id": run_id,
    },
    "subject": {
        "repo": "heimgewebe/plexer",
        "branch": branch,
        "head": head_sha,
    },
    "trust_tier": "observed",
    "status": "active",
    "caused_by": [],
    "evidence_refs": [
        f"plexer-runtime-usefulness:{run_id}",
    ],
    "data": {
        "result": "completed",
        "summary": "Ephemeral runtime proof: Grabowski-shaped event reached Chronik through Plexer.",
        "duration_ms": 1,
    },
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(event, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
PY

send_code="$(curl -sS --max-time 5 -o "$SEND_RESPONSE_PATH" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data-binary "@$EVENT_PATH" \
  "$PLEXER_URL/v1/events")"
if [[ "$send_code" != "202" ]]; then
  echo "ERROR: Plexer returned HTTP $send_code" >&2
  cat "$SEND_RESPONSE_PATH" >&2 || true
  exit 1
fi

curl -fsS --max-time 5 -H "X-Auth: $TOKEN" \
  "$CHRONIK_URL/v1/events?domain=agent.ledger&limit=50" > "$READBACK_PATH"
curl -fsS --max-time 5 "$PLEXER_URL/diagnostics/critical-sink" > "$DIAGNOSTICS_PATH"

python3 - "$EVENT_PATH" "$READBACK_PATH" "$SEND_RESPONSE_PATH" "$DIAGNOSTICS_PATH" "$RECEIPT_PATH" "$started_at" "$RUNNER" "$CHRONIK_URL" "$PLEXER_URL" "$WORKDIR" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

event_path, readback_path, send_response_path, diagnostics_path, receipt_path, started_at, runner, chronik_url, plexer_url, workdir = sys.argv[1:]
event = json.loads(Path(event_path).read_text(encoding="utf-8"))
readback = json.loads(Path(readback_path).read_text(encoding="utf-8"))
send_response = json.loads(Path(send_response_path).read_text(encoding="utf-8"))
diagnostics = json.loads(Path(diagnostics_path).read_text(encoding="utf-8"))
matched = []
for item in readback.get("events", []):
    payload = item.get("payload") if isinstance(item, dict) else None
    candidate = payload if isinstance(payload, dict) else item
    if isinstance(candidate, dict) and candidate.get("event_id") == event["event_id"]:
        matched.append(candidate)

ok = bool(matched) and matched[0].get("kind") == "agent.run.completed" and send_response.get("status") == "accepted"
receipt = {
    "schema_version": 1,
    "proof": "plexer-runtime-usefulness-v1",
    "ok": ok,
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "runner": runner,
    "event_id": event["event_id"],
    "event_kind": event["kind"],
    "source_repo": event["source"]["repo"],
    "subject_repo": event["subject"]["repo"],
    "subject_head": event["subject"].get("head"),
    "send_response": send_response,
    "chronik_readback": {
        "matched": bool(matched),
        "events_returned": len(readback.get("events", [])),
        "meta": readback.get("meta"),
    },
    "plexer_diagnostics": {
        "status": diagnostics.get("status"),
        "critical_sink": diagnostics.get("critical_sink"),
        "configured": diagnostics.get("configured"),
        "queued": diagnostics.get("queued"),
        "retryable_now": diagnostics.get("retryable_now"),
        "status_basis": diagnostics.get("status_basis"),
        "active_probe": diagnostics.get("active_probe"),
    },
    "urls": {
        "chronik": chronik_url,
        "plexer": plexer_url,
    },
    "log_files": {
        "workdir": workdir,
        "chronik": f"{workdir}/chronik.log",
        "plexer": f"{workdir}/plexer.log",
    },
}
Path(receipt_path).write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(receipt, indent=2, sort_keys=True))
if not ok:
    raise SystemExit(1)
PY
