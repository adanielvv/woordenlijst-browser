# Woordenlijst Browser

Start de dynamische browsertool:

```bash
cd ~/Downloads/groene-boekje
node web/server.js
```

Open daarna <http://127.0.0.1:3080>. De applicatie gebruikt Node's ingebouwde
`node:sqlite`-module en leest rechtstreeks uit de groeiende archiefdatabase.

De knop **PDF-export** laat één of meerdere beschikbare letters kiezen. De
server genereert een actuele boekexport met unieke lemma’s, uitspraak,
woordsoort, vormen en afbrekingen.

Op macOS kan ook `web/start.command` worden dubbelgeklikt; dit start de server
indien nodig en opent de browser automatisch.
