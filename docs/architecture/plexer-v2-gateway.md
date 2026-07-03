# Plexer v2 Gateway Doctrine

Status: draft
Owner repo: `heimgewebe/plexer`
Created: 2026-07-03

## These / Antithese / Synthese

**These:** Plexer should no longer be treated as a narrow Heimgeist event router. Heimgewebe needs a runtime edge for small operational events, agent-run receipts, delivery status and observer fanout.

**Antithese:** Plexer must not become the ledger, orchestrator, reviewer, task dispatcher or semantic source of truth. Chronik owns append-only history, Bureau owns commitments, Grabowski owns local execution, and metarepo owns canonical contracts.

**Synthese:** Plexer v2 is the event gateway and delivery relay: it accepts small operational events, validates and classifies them, queues critical delivery and forwards to Chronik plus optional observers.

## Role

Plexer v2 does:

- accept operational events from configured producers;
- validate envelope shape and size limits;
- apply outbound allow-list rules;
- queue critical delivery to Chronik when Chronik is unavailable;
- fan out non-critical observer notifications to Heimgeist, Leitstand and hausKI;
- expose bounded delivery status;
- keep legacy `/events` support during migration.

Plexer v2 does not:

- claim Bureau tasks;
- parse PR commands;
- decide merge readiness;
- store long logs or copied evidence bodies;
- replace Chronik as append-only event store;
- define canonical event contracts outside the agreed contract owner.

## System boundaries

| Organ | Responsibility | Boundary |
| --- | --- | --- |
| Plexer | Gateway, validation, allow-list, delivery, queue, fanout | no orchestration or truth ownership |
| Chronik | Append-only ledger and event query | no decisions or task claims |
| metarepo/contracts | Contract governance and canonical schemas | no runtime delivery |
| Grabowski | Local operator, runtime leases, durable receipts and audit | execution must stay safe without Plexer |
| Bureau | Commitments, tasks, claims, dispatch and completion | not an event bus |
| Leitstand | Views, digests and dashboards | not a primary store |
| Heimgeist | Analysis and meta-agent interpretation | not the audit sink |
| hausKI | AI consumer and assistant surface | not a gatekeeper |

## Delivery doctrine

Chronik is the primary critical sink for operational ledger events. Delivery to Chronik must be retried or queued. Observer fanout may be best-effort unless a later contract states otherwise.

Initial delivery classes:

| Class | Example | Critical sink | Observer sinks | Failure behavior |
| --- | --- | --- | --- | --- |
| operational-ledger | `agent.run.completed` | Chronik `agent.ledger` | optional | queue and retry Chronik |
| status-signal | `plexer.delivery.report.v1` | none or Chronik later | Leitstand/Heimgeist | best-effort |
| legacy-router | old `{type, source, payload}` events | existing behavior during migration | existing behavior | preserve compatibility |

## Event scope v0

Plexer v2 starts deliberately small. It transports only the existing agent-run ledger family as the first operational class:

- `agent.run.started`
- `agent.run.completed`
- `agent.run.blocked`

Out of scope for the first slice:

- `repo.pr.*`
- `review.finding.*`
- `bureau.claim.*`
- `artifact.bundle.*`
- `friction.recorded`
- embedded evidence text
- unbounded nested payloads

Expansion requires a demonstrated consumer benefit, not only producer convenience.

## Chronik contract alignment

The initial critical delivery target is Chronik:

```text
POST /v1/ingest?domain=agent.ledger
```

Plexer does not make the storage domain part of the event payload. It delivers to Chronik with an explicit query-domain and keeps event payloads small.

## Migration principle

The v1 endpoint stays available while v2 is introduced. Legacy events are not silently reinterpreted as ledger events. A producer must opt into the v2 operational path.

## Success criteria

Plexer v2 is successful only if it improves a later decision or diagnosis. The first proof is a real Grabowski or Bureau agent-run event that can be read back through Chronik and used by an operator, Bureau view or Leitstand digest.

## Kill criteria

Freeze expansion if the first operational event family produces only noise, duplicate logs or unused history. An unread ledger is just bureaucracy with timestamps.
