// Everything runs in the browser. A lookup fetches at most a handful of ~15 kB
// shard files: the 11 MB source export never leaves the build step.

import { shardOf, normaliseHost, parentChain } from './shard.js';

const DATA = './data';
const shardCache = new Map(); // shard id -> Promise<object>
const els = {
  form: document.getElementById('form'),
  input: document.getElementById('q'),
  clear: document.getElementById('clear'),
  readout: document.getElementById('readout'),
  verdict: document.getElementById('verdict'),
  panel: document.getElementById('changes-panel'),
  days: document.getElementById('days'),
  changelist: document.getElementById('changelist'),
  footMeta: document.getElementById('foot-meta'),
};

let meta = null;
let orgs = {};
let names = null; // lazily loaded, only for free-text search
let namesPromise = null;
let token = 0; // guards against out-of-order async renders

/* ── small DOM helpers (textContent only — register data is never trusted as
      markup) ────────────────────────────────────────────────────────────── */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

const nf = new Intl.NumberFormat('nl-NL');

function date(value, withTime = false) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

const isPast = (value) => Boolean(value) && new Date(value) <= new Date();

/* ── data access ─────────────────────────────────────────────────────────── */

async function json(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function loadShard(name) {
  const id = shardOf(name);
  if (!shardCache.has(id)) {
    shardCache.set(
      id,
      json(`${DATA}/idx/${id}.json`).catch((err) => {
        shardCache.delete(id);
        throw err;
      }),
    );
  }
  return shardCache.get(id);
}

async function entriesFor(name) {
  const shard = await loadShard(name);
  return shard[name] || null;
}

function loadNames() {
  if (!namesPromise) {
    namesPromise = fetch(`${DATA}/namen.txt`, { cache: 'no-cache' })
      .then((r) => r.text())
      .then((text) => {
        names = text.split('\n').filter(Boolean);
        return names;
      });
  }
  return namesPromise;
}

/* ── verdict rendering ───────────────────────────────────────────────────── */

const PURPOSE = {
  Doorverwijzing: 'stuurt door naar een andere site',
  Website: 'website',
  Hosting: 'hosting',
  'E-mail': 'e-mail',
  Mailserver: 'mailserver',
  Reservering: 'alleen vastgelegd, niet in gebruik',
  Nameserver: 'nameserver',
  Veiligheid: 'veiligheid',
  Systeem: 'systeem',
  Onbekend: 'onbekend',
};

function organisation(id) {
  return orgs[id] || null;
}

function ladder(host, matched) {
  const pre = matched && host.endsWith(matched) ? host.slice(0, host.length - matched.length) : '';
  const tail = pre ? matched : host;
  return el('p', { class: 'ladder' }, [
    pre ? el('span', { class: 'ladder__pre', text: pre }) : null,
    el('span', { class: 'ladder__match', text: tail }),
  ]);
}

function facts(entry) {
  const rows = [];
  const add = (label, value) => {
    if (value) rows.push(el('div', {}, [el('dt', { text: label }), el('dd', { text: value })]));
  };

  add('Soort', entry.k === 0 ? 'Geregistreerde domeinnaam' : 'Naam onder een registratie');
  add('Gebruik', entry.p ? (PURPOSE[entry.p] ?? entry.p) : null);
  if (entry.k === 1) add('Valt onder', entry.b);
  add('Houder', entry.h);
  add('Registrar', entry.r);
  add('Geregistreerd sinds', date(entry.v));
  if (entry.t) add(isPast(entry.t) ? 'Opgezegd sinds' : 'Loopt af op', date(entry.t));
  if (entry.w != null) add('Score internet.nl web', `${entry.w}/100`);
  if (entry.m != null) add('Score internet.nl mail', `${entry.m}/100`);

  return rows.length ? el('dl', { class: 'facts' }, rows) : null;
}

/** "Politie · Politie" helps nobody: drop a type that repeats the name. */
function typeLabel(org) {
  const types = (org.types || []).filter(
    (t) => t.toLowerCase() !== (org.naam || '').toLowerCase(),
  );
  return types.length ? types.join(' · ') : null;
}

function orgBlock(entry) {
  const org = organisation(entry.o);
  if (!org) return null;
  const types = typeLabel(org);
  return el('div', {}, [
    el('div', { class: 'org' }, [
      el('h3', { text: org.naam || 'Onbekende organisatie' }),
      types ? el('span', { class: 'org__types', text: types }) : null,
    ]),
    el('div', { class: 'finding__links' }, [
      entry.u ? el('a', { href: entry.u, rel: 'noopener', text: 'Deze registratie in het RIO ↗' }) : null,
      org.register ? el('a', { href: org.register, rel: 'noopener', text: 'Alle domeinen van deze organisatie ↗' }) : null,
      org.site ? el('a', { href: `https://${org.site}`, rel: 'noopener', text: `${org.site} ↗` }) : null,
    ]),
  ]);
}

function alsoBlock(rest) {
  if (!rest.length) return null;
  return el('div', { class: 'also' }, [
    el('h4', { text: 'Ook vastgelegd als' }),
    el(
      'ul',
      { class: 'hits' },
      rest.map((entry) =>
        el('li', {}, [
          el('span', {
            text: entry.k === 0 ? 'geregistreerde domeinnaam' : `naam onder ${entry.b || 'een registratie'}`,
          }),
          entry.p ? el('span', { text: `· ${PURPOSE[entry.p] ?? entry.p}` }) : null,
        ]),
      ),
    ),
  ]);
}

const MAX_SUGGESTIONS = 25;

/** Closest first: names that start with the needle, then the shortest. */
function searchNames(all, needle) {
  return all
    .filter((n) => n.includes(needle))
    .sort(
      (a, b) =>
        Number(b.startsWith(needle)) - Number(a.startsWith(needle)) ||
        a.length - b.length ||
        a.localeCompare(b),
    )
    .slice(0, MAX_SUGGESTIONS);
}

function suggestionBlock(matches, heading = 'Lijkt op deze namen in het register') {
  if (!matches.length) return null;
  return el('div', { class: 'also' }, [
    el('h4', { text: matches.length === MAX_SUGGESTIONS ? `${heading} (eerste ${MAX_SUGGESTIONS})` : heading }),
    el(
      'ul',
      { class: 'hits' },
      matches.map((name) =>
        el('li', {}, [
          el('button', { type: 'button', text: name, onclick: () => run(name, true) }),
        ]),
      ),
    ),
  ]);
}

function findingCard({ tone, stamp, host, matched, caption, entry, rest = [], extra = null }) {
  return el('article', { class: `finding ${tone}` }, [
    el('div', { class: 'finding__stamp' }, [el('span', { text: stamp })]),
    el('div', { class: 'finding__body' }, [
      ladder(host, matched),
      el('p', { class: 'ladder__caption' }, caption),
      entry ? facts(entry) : null,
      entry ? orgBlock(entry) : null,
      alsoBlock(rest),
      extra,
    ]),
  ]);
}

function caption(parts) {
  return parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p));
}

