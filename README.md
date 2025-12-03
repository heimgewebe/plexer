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
