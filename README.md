# plexer

## Operator ecosystem correction

Plexer is the event gateway and delivery relay for bounded operational events in the new operator ecosystem. Chronik is the critical append-only sink for operational ledger events; Bureau owns tasks and claims; Grabowski owns local execution and receipts; Leitstand and hausKI are optional observers or consumers. The former Heimgeist fanout is retired: legacy Heimgeist configuration fields remain parse-compatible, but the runtime hard-disables that consumer and does not create new Heimgeist delivery attempts. Plexer is also not the only communication path.

Plexer ist das Event Gateway und Delivery Relay für begrenzte operative Ereignisse im Heimgewebe-Operator-Ökosystem.

- Nimmt Events über `POST /events` im Heimgewebe-Format entgegen
- Prüft Minimalstruktur (`type`, `source`, `payload`; `type`/`source` max. 256 Zeichen)
- Loggt eingehende Events
- Leitet erlaubte Legacy-Broadcasts best-effort an aktive konfigurierte Konsumenten weiter
- Liefert `agent.run.*` über `/v1/events` kritisch an Chronik `agent.ledger`
- Leitet **keine neuen Events mehr an Heimgeist** weiter

## Plexer v2 Richtung

Plexer wird als **Event Gateway und Delivery Relay** betrieben. Der Legacy-Endpunkt `/events` bleibt für kompatible Producer erhalten; die frühere Heimgeist-Sonderrolle ist jedoch beendet:

- Chronik ist die kritische append-only Senke für operative Ledger-Ereignisse.
- Plexer validiert, klassifiziert, queued und liefert aus.
- Leitstand und hausKI können Beobachter- oder Analyseflächen sein, nicht die primäre Wahrheit.
- Heimgeist ist kein aktiver Plexer-Consumer mehr.
- Grabowski und Bureau dürfen nicht von Plexer-Verfügbarkeit abhängen.
- Der erste v2-Scope bleibt bewusst klein: `agent.run.started`, `agent.run.completed`, `agent.run.blocked`.

Details: [`docs/architecture/plexer-v2-gateway.md`](docs/architecture/plexer-v2-gateway.md), [`docs/migration/plexer-v2-execution-plan.md`](docs/migration/plexer-v2-execution-plan.md) und [`docs/proofs/agent-run-proof-of-use.md`](docs/proofs/agent-run-proof-of-use.md).

Der wiederholbare Runtime-Nutzennachweis liegt in [`docs/proofs/runtime-usefulness-proof.md`](docs/proofs/runtime-usefulness-proof.md) und kann mit `pnpm run proof:runtime-usefulness` ausgeführt werden. Er prüft bewusst nur den engen Pfad `agent.run.* -> Plexer -> Chronik agent.ledger -> Read-back`; er ist kein Producer-Gate und keine Erweiterungsfreigabe für neue Eventfamilien.

## Scope

Plexer kümmert sich ausschließlich um **Eventtransport**.

Plexer tut:

- Events entgegennehmen (`POST /events`)
- Minimalstruktur prüfen
- Events protokollieren
- erlaubte Broadcast-Events an aktive Legacy-Konsumenten weiterreichen
- `/v1/events`: Chronik als kritische Senke nutzen und fehlgeschlagene `agent.ledger`-Zustellungen persistent retrybar halten
- historische Retry-Dateien weiterhin parse-kompatibel lesen

Plexer tut **nicht**:

- neue Heimgeist-Zustellungen oder Heimgeist-Retry-Einträge erzeugen
- PR-Kommentare entgegennehmen
- PR-Kommandos parsen
- mit der GitHub-API sprechen
- als Bot oder Reviewer agieren
- Chat- oder Dialogflüsse steuern

## Systemkontext

