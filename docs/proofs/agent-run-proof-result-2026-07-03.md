# Agent-run Proof Result — 2026-07-03

Status: passed
Owner repo: `heimgewebe/plexer`
Related proof: `docs/proofs/agent-run-proof-of-use.md`
Related fixture: `docs/fixtures/agent-run-completed.v1.json`

## Summary

The first Plexer v2 proof-of-use passed.

Observed result:

- Plexer accepted the fixture through `POST /v1/events`.
- Chronik `agent.ledger` read-back contained `evt-agent-run-proof-0001`.
- Chronik `agent.ledger` read-back contained `agent.run.completed`.

## Environment

Chronik ran locally from `/home/alex/repos/chronik` with its existing `.venv`, a temporary data directory and a temporary local token.

Plexer ran from `/home/alex/repos/plexer` inside the already-present Docker image `node:20.19.0-alpine`, using host networking and a temporary data directory.

The container runtime was required because the heim-pc host Node runtime is not reliable for this proof:

- normal Node 22 crashes with a V8 executable-memory failure;
- `--jitless` starts the HTTP server but breaks Undici/fetch because WebAssembly is unavailable.

## Evidence

Send response:

```json
{"status":"accepted"}
```

Read-back predicates:

```text
evt-agent-run-proof-0001 present
agent.run.completed present
```

## Cleanup

Temporary Plexer and Chronik processes were stopped after the proof. No persistent service configuration was changed.

## Result

Proof passed.

Plexer v2 can accept a bounded `agent.run.completed` event, deliver it to Chronik `agent.ledger`, and make it available for operator read-back.

## Next step

A future Grabowski producer adapter can now be considered, but it must remain optional. Grabowski execution must not depend on Plexer availability.
