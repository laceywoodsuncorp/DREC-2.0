/* Reading the Bureau of Meteorology's river height tables and flood
   warnings, as published on its anonymous FTP service
   (ftp://ftp.bom.gov.au/anon/gen/fwo/).

   BOM's website refuses automated requests and directs them to that FTP
   channel; use of what it serves is subject to BOM's copyright notice, and
   the dashboard's owner confirmed (14 Nov 2026) that Suncorp holds a BOM
   data agreement covering this use. Everything shown is attributed to BOM.

   Two products:
     - "Latest River Heights" tables, one per region (IDx6xxxx.html): every
       gauge with its height, tendency and BOM's flood classification
       (Below Flood Level / Minor / Moderate / Major), grouped by catchment.
     - Flood warnings (IDx2xxxx/IDx3xxxx.xml, amoc service HFW): one per
       river basin, with a severity and the situation in BOM's words.

   Pure functions only: fetching is the capture script's job. */

/* The fifty river height tables, found by scripts/probe-bom-rivers.mjs
   (data/bom-product-titles.tsv, 14 Nov 2026). Listed rather than
   discovered each time: series 6 holds hundreds of rainfall and weather
   products too, and telling them apart means downloading them. A table
   that stops appearing is reported, not silently dropped. */
export const RIVER_HEIGHT_PRODUCTS = [
  ['IDN60140', 'NSW', 'Northern Rivers'], ['IDN60141', 'NSW', 'Mid North Coast'],
  ['IDN60143', 'NSW', 'Central Coast'], ['IDN60144', 'NSW', 'South Coast'],
  ['IDN60145', 'NSW', 'North West'], ['IDN60146', 'NSW', 'Central West'],
  ['IDN60147', 'NSW', 'South West'], ['IDN60148', 'NSW', 'Far West'],
  ['IDQ60285', 'QLD', 'Gold Coast, Logan-Albert'], ['IDQ60286', 'QLD', 'Brisbane, Pine, Caboolture'],
  ['IDQ60287', 'QLD', 'Sunshine Coast, Mary'], ['IDQ60288', 'QLD', 'Burnett, Kolan'],
  ['IDQ60289', 'QLD', 'Boyne, Calliope, Fitzroy'], ['IDQ60290', 'QLD', 'Pioneer to Burdekin'],
  ['IDQ60291', 'QLD', 'Herbert to Daintree'], ['IDQ60292', 'QLD', 'Border Rivers, Weir, Moonie'],
  ['IDQ60293', 'QLD', 'Condamine-Balonne, Maranoa'], ['IDQ60294', 'QLD', 'Warrego, Paroo, Bulloo'],
  ['IDQ60295', 'QLD', 'Channel Country'], ['IDQ60296', 'QLD', 'Gulf and Cape'],
  ['IDV60078', 'VIC', 'East Gippsland'], ['IDV60079', 'VIC', 'West and South Gippsland'],
  ['IDV60147', 'VIC', 'South West'], ['IDV60148', 'VIC', 'Wimmera, Mallee'],
  ['IDV60149', 'VIC', 'Campaspe, Loddon, Avoca'], ['IDV60150', 'VIC', 'Goulburn, Broken'],
  ['IDV60151', 'VIC', 'North East'], ['IDV60201', 'VIC', 'Melbourne rivers'],
  ['IDS60147', 'SA', 'Onkaparinga'], ['IDS60148', 'SA', 'Torrens'], ['IDS60149', 'SA', 'Gawler'],
  ['IDS60150', 'SA', 'Mid North, Flinders, Far North'], ['IDS60164', 'SA', 'Angas & Bremer'],
  ['IDS60165', 'SA', 'Light & Wakefield'], ['IDS60166', 'SA', 'River Murray'],
  ['IDW60400', 'WA', 'Kimberley'], ['IDW60401', 'WA', 'Pilbara'], ['IDW60402', 'WA', 'Gascoyne, Murchison'],
  ['IDW60403', 'WA', 'Midwest'], ['IDW60404', 'WA', 'Avon, Swan, Canning'],
  ['IDW60405', 'WA', 'Peel, South West'], ['IDW60406', 'WA', 'Lower South West'],
  ['IDW60407', 'WA', 'Albany and Esperance'],
  ['IDT60150', 'TAS', 'North West'], ['IDT60151', 'TAS', 'North'], ['IDT60152', 'TAS', 'South'],
  ['IDD60022', 'NT', 'Northern Territory']
];

/* BOM product prefixes by state. N covers the ACT too. */
export const STATE_BY_PREFIX = { N: 'NSW', V: 'VIC', Q: 'QLD', S: 'SA', W: 'WA', T: 'TAS', D: 'NT' };