Der aktuelle Zweck, Lifecycle-Status und die Beziehungen dieses Repositories zu anderen
Heimgewebe-Systemen werden im [Systemkatalog](https://github.com/heimgewebe/systemkatalog) geführt. Die
[gerenderte Systemübersicht](https://github.com/heimgewebe/systemkatalog/blob/main/rendered/system-catalog.md)
ist die lesbare Gesamtsicht; die
[maschinenlesbare Inventur](https://github.com/heimgewebe/systemkatalog/blob/main/registry/ecosystem/nodes.json)
ist die Quelle für Automatisierung.

Repositoryeigene Betriebs-, Daten- und Implementierungswahrheit bleibt in diesem Repository.
Gemeinsame Contracts bleiben bei ihrer jeweiligen Primärquelle.

## Tooling

- Node.js >= 20
- pnpm (via Corepack)
- CI uses `pnpm/action-setup` to ensure consistent pnpm versions.

npm is not supported.

## Konfiguration

### Umgebungsvariablen

- `PORT` (default: 3000)
- `HOST` (default: `127.0.0.1`)
- `PLEXER_TOKEN`: Pflicht-Credential für `POST /events` und `POST /v1/events` (`Authorization: Bearer …`). Ohne Token bleibt Ingress fail-closed (`503`).
- `PLEXER_ALLOW_NON_LOOPBACK` (default: `false`): muss exakt `true` sein, wenn `HOST` nicht Loopback ist; zusätzlich ist ein aktives `PLEXER_TOKEN` erforderlich.
- `NODE_ENV` (default: development)
- `PLEXER_DATA_DIR`: Pfad zum Verzeichnis, in dem die Queue für fehlgeschlagene Events persistiert wird (default: `./data`).
  - **Hinweis für WGX:** Die Flow-Definition in `.wgx/flows.json` erwartet die Queue unter `data/failed_forwards.jsonl`. Wenn `PLEXER_DATA_DIR` geändert wird, muss der Flow-Pfad angepasst oder ein Symlink verwendet werden.

### Reliability & Performance

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `RETRY_CONCURRENCY` | `5` | Anzahl gleichzeitiger Forward-Versuche beim Retry. Erhöht den Durchsatz, belastet aber Zielsysteme stärker. |
| `RETRY_BATCH_SIZE` | `50` | Maximale Anzahl gleichzeitig aktiver Retry-Tasks im Sliding Window (Backpressure Control). Empfehlung: `RETRY_BATCH_SIZE >= RETRY_CONCURRENCY`. |
| `PLEXER_INGRESS_RATE_WINDOW_MS` | `60000` | Festes Rate-Limit-Fenster; `429` liefert die deterministische Restzeit via `Retry-After`. |
| `PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT` | `120` | Requests pro direkter Client-Adresse und Fenster. |
| `PLEXER_INGRESS_GLOBAL_RATE_LIMIT` | `1200` | Globale Requests pro Fenster. |
| `PLEXER_INGRESS_PER_CLIENT_MAX_IN_FLIGHT` | `8` | Gleichzeitige Ingress-Arbeiten pro Client. |
| `PLEXER_INGRESS_GLOBAL_MAX_IN_FLIGHT` | `64` | Globale gleichzeitige Ingress-Arbeiten. |
| `PLEXER_INGRESS_MAX_CLIENTS` | `1024` | Harte Obergrenze der im Speicher gehaltenen Client-Zähler. |
| `FAILED_FORWARDS_MAX_BYTES` | `16777216` | Harte Byte-Gesamtgrenze über aktive Queue und Retry-Archive. |
| `FAILED_FORWARDS_MAX_ENTRIES` | `10000` | Harte Eintrags-Gesamtgrenze über aktive Queue und Retry-Archive. |
| `FAILED_FORWARDS_MAX_AGE_MS` | `604800000` | Maximales Alter seit `lastAttempt`; ältere Einträge werden deterministisch verworfen. |

### Service-URLs & Authentifizierung

Alle URL-Variablen müssen vollqualifiziert sein (inkl. Schema `https://…`).

| Service | URL Variable | Token Variable | Auth Methode |
|---------|--------------|----------------|--------------|
| **Chronik** | `CHRONIK_URL` | `CHRONIK_TOKEN` | `X-Auth: <token>` |
| **Leitstand** | `LEITSTAND_URL` | `LEITSTAND_TOKEN` | `Authorization: Bearer <token>` |
| **hausKI** | `HAUSKI_URL` | `HAUSKI_TOKEN` | `Authorization: Bearer <token>` |

`HEIMGEIST_URL` und `HEIMGEIST_TOKEN` werden aus Kompatibilitätsgründen noch geparst, besitzen aber **keine Aktivierungswirkung**. Die Runtime setzt `legacyHeimgeistForwarding` hart auf `false`; es existiert absichtlich kein Environment-Schalter zum Wiedereinschalten.

Plexer wendet automatisch den korrekten Auth-Header je nach aktivem Zielsystem an.

## Reliability & Contracts

### Persistence & Queue
Plexer nutzt eine persistente, dateibasierte Queue (`failed_forwards.jsonl`), erstklassige Retry-Archive (`processing.*.jsonl`) und atomar geclaimte `retrying.*.jsonl`-Dateien, um Events auch bei temporären Ausfällen kritischer Ziele zuzustellen. Byte-, Eintrags- und Altersgrenzen gelten atomar über aktive Datei, Archive und Claims. Bestehende Retry-Daten haben Vorrang; neue Einträge werden an der exakten Quota-Grenze explizit abgelehnt. Beim Start werden korrupte/abgelaufene Zeilen entfernt, Crash-Claims wieder retrybar gemacht und ein vorbestehender Überhang in stabiler Datei-/Zeilenreihenfolge gekürzt. Retry ersetzt seinen Claim nur in-place und nur ohne Wachstum; bei Fehler bleibt das Original erhalten. Historische Heimgeist-Einträge dürfen für Recovery/Inspektion parse-kompatibel bleiben; der Live-Fanout erzeugt keine neuen. Details und Producer-Migration: [`docs/ingress-security-and-retention.md`](docs/ingress-security-and-retention.md).

### Critical Consumer vs. Best-Effort
Aktuelle Policy: `/v1/events` nutzt Chronik als kritische Senke für operative Ledger-Ereignisse. Der frühere kritische Heimgeist-Kompatibilitätsconsumer von `/events` ist hart deaktiviert.

1. **Chronik (`/v1/events`)**:
   - Kritische Senke für `agent.ledger`.
   - Retrybare Zustellfehler werden persistent gequeued.

2. **Legacy-Broadcast-Konsumenten (`/events`)**:
   - Leitstand, hausKI und Chronik werden nur für explizite Broadcast-Eventtypen berücksichtigt.
   - Fehlschläge werden geloggt, aber **nicht** als Heimgeist-Kompatibilitätsqueue fortgeschrieben.
   - Unbekannte Legacy-Eventtypen haben nach dem Heimgeist-Cutover keinen impliziten Auffangkonsumenten mehr.

3. **Heimgeist**:
   - Kein aktiver Consumer.
   - `HEIMGEIST_URL`/`HEIMGEIST_TOKEN` können die Zustellung nicht reaktivieren.
   - Bestehende historische Queue-Daten bleiben lesbar, bis sie regulär terminalisiert oder bereinigt werden.

### Contracts Ownership
Die verwendeten Schemas zur Validierung von Queue-Einträgen und Status-Reports liegen in `src/vendor/schemas/`.
**Wichtig:** Diese Dateien sind Kopien (Vendoring) der kanonischen Definitionen aus dem **Metarepo** (`heimgewebe/metarepo/contracts/plexer/`). Änderungen dürfen nicht hier, sondern nur im Metarepo erfolgen und müssen dann synchronisiert werden.

## Security & Logging

Plexer ist **Functionality-first** ausgelegt: Zustellung und Robustheit stehen im Vordergrund. Um Datenabfluss zu vermeiden, gelten dabei folgende Schutzmaßnahmen:
- Beide schreibenden Ingress-Routen verlangen `Authorization: Bearer $PLEXER_TOKEN`; `X-Auth` wird dort nicht akzeptiert. Auth-Prüfung verwendet fixed-length constant-time comparison und läuft vor JSON-Parsing.
- Standard-Bind ist `127.0.0.1`. Non-Loopback benötigt explizites `PLEXER_ALLOW_NON_LOOPBACK=true` und aktives Auth.
- Rate-Limits und In-flight-Backpressure sind pro direkter Client-Adresse und global begrenzt; `429` ist mit `Retry-After` deterministisch retrybar.
- Eingehende Event-Payloads werden nicht geloggt; geloggt werden nur Metadaten sowie `payload_size` und `payload_size_kind` (wenn berechenbar/sonst unavailable).
- Tokens und Authorization-Header werden nie geloggt.
- Fehlgeschlagene kritische Events werden lokal gepuffert (Queue-Datei im `dataDir`). Der Betrieb muss sicherstellen, dass dieses Verzeichnis geschützt ist (z. B. Dateirechte oder verschlüsseltes Volume).

## Observability

- `GET /status`: Liefert Metriken zur Delivery-Queue.
  - Payload folgt dem Contract: `plexer.delivery.report.v1`.
  - Felder: `pending` (in-flight), `failed` (in queue), `retryable_now` (fällig), `next_due_at` (nächster Retry).
- `GET /health`: Liveness. Solange der Prozess läuft, `200 {"status":"ok"}`. Reflektiert **nicht** den Zustand nachgelagerter Konsumenten.
- `GET /readiness`: **Operator-Probe** für die **kritische** Chronik-Senke (`agent.ledger`) — bewusstes `curl -f`/Uptime-Signal, **kein** Infrastruktur-`readinessProbe` (dafür `/health`; für Dashboards `/diagnostics/critical-sink`). Zeigt die kritische Teilmenge der Queue isoliert von Best-Effort-/Legacy-Fehlern.
  - `status`: `ready` (Senke konfiguriert, keine gequeuten agent.ledger-Events), `degraded` (konfiguriert, aber agent.ledger-Events warten) oder `unconfigured` (kein `CHRONIK_URL`).
  - HTTP: `200` bei `ready`, sonst `503` — damit ein `curl -f`/Uptime-Probe eine Beeinträchtigung des kritischen Pfads sichtbar macht.
  - Response-Felder (alle): `status`, `critical_sink`, `status_basis`, `active_probe`, `configured`, `queued`, `retryable_now`, `next_due_at`, `due_now`, `last_error`, `last_delivered_at`.
  - **`status_basis: "queue_state"` / `active_probe: false`:** Der Status wird aus Plexers **lokalem Queue-Zustand** abgeleitet, **nicht** aus einem aktiven Erreichbarkeits-Check gegen Chronik. `ready` heißt „kein agent.ledger-Rückstau gepuffert", **nicht** „Chronik ist erreichbar".
  - `retryable_now` ist die Anzahl fälliger kritischer Einträge **zum Zeitpunkt des letzten Queue-Scans** (Snapshot, kann nachlaufen). `due_now` wird dagegen **live** aus `next_due_at` berechnet und zeigt auch zwischen Retry-Läufen an, ob der nächste Retry bereits fällig ist.
  - `last_error` ist der Fehler eines **aktuell offenen** kritischen Queue-Eintrags — bevorzugt der des zuletzt versuchten (`lastAttempt`) offenen Eintrags. Er wird aus der Queue rekonstruiert (auch nach Neustart) und bei leerer kritischer Queue bereinigt (`null`). Type-safe: nicht-String-Fehler korrupter Zeilen werden nie zu `last_error`.
  - `last_delivered_at` ist **prozesslokal** und wird nach einem Neustart nicht aus persistenter Historie rekonstruiert (Prozessdiagnose).
  - `configured` prüft bewusst nur `CHRONIK_URL` (Senke „verdrahtet"). Ein fehlendes `CHRONIK_TOKEN` ist ein Auth-Detail und äußert sich als `degraded` (401 → gequeued), nicht als `unconfigured`.
  - **Abgrenzung (Doktrin):** `/readiness` ist Plexers eigenes Diagnostik-Signal, **nicht** der `plexer.delivery.report.v1`-Contract, **kein Producer-Gate** und **kein Kubernetes-/Load-Balancer-`readinessProbe`**. Für Infrastruktur-Liveness/Traffic-Gating ist `/health` zu verwenden; `/readiness` ist ausschließlich Operator-/Leitstand-Diagnostik (bewusstes `curl -f`/Uptime-Probe-Signal). Ein `degraded`/`unconfigured` Zustand heißt nicht, dass Producer aufhören sollen zu senden oder Plexer aus der Rotation genommen werden soll — Plexer puffert die operativen Events weiter für den Retry (Relay degradiert, ohne die Task-Wahrheit zu ändern).
- `GET /diagnostics/critical-sink`: **Kanonischer Dashboard-Endpunkt** mit demselben Payload wie `/readiness`, aber **immer HTTP 200** (Status nur im Body). Für Standard-Monitoring, das nicht durch den `503` von `/readiness` fälschlich Traffic-Gating auslösen darf. Wahl der Endpunkte: `/health` = Infra-Liveness, `/diagnostics/critical-sink` = Dashboard/Monitoring (200), `/readiness` = bewusstes Probe-Signal (200/503).