const strong = (text) => el('strong', { text });

function render(host, matched, entries) {
  const primary = entries.find((e) => e.k === 0) || entries[0];
  const rest = entries.filter((e) => e !== primary);
  const org = organisation(primary.o);
  const orgLabel = org?.naam || 'een overheidsorganisatie';
  const ended = entries.every((e) => isPast(e.t));

  let tone = 'is-verified';
  let stamp = 'Staat in het register';
  let text;

  if (ended) {
    tone = 'is-ended';
    stamp = 'Registratie is beëindigd';
    text = caption([
      strong(matched),
      ' stond op naam van ',
      strong(orgLabel),
      `, maar de registratie is beëindigd op ${date(primary.t)}. Wees voorzichtig: een opgezegd domein kan door iemand anders zijn overgenomen.`,
    ]);
  } else if (matched === host) {
    text = caption([strong(host), ' is geregistreerd door ', strong(orgLabel), '.']);
  } else {
    tone = 'is-parent';
    stamp = 'Alleen het hoofddomein staat erin';
    text = caption([
      strong(host),
      ' staat zelf niet in het register, maar het hoofddomein ',
      strong(matched),
      ' is geregistreerd door ',
      strong(orgLabel),
      '. Subdomeinen worden beheerd door dezelfde organisatie, maar zijn hier niet apart gecontroleerd.',
    ]);
  }

  return findingCard({ tone, stamp, host, matched, caption: text, entry: primary, rest });
}

/**
 * Someone checking "belastingdienst-terugbetaling.com" is best served by being
 * shown the real belastingdienst.nl, so widen the needle step by step: the full
 * name minus its suffix first, then its longest words.
 */
function needlesFor(host) {
  const base = host.replace(/^www\./, '');
  const withoutSuffix = base.split('.').slice(0, -1).join('.');
  const words = [...new Set(withoutSuffix.split(/[.-]/))]
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length);
  return [...new Set([withoutSuffix, ...words])].filter((n) => n.length >= 3);
}

