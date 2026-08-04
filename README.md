# RIO-check

Zoekhulp bij het [Register Internetdomeinen Overheid](https://organisaties.overheid.nl/domeinen):
typ een domeinnaam of plak een link en zie meteen of het domein in het register staat, van welke
overheidsorganisatie het is, en wat er de afgelopen dagen aan het register is veranderd.

Statische site, geen backend. De export wordt elke dag door GitHub Actions opgehaald en omgezet
naar een index die de browser in kleine stukjes ophaalt.

## Hoe het werkt

```
organisaties.overheid.nl/archive/exportRIO.xml   (11 MB, dagelijks ververst)
        │
        │  scripts/build.mjs  ── dagelijks via .github/workflows/refresh.yml
        ▼
data/snapshot.ndjson      één regel per registratie, gesorteerd → git houdt de historie bij
data/changes.json         per dag: toegevoegd / verwijderd / gewijzigd
        │
        ▼
site/data/idx/00..ff.json 256 shards van ±15 kB, verdeeld met FNV-1a over de domeinnaam
site/data/namen.txt       alle namen, alleen geladen bij zoeken op tekst
site/data/organisaties.json, meta.json, wijzigingen.json
        │
        ▼
GitHub Pages
```

Een controle van één domein haalt **één shard** op, plus de parents als het domein zelf niet in het
register staat (`mijn.belastingdienst.nl` → `belastingdienst.nl`). De browser downloadt de XML dus
nooit; de zoekopdracht verlaat het apparaat niet.

De shardverdeling staat in `site/shard.js` en wordt door zowel het buildscript als de browser
gebruikt, zodat ze niet uit elkaar kunnen lopen.

## Wijzigingen bijhouden

`scripts/build.mjs` vergelijkt de nieuwe export met `data/snapshot.ndjson` op `systeemId`, en legt
per dag vast wat er is toegevoegd, verdwenen of aangepast (doel, houder, registrar, opzegdatum,
onderliggende registratie). Die dagrecords staan in `data/changes.json` en worden onderin de site
getoond. Omdat de snapshot als gesorteerde NDJSON wordt gecommit, is `git log -p data/snapshot.ndjson`
de volledige historie — ook verder terug dan de 400 dagen die `changes.json` bewaart.

## In gebruik nemen

1. Maak een lege GitHub-repository en push deze map ernaartoe:

   ```bash
   git add -A && git commit -m "RIO-check"
   git branch -M main
   git remote add origin git@github.com:<gebruiker>/<repo>.git
   git push -u origin main
   ```

2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write permissions** (de workflow
   commit de dagelijkse snapshot terug).
4. Start de workflow één keer handmatig via **Actions → RIO verversen en publiceren → Run workflow**.
   De eerste run legt de nulmeting vast; vanaf de tweede dag verschijnen er wijzigingen.

De cron staat op 05:20 UTC. De export wordt rond 00:45 Amsterdamse tijd gestempeld, dus die van
dezelfde kalenderdag is dan binnen.

## Lokaal draaien

```bash
node scripts/build.mjs                 # haalt de live export op
node scripts/build.mjs --offline x.xml # of gebruikt een lokaal bestand
cd site && python3 -m http.server 8000
```

Geen dependencies: alles draait op Node 20 zonder `npm install`. De XML-parser in
`scripts/parse.mjs` is toegesneden op dit schema en stopt met een foutmelding zodra de export er
anders uitziet, zodat een gewijzigd formaat de build laat falen in plaats van stilletjes een lege
index te publiceren.

## Let op

Het RIO is sinds 2024 in opbouw en nog niet compleet. Een domein dat er niet in staat kan dus nog
steeds echt zijn. De site zegt dat er zelf ook bij: een negatief resultaat is een waarschuwing, geen
bewijs.

Dit is een onafhankelijke zoekhulp en geen dienst van de rijksoverheid. De vormgeving houdt daarom
bewust afstand van de Rijkshuisstijl.
