// Stremio addon serving live TV channels listed by iptv-org.
// Data comes from DATA_URL (built daily by scripts/build.mjs).

interface Env {
  DATA_URL: string;
}

interface Stream {
  url: string;
  quality: string | null;
  title: string | null;
}

interface Channel {
  id: string;
  name: string;
  country: string | null;
  categories: string[];
  logo: string | null;
  // ISO 639-3 codes, network and HD flag (absent in data built before 1.1.0).
  languages?: string[];
  network?: string | null;
  hd?: boolean;
  website: string | null;
  streams: Stream[];
}

interface Data {
  generated_at: string;
  categories: Record<string, string>;
  countries: Record<string, string>;
  channels: Channel[];
}

interface CatalogDef {
  id: string;
  name: string;
  // iptv-org category ids; null = every channel.
  categories: string[] | null;
}

interface Catalog extends CatalogDef {
  list: Channel[];
  // Country names present in this catalog (options of the genre filter).
  options: string[];
}

interface Index {
  data: Data;
  byId: Map<string, Channel>;
  catalogs: Map<string, Catalog>;
  searchKey: Map<string, string>;
}

const PAGE_SIZE = 100;
const EDGE_TTL = 3600;
// Last good copy kept at the edge for when GitHub is down.
const STALE_TTL = 7 * 24 * 3600;
const HEALTH_MAX_AGE_HOURS = 48;
const FEATURED_SIZE = 200;
const MEMO_TTL_MS = 10 * 60 * 1000;
const ID_PREFIX = 'yiptv:';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
};

// Catalogs by channel type. Channels are matched by iptv-org category id.
const TYPE_CATALOGS: CatalogDef[] = [
  { id: 'iptv-movies', name: 'Cine y series', categories: ['movies', 'series', 'classic', 'comedy'] },
  { id: 'iptv-sports', name: 'Deportes', categories: ['sports', 'outdoor', 'auto'] },
  { id: 'iptv-news', name: 'Noticias', categories: ['news', 'business', 'weather'] },
  { id: 'iptv-kids', name: 'Infantil', categories: ['kids', 'animation', 'family'] },
  { id: 'iptv-music', name: 'Música', categories: ['music'] },
  {
    id: 'iptv-docs',
    name: 'Documentales y cultura',
    categories: ['documentary', 'science', 'culture', 'education', 'travel'],
  },
  {
    id: 'iptv-entertainment',
    name: 'Entretenimiento',
    categories: ['entertainment', 'lifestyle', 'cooking', 'general', 'relax'],
  },
  { id: 'iptv-all', name: 'Todos los canales', categories: null },
];

// "Destacados" is a heuristic pick (no audience data): it leaves out these
// categories and ranks by language, network, HD and country.
const FEATURED_ID = 'iptv-featured';
const FEATURED_NAME = 'Destacados';
const FEATURED_EXCLUDED = new Set(['religious', 'shop', 'legislative', 'interactive']);
const FEATURED_COUNTRIES = new Set(['ES', 'MX', 'AR', 'CO', 'US', 'CL', 'PE']);

// Country catalogs of addon 1.0.0. Clients that still hold that manifest keep
// asking for them, so they are served from "Todos los canales" by country.
const LEGACY_COUNTRY_CATALOGS: Record<string, string> = { 'iptv-es': 'ES', 'iptv-mx': 'MX', 'iptv-us': 'US' };
const RELATED_SIZE = 40;

let memo: { index: Index; at: number } | null = null;

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function isData(d: unknown): d is Data {
  const x = d as Data;
  return !!x && Array.isArray(x.channels) && x.channels.length > 0 &&
    typeof x.categories === 'object' && typeof x.countries === 'object';
}

// Reads a cached payload, dropping the entry if it is not valid data.
async function readCached(cache: Cache, key: Request): Promise<Data | null> {
  const hit = await cache.match(key);
  if (!hit) return null;
  const d = await hit.json().catch(() => null);
  if (isData(d)) return d;
  await cache.delete(key);
  return null;
}

