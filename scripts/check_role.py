#!/usr/bin/env python3
from pathlib import Path
import sys
text = Path('.ai-context.yml').read_text(encoding='utf-8')
need = [
    '  role: event_gateway_delivery_relay',
    'role_contract:',
    '  name: event_gateway_delivery_relay',
    '  authority: delivery_routing',
    '  unavailable_effect: relay_degrades_without_changing_task_truth',
    '    - no_ledger_ownership',
    '    - no_worker_control',
]
for item in need:
    if item not in text:
        print(f'role-contract: missing {item!r}', file=sys.stderr)
        raise SystemExit(1)
if '  role: event_gateway\n' in text:
    print('role-contract: stale event_gateway role', file=sys.stderr)
    raise SystemExit(1)
print('role-contract: OK plexer')
