# Operator ecosystem alignment

Plexer is the event gateway and delivery relay for bounded operational events.

- V2 operational events use Chronik as the critical append-only sink.
- Legacy `/events` compatibility may still route unknown events to Heimgeist.
- Bureau owns tasks and claims; Plexer must not claim or dispatch them.
- Grabowski owns local execution and must remain safe without Plexer.
- Leitstand, Heimgeist and hausKI are observers or consumers unless a separate contract says otherwise.

Plexer is not the only communication path. Contracts, GitHub/CI, direct artifact reads and Chronik queries remain valid when they preserve clearer evidence.