// Only a parsed, non-empty payload is cached at the edge, so a bad deploy of
// the data branch (HTML error page, wrong shape) can't pin a 502 for an hour.
// Two copies are kept: a fresh one (1 h) and a stale one (7 days) that is only
// read when the origin fails, so a GitHub outage doesn't take the addon down.
async function fetchData(env: Env): Promise<Data> {
  const cache = caches.default;
  const freshKey = new Request(env.DATA_URL);
  const staleKey = new Request(`${env.DATA_URL}?stale=1`);

  const fresh = await readCached(cache, freshKey);
  if (fresh) return fresh;

  try {
    const origin = await fetch(env.DATA_URL);
    if (!origin.ok) throw new Error(`data fetch failed: ${origin.status}`);
    const text = await origin.text();
    let d: unknown;
    try {
      d = JSON.parse(text);
    } catch {
      throw new Error('data is not JSON');
    }
    if (!isData(d)) throw new Error('data has no channels');
    const put = (key: Request, ttl: number) =>
      cache.put(key, new Response(text, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
      }));
    await Promise.all([put(freshKey, EDGE_TTL), put(staleKey, STALE_TTL)]);
    return d;
  } catch (e) {
    const stale = await readCached(cache, staleKey);
    if (stale) {
      console.error('iptv addon serving stale data:', e instanceof Error ? e.message : e);
      return stale;
    }
    throw e;
  }
}

// iptv-org ships English names. The app is mostly used in Spanish, and the
// genre filter matches these exact strings, so swap them once per data load.
const CATEGORY_ES: Record<string, string> = {
  animation: 'Animación', auto: 'Motor', business: 'Economía', classic: 'Clásicos',
  comedy: 'Comedia', cooking: 'Cocina', culture: 'Cultura', documentary: 'Documentales',
  education: 'Educación', entertainment: 'Entretenimiento', family: 'Familia',
  general: 'Generalista', kids: 'Infantil', legislative: 'Parlamento', lifestyle: 'Estilo de vida',
  movies: 'Cine', music: 'Música', news: 'Noticias', outdoor: 'Aire libre', public: 'Pública',
  relax: 'Relax', religious: 'Religión', science: 'Ciencia', series: 'Series', shop: 'Compras',
  sports: 'Deportes', travel: 'Viajes', weather: 'El tiempo', interactive: 'Interactivo',
};
// iptv-org uses UK where ISO 3166 (and Intl) use GB.
const REGION_ALIAS: Record<string, string> = { UK: 'GB' };

function localize(data: Data): void {
  const regions = new Intl.DisplayNames(['es'], { type: 'region' });
  for (const code of Object.keys(data.countries)) {
    try {
      const es = regions.of(REGION_ALIAS[code] ?? code);
      if (es && es !== code) data.countries[code] = es;
    } catch {
      // keep iptv-org's English name
    }
  }
  for (const id of Object.keys(data.categories)) {
    if (CATEGORY_ES[id]) data.categories[id] = CATEGORY_ES[id];
  }
}

async function loadIndex(env: Env): Promise<Index> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.index;

  let data: Data;
  try {
    data = await fetchData(env);
  } catch (e) {
    // Keep serving the last good copy and retry in a minute instead of
    // hitting the origin on every request while it is down.
    if (memo) {
      memo.at = Date.now() - MEMO_TTL_MS + 60_000;
      return memo.index;
    }
    throw e;
  }

  localize(data);

  const byId = new Map<string, Channel>();
  const searchKey = new Map<string, string>();
  for (const c of data.channels) {
    byId.set(c.id, c);
    searchKey.set(c.id, fold(c.name));
  }
  const index: Index = { data, byId, catalogs: buildCatalogs(data), searchKey };
  memo = { index, at: Date.now() };
  return index;
}

function hasLang(c: Channel, lang: string): boolean {
  return !!c.languages && c.languages.includes(lang);
}

function featuredScore(c: Channel): number {
  return (hasLang(c, 'spa') ? 4 : 0) + (hasLang(c, 'eng') ? 2 : 0) + (c.network ? 2 : 0) +
    (c.hd ? 1 : 0) + (c.country && FEATURED_COUNTRIES.has(c.country) ? 1 : 0);
}

// Spanish first, then English, then the rest; HD first within each group.
function langRank(c: Channel): number {
  return hasLang(c, 'spa') ? 0 : hasLang(c, 'eng') ? 1 : 2;
}

// Stable FNV-1a hash: breaks score ties without favouring early letters.
function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function byName(a: Channel, b: Channel): number {
  return a.name.localeCompare(b.name, 'es');
}

