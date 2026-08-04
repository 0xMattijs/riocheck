// Minimal XML reader for exportRIO.xml.
//
// The export uses a fixed, shallow schema: no CDATA, no self-closing tags, no
// mixed content, and only the five predefined entities plus numeric refs. That
// makes a ~80 line reader safer than pulling in a parser dependency for a job
// that runs unattended every day. parseRio() throws if the document does not
// look like the schema it was written for, so a changed export fails the build
// loudly instead of quietly publishing an empty index.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

function localName(tag) {
  const colon = tag.indexOf(':');
  return colon === -1 ? tag : tag.slice(colon + 1);
}

function readAttrs(source) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(source))) attrs[localName(m[1])] = decode(m[2]);
  return attrs;
}

/**
 * Parse one element (and its descendants) starting at `start`, which must point
 * at a '<'. Returns the node plus the index just past its closing tag.
 */
function parseElement(xml, start) {
  const open = xml.indexOf('>', start);
  if (open === -1) throw new Error(`unterminated tag at offset ${start}`);
  const head = xml.slice(start + 1, open);
  const rawName = head.split(/[\s/>]/)[0];
  const node = {
    name: localName(rawName),
    attrs: readAttrs(head.slice(rawName.length)),
    text: '',
    children: [],
  };

  if (head.endsWith('/')) return { node, end: open + 1 };

  let i = open + 1;
  for (;;) {
    const next = xml.indexOf('<', i);
    if (next === -1) throw new Error(`unclosed element <${name}>`);
    if (next > i) node.text += xml.slice(i, next);
    if (xml[next + 1] === '/') {
      const close = xml.indexOf('>', next);
      return { node, end: close + 1 };
    }
    if (xml.startsWith('<!--', next)) {
      i = xml.indexOf('-->', next) + 3;
      continue;
    }
    const child = parseElement(xml, next);
    node.children.push(child.node);
    i = child.end;
  }
}

const childText = (node, name) => {
  const hit = node.children.find((c) => c.name === name);
  return hit ? decode(hit.text).trim() || null : null;
};
const childNode = (node, name) => node.children.find((c) => c.name === name) || null;
const grandChildren = (node, group, item) => {
  const holder = childNode(node, group);
  return holder ? holder.children.filter((c) => c.name === item) : [];
};

/** Strip anything that is not the hostname; the register is not always clean. */
function hostOnly(value) {
  if (!value) return null;
  const host = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/\.+$/, '');
  return host || null;
}

function scores(node) {
  const out = {};
  for (const report of grandChildren(node, 'kwaliteitsRapporten', 'kwaliteitsRapport')) {
    const type = childText(report, 'type');
    const score = Number(childText(report, 'score'));
    if (!Number.isFinite(score)) continue;
    if (type === 'WebStandaard') out.web = score;
    else if (type === 'EmailStandaard') out.mail = score;
  }
  return out;
}

/**
 * @returns {{timestamp: string|null, organisaties: object[], entries: object[]}}
 *   `entries` holds both registered domain names (kind 'reg') and the
 *   hostnames published under them (kind 'host'), each keyed by a stable id
 *   derived from the register's own systeemId so day-to-day diffs are exact.
 */
export function parseRio(xml) {
  const rootStart = xml.indexOf('<p:RegisterInternetdomeinenOverheid');
  if (rootStart === -1) throw new Error('root element RegisterInternetdomeinenOverheid not found');

  const rootHead = xml.slice(rootStart, xml.indexOf('>', rootStart));
  const timestamp = readAttrs(rootHead).timestamp || null;

  const organisaties = [];
  const entries = [];

  const opener = /<p:organisatie[\s>]/g;
  opener.lastIndex = rootStart;
  let match;
  while ((match = opener.exec(xml))) {
    const { node, end } = parseElement(xml, match.index);
    opener.lastIndex = end;

    const orgId = node.attrs.systeemId;
    const contact = childNode(node, 'contact');
    organisaties.push({
      id: orgId,
      naam: childText(node, 'naam'),
      afkorting: childText(node, 'afkorting'),
      types: grandChildren(node, 'types', 'type').map((t) => decode(t.text).trim()),
      register: childText(node, 'overzichtURL'),
      site: contact ? hostOnly(childText(contact, 'url')) : null,
      tooi: node.attrs.resourceIdentifierTOOI || null,
    });

    for (const reg of grandChildren(node, 'domeinnaamregistraties', 'domeinnaamregistratie')) {
      const naam = hostOnly(childText(reg, 'naam'));
      if (!naam) continue;
      entries.push({
        id: `r${reg.attrs.systeemId}`,
        kind: 'reg',
        naam,
        org: orgId,
        doel: childText(reg, 'doel'),
        detail: childText(reg, 'detailURL'),
        houder: childText(reg, 'registratieHouder'),
        registrar: childText(reg, 'registrar'),
        van: childText(reg, 'geregistreerdSinds') || childText(reg, 'registratieDatum'),
        tot: childText(reg, 'opgezegdSinds') || childText(reg, 'eindeRegistratieDatum'),
        gewijzigd: childText(reg, 'laatsteWijziging'),
      });
    }

    for (const dom of grandChildren(node, 'domeinen', 'domein')) {
      const naam = hostOnly(childText(dom, 'url'));
      if (!naam) continue;
      const parent = childNode(dom, 'hoortBijDomeinnaamregistratie');
      entries.push({
        id: `d${dom.attrs.systeemId}`,
        kind: 'host',
        naam,
        org: orgId,
        doel: childText(dom, 'gebruiksdoel'),
        detail: childText(dom, 'detailURL'),
        onder: parent ? hostOnly(decode(parent.text).trim()) : null,
        omschrijving: childText(dom, 'omschrijving'),
        van: childText(dom, 'geregistreerdSinds'),
        tot: childText(dom, 'opgezegdSinds'),
        scores: scores(dom),
        gewijzigd: childText(dom, 'laatsteWijziging'),
      });
    }
  }

  if (!organisaties.length || !entries.length) {
    throw new Error('export parsed but contained no organisations or domains');
  }
  return { timestamp, organisaties, entries };
}