async function renderAbsent(host) {
  let matches = [];
  const all = await loadNames();
  for (const needle of needlesFor(host)) {
    matches = searchNames(all, needle);
    if (matches.length) break;
  }

  return findingCard({
    tone: 'is-absent',
    stamp: 'Niet gevonden in het register',
    host,
    matched: null,
    caption: caption([
      strong(host),
      ' komt niet voor in het RIO. Dat is een waarschuwing, geen bewijs: het register is nog in opbouw, dus ook echte overheidsdomeinen kunnen ontbreken. Controleer bij twijfel via de officiële website van de organisatie.',
    ]),
    entry: null,
    extra: suggestionBlock(matches),
  });
}

/** Organisations whose name or abbreviation contains the query. */
function searchOrgs(needle) {
  return Object.values(orgs)
    .filter((org) =>
      `${org.naam || ''} ${org.afkorting || ''} ${(org.types || []).join(' ')}`
        .toLowerCase()
        .includes(needle),
    )
    .sort((a, b) => (a.naam || '').localeCompare(b.naam || ''))
    .slice(0, 12);
}

function orgHits(matches) {
  if (!matches.length) return null;
  return el('div', { class: 'also' }, [
    el('h4', { text: 'Organisaties' }),
    el(
      'ul',
      { class: 'hits' },
      matches.map((org) =>
        el('li', {}, [
          org.register
            ? el('a', { href: org.register, rel: 'noopener', text: `${org.naam} ↗` })
            : el('span', { text: org.naam }),
          el('span', { text: typeLabel(org) }),
        ]),
      ),
    ),
  ]);
}

async function renderSearch(query) {
  const needle = query.toLowerCase();
  const all = await loadNames();
  const matches = searchNames(all, needle);
  const organisations = searchOrgs(needle);
  const total = matches.length + organisations.length;
  const capped = matches.length === MAX_SUGGESTIONS;

  return el('article', { class: 'finding' }, [
    el('div', { class: 'finding__stamp' }, [
      el('span', {
        text: total ? `${capped ? `Eerste ${MAX_SUGGESTIONS}+` : total} treffers` : 'Geen treffers',
      }),
    ]),
    el('div', { class: 'finding__body' }, [
      el('p', {
        class: 'ladder__caption ladder__caption--lead',
        text: total
          ? 'Domeinnamen en organisaties in het register die deze tekst bevatten.'
          : 'Geen domeinnaam en geen organisatie in het register bevat deze tekst.',
      }),
      orgHits(organisations),
      suggestionBlock(matches, 'Domeinnamen'),
    ]),
  ]);
}

/* ── query handling ──────────────────────────────────────────────────────── */

