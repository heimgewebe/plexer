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

## Reliability & Best-Effort

- **Critical Events** (z.B. `knowledge.observatory.published.v1`): Werden bei Fehlschlag in der Queue (`failed_forwards.jsonl`) gespeichert und mit exponential backoff wiederholt.
- **Best-Effort Events** (z.B. `integrity.summary.published.v1`): Werden bei Fehlschlag nur geloggt (Warning), aber **nicht** wiederholt, um unnötige Last zu vermeiden (da Integritätsdaten meist pull-basiert sind).

## Observability

- `GET /status`: Liefert Metriken zur Delivery-Queue (pending requests, failed events count, next retry due date).
