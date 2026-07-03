# Agent-run Proof of Use

Status: draft
Owner repo: `heimgewebe/plexer`
Created: 2026-07-03

## Purpose

This proof verifies that the Plexer v2 ingress is useful beyond accepting HTTP requests. A small `agent.run.completed` event must enter Plexer, be delivered to Chronik `agent.ledger`, and be readable back by an operator or downstream view.

## Boundaries

This proof uses only the first allowed event family:

- `agent.run.started`
- `agent.run.completed`
- `agent.run.blocked`

It does not introduce PR, review, Bureau, bundle or friction event families.

## Organs involved

| Organ | Role in proof | Boundary |
| --- | --- | --- |
| Grabowski | Producer identity for the fixture event | no dependency on Plexer for safe execution |
| Plexer | Bounded ingress and delivery relay | no ledger ownership |
| Chronik | Append-only storage and read-back | no orchestration |
| Leitstand or Bureau | Optional later consumer of the read-back | not required for this proof |

## Fixture

Use:

```text
./docs/fixtures/agent-run-completed.v1.json
```

The fixture is intentionally small and contains only bounded strings, a short evidence reference and a primitive `data` object.

## Preflight

Required environment:

```sh
: "${PLEXER_URL:?set PLEXER_URL, for example http://localhost:3000}"
: "${CHRONIK_URL:?set CHRONIK_URL, for example http://localhost:4000}"
```

Plexer must be configured with `CHRONIK_URL` and, if required by the target, `CHRONIK_TOKEN`.

## Send through Plexer

```sh
curl -sS \
  -H 'Content-Type: application/json' \
  --data-binary @docs/fixtures/agent-run-completed.v1.json \
  "$PLEXER_URL/v1/events"
```

Expected response when Chronik delivery succeeds:

```json
{"status":"accepted"}
```

Expected response when Chronik is temporarily unavailable or misconfigured:

```json
{"status":"queued","retryable":true}
```

A queued response is not proof of delivery. It is only proof that Plexer preserved the operational event for retry.

## Read back through Chronik

Use Chronik's agent ledger domain:

```sh
curl -sS "$CHRONIK_URL/v1/events?domain=agent.ledger"
```

The proof is satisfied only when the response contains the fixture event id:

```text
evt-agent-run-proof-0001
```

## Success criteria

The proof passes when all of the following hold:

1. Plexer accepts or queues the fixture event.
2. Chronik eventually exposes the event through `domain=agent.ledger`.
3. The read-back contains `kind=agent.run.completed` and `event_id=evt-agent-run-proof-0001`.
4. No raw logs, copied tool output or broad nested payloads are introduced.

## Failure handling

- `422`: the fixture no longer matches the first-slice allow-list; update the fixture or the documented contract, not both silently.
- `413`: the fixture exceeded the ingress size limit; reduce the fixture.
- `502`: Chronik rejected the event as permanent failure; inspect Chronik's validation error.
- `202 queued`: run the retry worker or restore Chronik config, then perform read-back.

## Next step after proof

Only after a successful read-back should a Grabowski producer adapter be considered. The adapter must remain optional: Grabowski execution must not depend on Plexer availability.