function byLanguageThenHd(a: Channel, b: Channel): number {
  return langRank(a) - langRank(b) || Number(!!b.hd) - Number(!!a.hd) || byName(a, b);
}

// Runs once per data load: sorted lists and genre options of every catalog.
function buildCatalogs(data: Data): Map<string, Catalog> {
  const defs: { def: CatalogDef; list: Channel[] }[] = [];

  const featured = data.channels
    .filter((c) => !c.categories.some((k) => FEATURED_EXCLUDED.has(k)))
    .map((c) => ({ c, score: featuredScore(c) }))
    .sort((a, b) => b.score - a.score || idHash(a.c.id) - idHash(b.c.id))
    .slice(0, FEATURED_SIZE)
    .map((x) => x.c);
  defs.push({ def: { id: FEATURED_ID, name: FEATURED_NAME, categories: null }, list: featured });

  for (const def of TYPE_CATALOGS) {
    const cats = def.categories;
    const list = cats ? data.channels.filter((c) => c.categories.some((k) => cats.includes(k))) : data.channels;
    defs.push({ def, list: [...list].sort(byLanguageThenHd) });
  }

  const catalogs = new Map<string, Catalog>();
  for (const { def, list } of defs) {
    const names = new Set<string>();
    for (const c of list) {
      const n = c.country && data.countries[c.country];
      if (n) names.add(n);
    }
    catalogs.set(def.id, { ...def, list, options: [...names].sort((a, b) => a.localeCompare(b, 'es')) });
  }
  return catalogs;
}

function json(body: unknown, status = 200, maxAge?: number): Response {
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (maxAge !== undefined) headers['Cache-Control'] = `public, max-age=${maxAge}`;
  return new Response(JSON.stringify(body), { status, headers });
}

function genresOf(ix: Index, c: Channel): string[] {
  return c.categories.map((k) => ix.data.categories[k]).filter(Boolean);
}

function countryName(ix: Index, c: Channel): string {
  return (c.country && ix.data.countries[c.country]) || '';
}

function description(ix: Index, c: Channel): string {
  return [countryName(ix, c), genresOf(ix, c).join(', ')].filter(Boolean).join(' · ');
}

function buildManifest(ix: Index) {
  const catalogs = [...ix.catalogs.values()].map((cat) => ({
    type: 'tv',
    id: cat.id,
    name: cat.name,
    extra: [{ name: 'genre', options: cat.options }, { name: 'search' }, { name: 'skip' }],
  }));
  return {
    id: 'com.yammbo.iptv',
    version: '1.1.0',
    name: 'Yammbo TV en vivo',
    description:
      'Canales de TV en vivo por tipo: destacados, cine y series, deportes, noticias, infantil, música y más, filtrables por país. Son emisiones públicas listadas por iptv-org; el vídeo llega directamente desde cada canal.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: [ID_PREFIX],
    behaviorHints: { configurable: false },
    catalogs,
  };
}

function parseExtra(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  // Some clients percent-encode the whole query (genre%3DX%26skip%3D0).
  if (!raw.includes('=')) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
  }
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? '' : part.slice(eq + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function toMeta(ix: Index, c: Channel) {
  return {
    id: ID_PREFIX + c.id,
    type: 'tv',
    name: c.name,
    releaseInfo: 'En vivo',
    poster: c.logo ?? undefined,
    posterShape: 'square',
    logo: c.logo ?? undefined,
    genres: genresOf(ix, c),
    description: description(ix, c),
  };
}

function buildCatalog(ix: Index, catalogId: string, extra: Record<string, string>) {
  const legacy = LEGACY_COUNTRY_CATALOGS[catalogId];
  const cat = ix.catalogs.get(legacy ? 'iptv-all' : catalogId);
  if (!cat) return null;
  let list = legacy ? cat.list.filter((c) => c.country === legacy) : cat.list;

  if (extra.genre) {
    const g = extra.genre;
    list = list.filter((c) => countryName(ix, c) === g);
  }
  if (extra.search) {
    const q = fold(extra.search.trim());
    if (q) list = list.filter((c) => ix.searchKey.get(c.id)!.includes(q));
  }
  const skip = Math.max(0, parseInt(extra.skip ?? '0', 10) || 0);
  return { metas: list.slice(skip, skip + PAGE_SIZE).map((c) => toMeta(ix, c)) };
}

// Channels to zap to from the player: the first type catalog the channel
// belongs to, same country first. Each one carries its stream so the web
// player can open it directly.
function buildRelated(ix: Index, c: Channel) {
  const def = TYPE_CATALOGS.find((d) => d.categories && c.categories.some((k) => d.categories!.includes(k)));
  const cat = ix.catalogs.get(def ? def.id : FEATURED_ID)!;
  const others = cat.list.filter((x) => x.id !== c.id && x.streams.length > 0);
  const sameCountry = others.filter((x) => x.country && x.country === c.country);
  const rest = others.filter((x) => !(x.country && x.country === c.country));
  return {
    catalog: { id: cat.id, name: cat.name },
    channels: [...sameCountry, ...rest].slice(0, RELATED_SIZE).map((x) => ({
      id: ID_PREFIX + x.id,
      name: x.name,
      logo: x.logo ?? undefined,
      description: description(ix, x),
      stream: { url: x.streams[0].url, name: 'Yammbo TV', description: streamTitle(x.streams[0]) },
    })),
  };
}

function streamTitle(s: Stream): string {
  return `${s.quality ?? 'Auto'} · En vivo`;
}

function pickChannel(ix: Index, rawId: string): Channel | undefined {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return undefined;
  }
  if (id.startsWith(ID_PREFIX)) id = id.slice(ID_PREFIX.length);
  return ix.byId.get(id);
}

