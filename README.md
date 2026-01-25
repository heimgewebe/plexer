# plexer

Plexer ist das Ereignisnetz (Event Router) für den Heimgewebe-Organismus.

- Nimmt Events über `POST /events` im Heimgewebe-Format entgegen
- Prüft Minimalstruktur (`type`, `source`, `payload`; `type`/`source` max. 256 Zeichen)
- Loggt eingehende Events
- Leitet sie an Heimgeist und weitere konfigurierte Konsumenten (Chronik, Leitstand, hausKI) weiter

## Scope

Plexer kümmert sich ausschließlich um **Eventtransport**.

Plexer tut:

- Events entgegennehmen (`POST /events`)
- Minimalstruktur prüfen
- Events protokollieren
- Events an Konsumenten weiterreichen (Fanout-Pattern)
- Fehlgeschlagene Weiterleitungen an **Heimgeist** zwischenpuffern und wiederholen (Reliability)

Plexer tut **nicht**:

- PR-Kommentare entgegennehmen
- PR-Kommandos parsen
- mit der GitHub-API sprechen
- als Bot oder Reviewer agieren
- Chat- oder Dialogflüsse steuern

## Organismus-Kontext

Dieses Repository ist Teil des **Heimgewebe-Organismus**.

Die übergeordnete Architektur, Achsen, Rollen und Contracts sind zentral beschrieben im  
👉 [`metarepo/docs/heimgewebe-organismus.md`](https://github.com/heimgewebe/metarepo/blob/main/docs/heimgewebe-organismus.md)  
sowie im Zielbild  
👉 [`metarepo/docs/heimgewebe-zielbild.md`](https://github.com/heimgewebe/metarepo/blob/main/docs/heimgewebe-zielbild.md).

## Tooling

- Node.js >= 20
- pnpm (via Corepack)

npm is not supported.

## Konfiguration

### Umgebungsvariablen

- `PORT` (default: 3000)
- `HOST` (default: 0.0.0.0)
- `NODE_ENV` (default: development)
- `PLEXER_DATA_DIR`: Pfad zum Verzeichnis, in dem die Queue für fehlgeschlagene Events persistiert wird (default: `./data`).
  - **Hinweis für WGX:** Die Flow-Definition in `.wgx/flows.json` erwartet die Queue unter `data/failed_forwards.jsonl`. Wenn `PLEXER_DATA_DIR` geändert wird, muss der Flow-Pfad angepasst oder ein Symlink verwendet werden.

### Service-URLs & Authentifizierung

Alle URL-Variablen müssen vollqualifiziert sein (inkl. Schema `https://…`).

| Service | URL Variable | Token Variable | Auth Methode |
|---------|--------------|----------------|--------------|
| **Heimgeist** | `HEIMGEIST_URL` | `HEIMGEIST_TOKEN` | `X-Auth: <token>` |
| **Chronik** | `CHRONIK_URL` | `CHRONIK_TOKEN` | `X-Auth: <token>` |
| **Leitstand** | `LEITSTAND_URL` | `LEITSTAND_TOKEN` | `Authorization: Bearer <token>` |
| **hausKI** | `HAUSKI_URL` | `HAUSKI_TOKEN` | `Authorization: Bearer <token>` |

Plexer wendet automatisch den korrekten Auth-Header je nach Zielsystem an.

## Reliability & Contracts

### Persistence & Queue
Plexer nutzt eine persistente, dateibasierte Queue (`failed_forwards.jsonl`), um Events auch bei temporären Ausfällen der Konsumenten zuzustellen. Die Verarbeitung erfolgt thread-safe über `proper-lockfile` (Locking auf `failed_forwards.lock`), sodass mehrere Prozesse oder Neustarts keine Datenkorruption verursachen.

### Critical Consumer vs. Best-Effort
Current policy: only Heimgeist is critical; others are best-effort by design, may evolve.

Die Unterscheidung erfolgt primär anhand des Konsumenten und sekundär per Event-Override:

1. **Heimgeist (Critical Consumer)**:
   - Zielsystem für persistente Datenhaltung.
   - Events, die an Heimgeist nicht zugestellt werden können, werden **gequeued** und via Exponential Backoff wiederholt.
   - Ausnahme: Events in `BEST_EFFORT_EVENTS` (z.B. `integrity.summary.published.v1`) werden auch für Heimgeist nicht gequeued.

2. **Andere Konsumenten (Leitstand, hausKI, Chronik)**:
   - **Fire-and-Forget / Best-Effort**.
   - Fehlschläge werden geloggt (als Warning), aber **niemals gequeued**.
   - Dies verhindert, dass ein einzelner langsamer Konsument den Plexer blockiert oder die Queue füllt.

3. **Best-Effort Events Override**:
   - Events wie `integrity.summary.published.v1` (Pull-based hints) oder `plexer.delivery.report.v1` (Ephemeral Status) sind in `BEST_EFFORT_EVENTS` definiert.
   - Diese werden **niemals** gequeued, auch nicht für Heimgeist.

### Contracts Ownership
Die verwendeten Schemas zur Validierung von Queue-Einträgen und Status-Reports liegen in `src/vendor/schemas/`.
**Wichtig:** Diese Dateien sind Kopien (Vendoring) der kanonischen Definitionen aus dem **Metarepo** (`heimgewebe/metarepo/contracts/plexer/`). Änderungen dürfen nicht hier, sondern nur im Metarepo erfolgen und müssen dann synchronisiert werden.

## Observability

- `GET /status`: Liefert Metriken zur Delivery-Queue.
  - Payload folgt dem Contract: `plexer.delivery.report.v1`.
  - Felder: `pending` (in-flight), `failed` (in queue), `retryable_now` (fällig), `next_due_at` (nächster Retry).
