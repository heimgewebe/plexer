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
- Fehlgeschlagene Weiterleitungen zwischenpuffern und wiederholen (Reliability)

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

### Critical vs. Best-Effort Events
Die Unterscheidung erfolgt derzeit basierend auf der Konstantenliste in `src/constants.ts`:

- **Critical Events** (z.B. `knowledge.observatory.published.v1`, `insights.daily.published`): Werden bei Fehlschlag in der Queue gespeichert und mit exponential backoff wiederholt.
- **Best-Effort Events** (z.B. `integrity.summary.published.v1`): Dienen primär als optionale Hinting-Signale für Pull-Mechanismen. Bei Fehlschlag werden sie nur als Warning geloggt und verworfen, um die Queue nicht zu verstopfen.

### Contracts Ownership
Die verwendeten Schemas zur Validierung von Queue-Einträgen und Status-Reports liegen in `src/vendor/schemas/`.
**Wichtig:** Diese Dateien sind Kopien (Vendoring) der kanonischen Definitionen aus dem **Metarepo** (`heimgewebe/metarepo/contracts/plexer/`). Änderungen dürfen nicht hier, sondern nur im Metarepo erfolgen und müssen dann synchronisiert werden.

## Observability

- `GET /status`: Liefert Metriken zur Delivery-Queue.
  - Payload folgt dem Contract: `plexer.delivery.report.v1`.
  - Felder: `pending` (in-flight), `failed` (in queue), `retryable_now` (fällig), `next_due_at` (nächster Retry).
