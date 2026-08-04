#!/usr/bin/env node
// Daily build: fetch exportRIO.xml, diff it against yesterday's snapshot, and
// compile a sharded lookup index the browser can query without ever seeing the
// 11 MB source document.
//
//   data/snapshot.ndjson   committed; one sorted line per entry, so git itself
//                          holds the full change history
//   data/changes.json      committed; rolling per-day added/removed/changed log
//   site/data/*            generated; published to GitHub Pages
//
// Usage: node scripts/build.mjs [--offline path/to/exportRIO.xml]

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRio } from './parse.mjs';
import { SHARD_COUNT, shardOf } from '../site/shard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://organisaties.overheid.nl/archive/exportRIO.xml';
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'site', 'data');

const HISTORY_DAYS = 400; // kept in data/changes.json
const PUBLISHED_DAYS = 60; // kept in the copy the site downloads
const MAX_ITEMS_PER_DAY = 400; // per category, so one bulk import cannot bloat the log

/** Fields whose change is worth reporting; laatsteWijziging alone is noise. */
const TRACKED = ['naam', 'org', 'doel', 'onder', 'houder', 'registrar', 'van', 'tot'];

async function fetchSource(offline) {
  if (offline) return readFile(offline, 'utf8');
  const res = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'rio-check (+https://github.com/) daily refresh' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${SOURCE_URL} returned HTTP ${res.status}`);
  const xml = await res.text();
  if (xml.length < 1_000_000) throw new Error(`export is suspiciously small (${xml.length} bytes)`);
  return xml;
}

async function readSnapshot(file) {
  if (!existsSync(file)) return null;
  const map = new Map();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    map.set(entry.id, entry);
  }
  return map;
}

function diff(previous, current, orgName) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, entry] of current) {
    const before = previous.get(id);
    if (!before) {
      added.push({ naam: entry.naam, kind: entry.kind, org: orgName(entry.org) });
      continue;
    }
    const fields = TRACKED.filter((f) => (before[f] ?? null) !== (entry[f] ?? null));
    if (fields.length) {
      changed.push({
        naam: entry.naam,
        kind: entry.kind,
        org: orgName(entry.org),
        velden: fields.map((f) => ({ veld: f, van: before[f] ?? null, naar: entry[f] ?? null })),
      });
    }
  }
  for (const [id, entry] of previous) {
    if (!current.has(id)) {
      removed.push({ naam: entry.naam, kind: entry.kind, org: orgName(entry.org) });
    }
  }

  const byName = (a, b) => a.naam.localeCompare(b.naam);
  return [added, removed, changed].map((list) => list.sort(byName));
}

function cap(list) {
  return list.length > MAX_ITEMS_PER_DAY ? list.slice(0, MAX_ITEMS_PER_DAY) : list;
}

/** Compact per-entry payload for the shard files — keys are short by design. */
function publicEntry(entry) {
  const out = { n: entry.naam, o: entry.org, k: entry.kind === 'reg' ? 0 : 1 };
  if (entry.doel) out.p = entry.doel;
  if (entry.detail) out.u = entry.detail;
  if (entry.onder) out.b = entry.onder;
  if (entry.houder) out.h = entry.houder;
  if (entry.registrar) out.r = entry.registrar;
  if (entry.van) out.v = entry.van;
  if (entry.tot) out.t = entry.tot;
  if (entry.omschrijving) out.d = entry.omschrijving;
  if (entry.scores?.web != null) out.w = entry.scores.web;
  if (entry.scores?.mail != null) out.m = entry.scores.mail;
  return out;
}

async function main() {
  const offlineFlag = process.argv.indexOf('--offline');
  const offline = offlineFlag === -1 ? null : process.argv[offlineFlag + 1];

  console.log(offline ? `Reading ${offline}` : `Fetching ${SOURCE_URL}`);
  const xml = await fetchSource(offline);
  const { timestamp, organisaties, entries } = parseRio(xml);
  console.log(`Parsed ${organisaties.length} organisations, ${entries.length} entries`);

  const orgs = new Map(organisaties.map((o) => [o.id, o]));
  const orgName = (id) => orgs.get(id)?.naam ?? null;

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const current = new Map(entries.map((e) => [e.id, e]));

  // --- change tracking -----------------------------------------------------
  const snapshotFile = path.join(DATA, 'snapshot.ndjson');
  const previous = await readSnapshot(snapshotFile);
  const changesFile = path.join(DATA, 'changes.json');
  const history = existsSync(changesFile) ? JSON.parse(await readFile(changesFile, 'utf8')) : [];

  // The register stamps the export itself; use its date so a re-run on the same
  // export updates that day's record instead of inventing a second one.
  const day = (timestamp || new Date().toISOString()).slice(0, 10);
  let summary = { toegevoegd: 0, verwijderd: 0, gewijzigd: 0 };

  if (previous) {
    const [added, removed, changed] = diff(previous, current, orgName);
    summary = { toegevoegd: added.length, verwijderd: removed.length, gewijzigd: changed.length };
    const record = {
      datum: day,
      bron: timestamp,
      aantallen: summary,
      toegevoegd: cap(added),
      verwijderd: cap(removed),
      gewijzigd: cap(changed),
    };
    const at = history.findIndex((h) => h.datum === day);
    const total = added.length + removed.length + changed.length;
    // Days on which nothing moved stay out of the log, so every entry the site
    // shows is a day the register actually changed. An existing record is still
    // updated — a re-run must never leave stale numbers behind.
    if (at !== -1) history[at] = record;
    else if (total) history.unshift(record);

    if (at !== -1 || total) {
      history.sort((a, b) => b.datum.localeCompare(a.datum));
      history.length = Math.min(history.length, HISTORY_DAYS);
      await writeFile(changesFile, JSON.stringify(history, null, 1) + '\n');
    }
    console.log(
      `Changes on ${day}: +${summary.toegevoegd} / -${summary.verwijderd} / ~${summary.gewijzigd}`,
    );
  } else {
    console.log('No previous snapshot — recording a baseline, no changes reported.');
  }

  await mkdir(DATA, { recursive: true });
  await writeFile(snapshotFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // --- published index -----------------------------------------------------
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'idx'), { recursive: true });

  const shards = Array.from({ length: SHARD_COUNT }, () => ({}));
  const names = new Set();
  for (const entry of entries) {
    const key = entry.naam.toLowerCase();
    names.add(key);
    const bucket = shards[parseInt(shardOf(key), 16)];
    (bucket[key] ||= []).push(publicEntry(entry));
  }

  let biggest = 0;
  await Promise.all(
    shards.map(async (bucket, i) => {
      const body = JSON.stringify(bucket);
      biggest = Math.max(biggest, body.length);
      await writeFile(path.join(OUT, 'idx', `${i.toString(16).padStart(2, '0')}.json`), body);
    }),
  );

  const sortedNames = [...names].sort();
  await writeFile(path.join(OUT, 'namen.txt'), sortedNames.join('\n') + '\n');
  await writeFile(
    path.join(OUT, 'organisaties.json'),
    JSON.stringify(
      Object.fromEntries(
        organisaties.map((o) => [
          o.id,
          { naam: o.naam, afkorting: o.afkorting, types: o.types, register: o.register, site: o.site },
        ]),
      ),
    ),
  );
  await writeFile(
    path.join(OUT, 'wijzigingen.json'),
    JSON.stringify(
      history.slice(0, PUBLISHED_DAYS).map((h) => ({
        ...h,
        gewijzigd: h.gewijzigd?.slice(0, 60) ?? [],
        toegevoegd: h.toegevoegd?.slice(0, 120) ?? [],
        verwijderd: h.verwijderd?.slice(0, 120) ?? [],
      })),
    ),
  );
  await writeFile(
    path.join(OUT, 'meta.json'),
    JSON.stringify({
      bron: SOURCE_URL,
      bronTijdstip: timestamp,
      gebouwd: new Date().toISOString(),
      shards: SHARD_COUNT,
      aantallen: {
        organisaties: organisaties.length,
        registraties: entries.filter((e) => e.kind === 'reg').length,
        domeinen: entries.filter((e) => e.kind === 'host').length,
        unieke: sortedNames.length,
      },
      laatsteWijziging: summary,
    }),
  );

  console.log(
    `Index written to site/data — ${SHARD_COUNT} shards, largest ${(biggest / 1024).toFixed(1)} kB`,
  );

  // Surfaced by the workflow so the commit message says what actually moved.
  if (process.env.GITHUB_OUTPUT) {
    const line = `summary=+${summary.toegevoegd} / -${summary.verwijderd} / ~${summary.gewijzigd}`;
    await writeFile(process.env.GITHUB_OUTPUT, `${line}\ndatum=${day}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