/* Flood classification as BOM writes it, as a level the page can sort by.
   Anything not a flood level ("Below Flood Level", "No Classification",
   blank) is null -- a gauge with no class is not a gauge in flood. */
export const FLOOD_LEVELS = ['minor', 'moderate', 'major'];
export function floodLevel(text) {
  const t = String(text || '').toLowerCase();
  if (!t || /below|no class/.test(t)) return null;
  if (/major/.test(t)) return 'major';
  if (/moderate/.test(t)) return 'moderate';
  if (/minor/.test(t)) return 'minor';
  return null;
}

const TZ_OFFSET_H = { AEST: 10, AEDT: 11, ACST: 9.5, ACDT: 10.5, AWST: 8, AWDT: 9, CST: 9.5, EST: 10, WST: 8 };
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/* "Issued at 09:54 PM AEDT Saturday 14 November 2026" as an instant, and
   the offset it was written in, which every station time in the same
   table shares. */
export function parseIssued(text) {
  const m = /Issued at\s+(\d{1,2}):(\d{2})\s*([AP]M)\s+([A-Z]{3,4})\s+\w+\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i.exec(text || '');
  if (!m) return null;
  const off = TZ_OFFSET_H[m[4].toUpperCase()];
  const mon = MONTHS[m[6].toLowerCase()];
  if (off === undefined || mon === undefined) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const ms = Date.UTC(Number(m[7]), mon, Number(m[5]), h, Number(m[2])) - off * 3600e3;
  return { ms, offsetH: off, tz: m[4].toUpperCase() };
}

/* A station's "09.21PM Sat" as an instant: the latest such weekday and
   time no later than shortly after the table was issued. A reading is a
   day-of-week only, so this is the one honest way to date it. */
export function stationTime(text, issued) {
  const m = /^(\d{1,2})\.(\d{2})\s*([AP]M)\s+(\w{3})/i.exec(String(text || '').trim());
  if (!m || !issued) return null;
  const dow = DAYS[m[4].toLowerCase()];
  if (dow === undefined) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const localIssued = new Date(issued.ms + issued.offsetH * 3600e3);
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.UTC(localIssued.getUTCFullYear(), localIssued.getUTCMonth(),
      localIssued.getUTCDate() - back, h, Number(m[2])));
    if (d.getUTCDay() !== dow) continue;
    const ms = d.getTime() - issued.offsetH * 3600e3;
    if (ms <= issued.ms + 3600e3) return ms;
  }
  return null;
}

const cellText = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
const num = (t) => (t !== '' && isFinite(Number(t)) ? Number(t) : null);

/* One "Latest River Heights" table. Stations keep the catchment heading
   above them; the plot link gives BOM's station id and its own page. */
export function parseRiverHeights(html) {
  const issued = parseIssued(cellText((/Issued at[^<]{0,80}/i.exec(html) || [''])[0]));
  const head = [...((/<thead>[\s\S]*?<\/thead>/i.exec(html) || [''])[0]).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((m) => cellText(m[1]).toLowerCase());
  const col = (re, dflt) => { const i = head.findIndex((h) => re.test(h)); return i < 0 ? dflt : i; };
  const C = { name: col(/station name/, 0), type: col(/station type/, 1), time: col(/time/, 2), height: col(/height/, 3),
    datum: col(/datum/, 4), tendency: col(/tendency/, 5), crossing: col(/crossing/, 6), cls: col(/flood class/, 7) };
  const body = (/<tbody[\s\S]*<\/tbody>/i.exec(html) || [html])[0];
  const stations = [];
  let catchment = '';
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(tr[1]);
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (!tds.length) { if (th) catchment = cellText(th[1]); continue; }
    if (tds.length < 8) continue;
    const t = tds.map(cellText);
    const link = /href="([^"]*\.plt\.shtml)"/i.exec(tds[tds.length - 1] || '');
    const classText = t[C.cls] || '';
    const level = floodLevel(classText);
    /* Kept lean: ~3,600 gauges go to every reader, so only what the page
       shows. The plot path is BOM's own page for the gauge, minus host. */
    stations.push({
      catchment, name: t[C.name],
      time: stationTime(t[C.time], issued) || undefined,
      height: num(t[C.height]),
      tendency: (t[C.tendency] || '').toLowerCase() || undefined,
      level: level || undefined,
      /* "Below Flood Level" is the common case and says nothing a missing
         level does not; other wording ("No Classification") is kept. */
      classText: level || !classText || /below flood level/i.test(classText) ? undefined : classText,
      crossing: level ? t[C.crossing] || undefined : undefined,
      plot: link ? link[1].replace(/^\/fwo\//, '') : undefined
    });
  }
  return { issued: issued ? issued.ms : null, stations };
}

