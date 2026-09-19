# Operator ecosystem alignment

Plexer is the event gateway and delivery relay for bounded operational events.

- V2 operational events use Chronik as the critical append-only sink.
- Legacy `/events` compatibility preserves the envelope only; unknown events have no implicit deleted-consumer fallback.
- Bureau owns tasks and claims; Plexer must not claim or dispatch them.
- Grabowski owns local execution and must remain safe without Plexer.
- Leitstand is the surviving observer surface. Heimgeist and hausKI are historical retired targets and cannot be activated by legacy configuration.

Plexer is not the only communication path. Contracts, GitHub/CI, direct artifact reads and Chronik queries remain valid when they preserve clearer evidence.