async function health(env: Env): Promise<Response> {
  let body: { ok: boolean; generated_at: string | null; age_hours: number | null; channels: number };
  try {
    const ix = await loadIndex(env);
    const ageHours = (Date.now() - Date.parse(ix.data.generated_at)) / 3_600_000;
    body = {
      ok: ageHours < HEALTH_MAX_AGE_HOURS,
      generated_at: ix.data.generated_at,
      age_hours: Math.round(ageHours * 10) / 10,
      channels: ix.data.channels.length,
    };
  } catch {
    body = { ok: false, generated_at: null, age_hours: null, channels: 0 };
  }
  return new Response(JSON.stringify(body), {
    status: body.ok ? 200 : 503,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405);
  }

  let path = new URL(request.url).pathname;
  if (path === '/iptv' || path.startsWith('/iptv/')) path = path.slice('/iptv'.length) || '/';

  const notFound = () => json({ error: 'not found' }, 404);

  if (path === '/health') return health(env);

  if (path === '/manifest.json') {
    return json(buildManifest(await loadIndex(env)), 200, 3600);
  }

  let m = /^\/catalog\/tv\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(path);
  if (m) {
    const ix = await loadIndex(env);
    let catalogId: string;
    try {
      catalogId = decodeURIComponent(m[1]);
    } catch {
      return notFound();
    }
    const body = buildCatalog(ix, catalogId, parseExtra(m[2]));
    return body ? json(body, 200, 3600) : notFound();
  }

  m = /^\/meta\/tv\/([^/]+)\.json$/.exec(path);
  if (m) {
    const ix = await loadIndex(env);
    const c = pickChannel(ix, m[1]);
    if (!c) return json({ meta: null }, 404);
    return json(
      {
        meta: {
          ...toMeta(ix, c),
          website: c.website ?? undefined,
          country: countryName(ix, c) || undefined,
        },
      },
      200,
      3600,
    );
  }

  m = /^\/related\/tv\/([^/]+)\.json$/.exec(path);
  if (m) {
    const ix = await loadIndex(env);
    const c = pickChannel(ix, m[1]);
    if (!c) return json({ catalog: null, channels: [] }, 404);
    return json(buildRelated(ix, c), 200, 3600);
  }

  m = /^\/stream\/tv\/([^/]+)\.json$/.exec(path);
  if (m) {
    const ix = await loadIndex(env);
    const c = pickChannel(ix, m[1]);
    const streams = (c?.streams ?? []).map((s) => ({
      url: s.url,
      name: 'Yammbo TV',
      title: streamTitle(s),
      // No behaviorHints.proxyHeaders: stremio-core then rewrites the URL to the
      // local streaming server (127.0.0.1:11470) even when there is none, and
      // the web player never reaches the channel. The player's HEAD probe is
      // checked by scripts/build.mjs instead.
    }));
    return json({ streams }, 200, 600);
  }

  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('iptv addon error', e instanceof Error ? e.message : e);
      return json({ error: 'data unavailable' }, 502);
    }
  },
};