async function run(raw, focusResult = false) {
  const query = String(raw || '').trim();
  const mine = ++token;

  els.clear.hidden = !query;
  if (els.input.value !== query) els.input.value = query;
  setHash(query);

  if (!query) {
    els.verdict.replaceChildren();
    return;
  }

  const host = normaliseHost(query);

  try {
    // Anything without a dot cannot be a hostname — treat it as a name search.
    if (!host.includes('.')) {
      const card = query.length >= 2 ? await renderSearch(query.toLowerCase()) : null;
      if (mine !== token) return;
      if (card) els.verdict.replaceChildren(card);
      else els.verdict.replaceChildren();
      return;
    }

    for (const candidate of [host, ...parentChain(host)]) {
      const entries = await entriesFor(candidate);
      if (mine !== token) return;
      if (entries) {
        els.verdict.replaceChildren(render(host, candidate, entries));
        if (focusResult) els.verdict.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
    }
    const absent = await renderAbsent(host);
    if (mine !== token) return;
    els.verdict.replaceChildren(absent);
  } catch (err) {
    console.error(err);
    if (mine !== token) return;
    els.verdict.replaceChildren(
      el('article', { class: 'finding is-absent' }, [
        el('div', { class: 'finding__stamp' }, [el('span', { text: 'Zoeken mislukt' })]),
        el('div', { class: 'finding__body' }, [
          el('p', {
            class: 'ladder__caption',
            text: 'De index kon niet worden geladen. Controleer je verbinding en probeer het opnieuw.',
          }),
        ]),
      ]),
    );
  }
}

function setHash(query) {
  const next = query ? `#${encodeURIComponent(query)}` : '';
  if (location.hash !== next) {
    history.replaceState(null, '', next || location.pathname + location.search);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ── changes panel ───────────────────────────────────────────────────────── */

function changeList(title, items, total, renderItem) {
  if (!total) return el('p', { class: 'changegroup changegroup--none', text: `${title}: geen` });
  return el('div', { class: 'changegroup' }, [
    el('h3', { text: `${title} (${nf.format(total)})` }),
    el('ul', { class: 'hits' }, items.map(renderItem)),
    total > items.length
      ? el('p', { class: 'changegroup--none', text: `… en nog ${nf.format(total - items.length)}` })
      : null,
  ]);
}

function renderDay(day) {
  const nameButton = (item) =>
    el('li', {}, [
      el('button', { type: 'button', text: item.naam, onclick: () => run(item.naam, true) }),
      el('span', { text: item.org || 'onbekende organisatie' }),
    ]);

  els.changelist.replaceChildren(
    changeList('Nieuw', day.toegevoegd || [], day.aantallen.toegevoegd, nameButton),
    changeList('Verdwenen', day.verwijderd || [], day.aantallen.verwijderd, (item) =>
      el('li', {}, [
        el('span', { text: item.naam }),
        el('span', { text: item.org || 'onbekende organisatie' }),
      ]),
    ),
    changeList('Aangepast', day.gewijzigd || [], day.aantallen.gewijzigd, (item) =>
      el('li', {}, [
        el('button', { type: 'button', text: item.naam, onclick: () => run(item.naam, true) }),
        el('span', {
          text: item.velden.map((v) => `${v.veld}: ${v.van ?? '—'} → ${v.naar ?? '—'}`).join(' · '),
        }),
      ]),
    ),
  );
}

function renderChanges(history) {
  if (!history.length) return;
  els.panel.hidden = false;

  const buttons = history.slice(0, 30).map((day) =>
    el(
      'button',
      {
        type: 'button',
        class: 'day',
        'aria-pressed': 'false',
        onclick: (event) => {
          for (const b of els.days.children) b.setAttribute('aria-pressed', 'false');
          event.currentTarget.setAttribute('aria-pressed', 'true');
          renderDay(day);
        },
      },
      [
        el('b', {
          text: new Date(day.datum).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }),
        }),
        el('span', { class: 'plus', text: `+${day.aantallen.toegevoegd}` }),
        document.createTextNode(' '),
        el('span', { class: 'minus', text: `−${day.aantallen.verwijderd}` }),
      ],
    ),
  );

  els.days.replaceChildren(...buttons);
  const first = history.findIndex(
    (d) => d.aantallen.toegevoegd + d.aantallen.verwijderd + d.aantallen.gewijzigd > 0,
  );
  const index = first === -1 ? 0 : Math.min(first, buttons.length - 1);
  buttons[index]?.click();
}

/* ── boot ────────────────────────────────────────────────────────────────── */

async function boot() {
  // A shared #domein link should open at the top with the finding in view,
  // not wherever the previous visit happened to be scrolled to.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(els.input.value, true);
  });
  els.input.addEventListener('input', debounce(() => run(els.input.value), 180));
  els.clear.addEventListener('click', () => {
    run('');
    els.input.focus();
  });
  window.addEventListener('hashchange', () => {
    const q = decodeURIComponent(location.hash.slice(1));
    if (q !== els.input.value) run(q);
  });

  try {
    [meta, orgs] = await Promise.all([json(`${DATA}/meta.json`), json(`${DATA}/organisaties.json`)]);
  } catch (err) {
    console.error(err);
    els.readout.textContent = 'De index kon niet worden geladen.';
    return;
  }

  const { unieke, registraties, domeinen, organisaties } = meta.aantallen;
  els.readout.replaceChildren(
    el('b', { text: nf.format(unieke) }),
    document.createTextNode(' domeinnamen van '),
    el('b', { text: nf.format(organisaties) }),
    document.createTextNode(' organisaties · export van '),
    el('b', { text: date(meta.bronTijdstip) || 'onbekend' }),
  );
  els.footMeta.textContent = `${nf.format(registraties)} registraties · ${nf.format(
    domeinen,
  )} domeinnamen daaronder · index gebouwd ${date(meta.gebouwd, true)}`;

  const initial = decodeURIComponent(location.hash.slice(1));
  if (initial) run(initial);
  else els.input.focus({ preventScroll: true });

  try {
    renderChanges(await json(`${DATA}/wijzigingen.json`));
  } catch (err) {
    console.error(err);
  }
}

boot();
