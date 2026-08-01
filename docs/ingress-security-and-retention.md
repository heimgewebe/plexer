# Ingress security, producer migration, and failed-forward retention

`POST /events` and `POST /v1/events` require the same ingress credential:

```http
Authorization: Bearer <PLEXER_TOKEN>
```

Authentication is fail-closed. If `PLEXER_TOKEN` is unset, both routes return a
retryable `503`; a missing, malformed, or incorrect Bearer credential returns
`401` with `WWW-Authenticate: Bearer`. `X-Auth` is not an ingress compatibility
path: the local producer audit found established Bearer clients and no Plexer
producer that required `X-Auth`. Authentication runs before JSON parsing, and
credentials and headers are never included in logs.

The listener defaults to `127.0.0.1`. Any other literal host, including
`0.0.0.0`, `::`, a LAN address, or a hostname, requires both
`PLEXER_ALLOW_NON_LOOPBACK=true` and a non-empty `PLEXER_TOKEN`; otherwise
configuration fails before `listen()`.

## Admission and retry contract

Rate admission uses the direct socket address (Express proxy trust remains off)
as the bounded client/source key. Fixed-window per-client and global totals are
applied before body parsing. Per-client and global in-flight caps are applied
after payload/schema validation and before downstream work. The client-state map
has a hard maximum; a new key is rejected while all tracked windows are live
rather than evicting counters and enabling a bypass.

All rate, client-capacity, and in-flight rejections return `429`, an integer
`Retry-After` header, and a JSON body with `retryable: true` and the same
`retry_after_seconds`. Producers must retry no earlier than that delay. `401` is
a configuration error and must not be retried without changing credentials.

## Producer audit and required updates

The machine-readable audit is
[`docs/contracts/ingress-producer-contract.v1.json`](contracts/ingress-producer-contract.v1.json).

- The in-repo runtime proof now starts Plexer with `PLEXER_TOKEN` and sends the
  Bearer header. The manual proof contract was updated the same way.
- The audited metarepo reusable workflow and WGX emitter already construct
  `Authorization: Bearer $PLEXER_TOKEN`; deployments must now provision the
  token because anonymous fallback is no longer accepted.
- Grabowski's audited outbox producer currently sends only `Content-Type`.
  Grabowski is intentionally not edited on this branch. Its follow-up must add
  `GRABOWSKI_PLEXER_TOKEN`, send
  `Authorization: Bearer $GRABOWSKI_PLEXER_TOKEN`, preserve `429` as retryable,
  treat `401` as a configuration failure, and add
  `test_send_event_posts_bearer_token_to_plexer` to assert the header without
  printing the token.

## Failed-forward hard totals

The persistent store counts `failed_forwards.jsonl` plus every
`processing.*.jsonl` archive and temporary `retrying.*.jsonl` claim as one
quota. Defaults are 16 MiB, 10,000
non-empty records, and seven days since `lastAttempt`.

- Existing archive records have priority. New failures are accepted in arrival
  order only when both the byte and entry total remain at or below the configured
  boundary; otherwise persistence returns an explicit `quota` rejection.
- Startup scans active and archive files in deterministic archive-age/name and
  line order. Corrupt/oversized records and records older than the age limit are
  discarded. If a pre-hardening store is still over byte/entry quota, the stable
  tail is evicted until the total is within bounds.
- Rotation renames the active file into a first-class archive without changing
  the total. A retry atomically renames one archive to `retrying.*` so another
  process cannot claim it; crash-orphaned claims become archives again on
  startup. Concurrent appends continue in a new active file. A retry replaces
  its claim in place and may only preserve or shrink its claimed bytes and
  entries. If replacement fails, the original claim is returned to the archive
  set intact for a later retry/restart.
- `/v1/events` returns retryable `503` instead of claiming `queued` when durable
  persistence is rejected or unavailable. Legacy `/events` remains detached for
  compatibility; a later downstream queue rejection is logged with metadata
  only and never silently counted as persisted.

Configuration variables:

| Variable | Default |
| --- | ---: |
| `PLEXER_INGRESS_RATE_WINDOW_MS` | `60000` |
| `PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT` | `120` |
| `PLEXER_INGRESS_GLOBAL_RATE_LIMIT` | `1200` |
| `PLEXER_INGRESS_PER_CLIENT_MAX_IN_FLIGHT` | `8` |
| `PLEXER_INGRESS_GLOBAL_MAX_IN_FLIGHT` | `64` |
| `PLEXER_INGRESS_MAX_CLIENTS` | `1024` |
| `FAILED_FORWARDS_MAX_BYTES` | `16777216` |
| `FAILED_FORWARDS_MAX_ENTRIES` | `10000` |
| `FAILED_FORWARDS_MAX_AGE_MS` | `604800000` |
