# Plexer v2 Execution Plan

Status: active-plan
Owner repo: `heimgewebe/plexer`
Created: 2026-07-03

## Objective

Rebuild Plexer in place as the Heimgewebe event gateway and delivery relay. Plexer must stay transport-oriented: Chronik remains the ledger, Bureau owns task commitments, Grabowski owns local execution, and metarepo owns schemas.

## Sequence

### PR 1: Doctrine and migration frame

- add the Plexer v2 doctrine;
- update README scope language;
- update `.ai-context.yml`;
- keep runtime code unchanged.

### PR 2: Chronik delivery seam

- add a small Chronik delivery client;
- target `POST /v1/ingest?domain=agent.ledger`;
- keep legacy fanout behavior intact;
- test success, failure and queued retry intent.

### PR 3: New `/v1/events` ingress

- add the v2 endpoint;
- accept only bounded operational events for the first slice;
- keep old `/events` as compatibility path.

### PR 4: First allow-list

- support only `agent.run.started`, `agent.run.completed`, `agent.run.blocked`;
- keep event bodies small;
- reject unbounded or unrelated payload shapes.

### PR 5: Grabowski proof-of-use

- publish one real or fixture-backed `agent.run.completed` event;
- keep Grabowski execution independent from Plexer;
- document read-back through Chronik.

### PR 6: Usefulness check

- show that the event changed an operator, Bureau or Leitstand decision;
- expand event families only after that proof.

## Expansion candidates after proof

- `repo.review.gate.v1`
- `rlens.bundle.emitted.v1`
- `bureau.task.transition.v1`
- `grabowski.friction.recorded.v1`

## Risk controls

- no broad event taxonomy in the first slice;
- Chronik remains the ledger;
- Plexer keeps legacy compatibility until consumers migrate;
- Grabowski and Bureau safety must not depend on Plexer availability.

## Local validation note

The current local Node/Jest environment may require `NODE_OPTIONS=--jitless` for diagnostics. Treat native environment failures separately from Plexer code failures.
