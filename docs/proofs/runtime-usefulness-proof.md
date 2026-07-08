# Plexer runtime usefulness proof

Status: active proof runner
Owner repo: `heimgewebe/plexer`
Created: 2026-07-08

## Purpose

This proof keeps Plexer constrained to its useful role: delivery relay, not source of truth.
It verifies the smallest practical value chain:

```text
Grabowski-shaped agent.run.completed event
  -> Plexer POST /v1/events
  -> Chronik POST /v1/ingest?domain=agent.ledger
  -> Chronik GET /v1/events?domain=agent.ledger read-back
```

The proof is intentionally not a new event family and not a producer gate.
Grabowski and Bureau must stay safe when Plexer is unavailable.

## Command

From the Plexer checkout:

```bash
scripts/prove-runtime-usefulness.sh
```

Useful options:

```bash
scripts/prove-runtime-usefulness.sh --receipt /tmp/plexer-runtime-usefulness.receipt.json
scripts/prove-runtime-usefulness.sh --keep-workdir
scripts/prove-runtime-usefulness.sh --runner docker
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHRONIK_REPO` | `/home/alex/repos/chronik` | Local Chronik checkout used for the ephemeral proof. |
| `PLEXER_PROOF_RUNNER` | `docker` | `docker` uses `node:20.19.0-alpine`; `host` uses local Node/pnpm. |
| `PLEXER_PROOF_RECEIPT` | `data/proofs/runtime-usefulness.receipt.json` | Receipt output path. `data/` is ignored. |

## What it proves

The receipt is valid when all of these are true:

- Chronik starts with a temporary token and temporary data directory.
- Plexer starts with `CHRONIK_URL` and `CHRONIK_TOKEN` pointing at that Chronik instance.
- Plexer accepts the event with HTTP `202` and `{"status":"accepted"}`.
- Chronik read-back contains the same `event_id` in `agent.ledger`.
- Plexer critical-sink diagnostics report the sink as configured and queue-backed.

## What it does not prove

- It does not prove that Plexer should become a broad event bus.
- It does not prove task completion truth; Bureau still owns that.
- It does not prove execution authority; Grabowski still owns that.
- It does not prove persistent production service health; it starts only ephemeral local processes.

## Operational interpretation

Use this proof before expanding Plexer beyond `agent.run.started`, `agent.run.completed`, and
`agent.run.blocked`.

Expansion is justified only if a real Bureau, Chronik or Leitstand consumer uses the read-back to
improve a diagnosis or decision. Otherwise the event trail is only duplicate operational noise.