const xmlText = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
const tag = (xml, re) => { const m = re.exec(xml); return m ? xmlText(m[1]) : ''; };

/* One flood warning product, or null if the file is some other warning
   (marine wind, sheep graziers) -- the directory mixes them. */
export function parseFloodWarning(xml, file) {
  const service = tag(xml, /<service>([^<]*)<\/service>/i);
  const title = tag(xml, /<text type="warning_title">([\s\S]*?)<\/text>/i);
  if (service !== 'HFW' && !/flood (warning|watch)/i.test(title)) return null;
  const id = tag(xml, /<identifier>([^<]*)<\/identifier>/i) || String(file || '').replace(/\..*$/, '');
  const issuedUtc = Date.parse(tag(xml, /<issue-time-utc>([^<]*)<\/issue-time-utc>/i));
  const expiryUtc = Date.parse(tag(xml, /<expiry-time>([^<]*)<\/expiry-time>/i));
  const sev = tag(xml, /<element type="severity">([^<]*)<\/element>/i);
  /* The level the warning names, from its severity element or, failing
     that, its title ("Major Flood Warning for ..."). A watch or a final
     warning has none. */
  const level = floodLevel(sev) || floodLevel(title.replace(/flood warning.*$/i, ''));
  const situation = tag(xml, /<text type="warning_situation">([\s\S]*?)<\/text>/i);
  const areas = [...xml.matchAll(/<area\s[^>]*description="([^"]+)"[^>]*type="river-basin"/gi)].map((m) => m[1]);
  return {
    id, state: STATE_BY_PREFIX[id[2]] || undefined, title,
    level: level || undefined,
    final: /^final\b/i.test(title) || undefined,
    watch: /flood watch/i.test(title) || undefined,
    issued: isFinite(issuedUtc) ? issuedUtc : undefined,
    expires: isFinite(expiryUtc) ? expiryUtc : undefined,
    areas: [...new Set(areas)].slice(0, 12),
    situation: situation.slice(0, 1200) || undefined,
    nextIssue: tag(xml, /<text type="warning_next_issue">([\s\S]*?)<\/text>/i) || undefined,
    url: 'https://www.bom.gov.au/products/' + id + '.shtml'
  };
}

/* Everything the page needs, from one capture's files. `files` maps an FTP
   file name to its text; a product absent from it is reported missing. */
export function buildRiversSnapshot(files, now) {
  const products = [];
  /* Gauges grouped by catchment, so state and catchment are written once
     per group rather than on each of ~3,600 rows. */
  const groups = [];
  let gauges = 0;
  for (const [id, state, region] of RIVER_HEIGHT_PRODUCTS) {
    const html = files[id + '.html'];
    if (!html) { products.push({ id, state, region, ok: false, error: 'not in this capture' }); continue; }
    const r = parseRiverHeights(html);
    products.push({ id, state, region, ok: r.stations.length > 0, issued: r.issued || undefined, stations: r.stations.length,
      error: r.stations.length ? undefined : 'no stations read' });
    let g = null;
    for (const st of r.stations) {
      if (!g || g.catchment !== st.catchment) groups.push(g = { state, product: id, catchment: st.catchment, stations: [] });
      const { catchment, ...rest } = st;
      g.stations.push(rest);
      gauges++;
    }
  }
  const warnings = [];
  for (const [file, xml] of Object.entries(files)) {
    if (!/^ID[A-Z][23]\d{4}\.xml$/.test(file)) continue;
    const w = parseFloodWarning(xml, file);
    /* An expired warning is history; BOM leaves the file until it is
       replaced or removed. */
    if (w && !(w.expires && w.expires < now)) warnings.push(w);
  }
  const rank = (l) => (l ? FLOOD_LEVELS.indexOf(l) + 1 : 0);
  /* Active warnings worst first; a final warning -- the flood is over --
     after them all, whatever severity it still carries. */
  warnings.sort((a, b) => (a.final ? 1 : 0) - (b.final ? 1 : 0) || rank(b.level) - rank(a.level) || (b.issued || 0) - (a.issued || 0));
  const counts = { major: 0, moderate: 0, minor: 0, rising: 0, stations: gauges };
  groups.forEach((g) => g.stations.forEach((s) => { if (s.level) counts[s.level]++; if (s.tendency === 'rising') counts.rising++; }));
  return { capturedAt: now, source: 'Bureau of Meteorology, anonymous FTP (ftp.bom.gov.au/anon/gen/fwo)',
    counts, warnings, products, groups };
}
