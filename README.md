# Woordenlijst.org XML-archief

De downloader bewaart ieder antwoord als een afzonderlijk XML-bestand. Ruwe XML
is canoniek; SQLite bevat voortgang, de volledige XML, alle XML-nodes en
genormaliseerde lemma- en paradigmatabellen.

```bash
cd ~/Downloads/groene-boekje
python3 downloader.py init
python3 downloader.py discover --prefix aa
python3 downloader.py fetch --prefix aa --limit 100
python3 downloader.py validate --prefix aa
python3 downloader.py status --prefix aa
```

De volgende duizend nog niet verwerkte woorden:

```bash
python3 downloader.py fetch --prefix aa --limit 1000
```

Een onderbroken batch kan met hetzelfde commando worden hervat.

## Volledige automatische download

```bash
python3 run_archive.py --start-letter a --end-letter z --batch-size 1000 --delay 1.5
```

`run_archive.py` ontdekt eerst alle woorden per beginletter en verdeelt ze naar
`aa` t/m `az` plus bijvoorbeeld `a_` voor vormen als `A1-locatie`. Na iedere
1.000 woorden staat een checkpoint in SQLite. Voortgang staat in
`state/full-run.json` en `logs/full-run.log`.

Begintekens buiten A-Z worden afzonderlijk geïnventariseerd en bewaard. De
actuele aanvullende bron bevat apostrof, 0-9, `µ` en `Ω`:

```bash
python3 downloader.py append-list config/special-initials-woordenlijst.org.txt
python3 start_special_initials.py --workers 4 --delay 0.075
```

Deze vormen komen terecht in `raw/_numeric/digit-*` en
`raw/_symbols/symbol-*`. Unicodeletters met diakritische tekens blijven bij de
bijbehorende A-Z-prefix via Unicode-normalisatie.

- `discovery/a/aa.xml`: oorspronkelijke suggestierespons voor `aa%`
- `discovery/a/aa.txt`: ontdekte zoekwoorden
- `raw/a/aa/*.xml`: één XML-bestand per zoekwoord
- `manifests/a/aa.jsonl`: downloadmanifest
- `state/downloader.sqlite`: hervatbare downloadstatus
- `database/woordenlijst.sqlite`: volledige en genormaliseerde inhoud

De online Woordenlijst is niet identiek aan de gedrukte selectie. Controleer de
rechten voordat een afgeleid boek publiek wordt verspreid.

## Lokale webapp

```bash
cd web
npm install
npm test
npm start
```

De server luistert standaard alleen op `127.0.0.1:3080`. `npm run benchmark`
meet de belangrijkste HTML- en API-routes. De lokale SQLite-bronnen worden
alleen-lezen geopend; statusmetadata en tellingen worden begrensd gecachet.

## Compacte publieke build

```bash
python3 publication/build_publication.py
```

Dit maakt:

- `publication/dist/supabase/entries.csv.gz`: compacte zoekindex voor Supabase;
- `docs/data/details/*.ndjson.gz`: volledige lemma- en paradigmadetails per prefix;
- `docs/`: statische GitHub Pages-app.

De 15-GB SQLite-database, ruwe XML en 92 miljoen XML-nodes blijven lokaal. De
publieke tabellen hebben Row Level Security en verlenen alleen `SELECT` aan de
publieke rollen. Publiceer de inhoud uitsluitend onder een passende licentie
van de Nederlandse Taalunie/het Instituut voor de Nederlandse Taal.
