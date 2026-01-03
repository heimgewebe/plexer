# plexer

Plexer ist das Ereignisnetz (Event Router) für den Heimgewebe-Organismus.

- Nimmt Events über `POST /events` im Heimgewebe-Format entgegen
- Prüft Minimalstruktur (`type`, `source`, `payload`; `type`/`source` max. 256 Zeichen)
- Loggt eingehende Events
- Leitet sie an Heimgeist weiter (und später an weitere Konsumenten)

## Scope

Plexer kümmert sich ausschließlich um **Eventtransport**.

Plexer tut:

- Events entgegennehmen (`POST /events`)
- Minimalstruktur prüfen
- Events protokollieren
- Events an Konsumenten weiterreichen (Heimgeist, semantAH, weitere Dienste)

Plexer tut **nicht**:

- PR-Kommentare entgegennehmen
- PR-Kommandos parsen
- mit der GitHub-API sprechen
- als Bot oder Reviewer agieren
- Chat- oder Dialogflüsse steuern

PR-Kommandos bleiben weiterhin auf dem Weg:

GitHub PR Kommentar → Dispatcher → Ziel-Tool
(z. B. Sichter, WGX, Heimgeist, Heimlern)

Damit bleibt Plexer ein schlanker Event-Router und kann unabhängig von
den Kommando-Workflows skaliert oder ausgetauscht werden.

## Organismus-Kontext

Dieses Repository ist Teil des **Heimgewebe-Organismus**.

Die übergeordnete Architektur, Achsen, Rollen und Contracts sind zentral beschrieben im  
👉 [`metarepo/docs/heimgewebe-organismus.md`](https://github.com/heimgewebe/metarepo/blob/main/docs/heimgewebe-organismus.md)  
sowie im Zielbild  
👉 [`metarepo/docs/heimgewebe-zielbild.md`](https://github.com/heimgewebe/metarepo/blob/main/docs/heimgewebe-zielbild.md).

Alle Rollen-Definitionen, Datenflüsse und Contract-Zuordnungen dieses Repos
sind dort verankert.

## Tooling

- Node.js >= 20
- pnpm (via Corepack)

npm is not supported.

## Environment

- Alle URL-Variablen (`HEIMGEIST_URL`, `LEITSTAND_URL`, `HAUSKI_URL`, `CHRONIK_URL`) müssen vollqualifiziert sein, d. h. inklusive Schema (`https://…`).
- Abschließende Slashes werden zur Konsistenz entfernt (z. B. `https://chronik.example.com/api/` → `https://chronik.example.com/api`).
- Leerzeichen in Variablen werden getrimmt; leere Werte werden wie nicht gesetzte Variablen behandelt.
