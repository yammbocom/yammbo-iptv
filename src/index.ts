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
  website: string | null;
  streams: Stream[];
}

interface Data {
  generated_at: string;
  categories: Record<string, string>;
  countries: Record<string, string>;
  channels: Channel[];
}

interface Index {
  data: Data;
  byId: Map<string, Channel>;
  byCountry: Map<string, Channel[]>;
  searchKey: Map<string, string>;
}

const PAGE_SIZE = 100;
const EDGE_TTL = 3600;
const MEMO_TTL_MS = 10 * 60 * 1000;
const ID_PREFIX = 'yiptv:';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
};

const COUNTRY_CATALOGS: { id: string; name: string; country: string }[] = [
  { id: 'iptv-es', name: 'En vivo · España', country: 'ES' },
  { id: 'iptv-mx', name: 'En vivo · México', country: 'MX' },
  { id: 'iptv-us', name: 'En vivo · EE. UU.', country: 'US' },
];

let memo: { index: Index; at: number } | null = null;

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function isData(d: unknown): d is Data {
  const x = d as Data;
  return !!x && Array.isArray(x.channels) && x.channels.length > 0 &&
    typeof x.categories === 'object' && typeof x.countries === 'object';
}

// Only a parsed, non-empty payload is cached at the edge, so a bad deploy of
// the data branch (HTML error page, wrong shape) can't pin a 502 for an hour.
async function fetchData(env: Env): Promise<Data> {
  const cache = caches.default;
  const cacheKey = new Request(env.DATA_URL);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const d = await hit.json().catch(() => null);
    if (isData(d)) return d;
    await cache.delete(cacheKey);
  }
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
  await cache.put(cacheKey, new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${EDGE_TTL}` },
  }));
  return d;
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

  const byId = new Map<string, Channel>();
  const byCountry = new Map<string, Channel[]>();
  const searchKey = new Map<string, string>();
  for (const c of data.channels) {
    byId.set(c.id, c);
    if (c.country) {
      const list = byCountry.get(c.country);
      if (list) list.push(c);
      else byCountry.set(c.country, [c]);
    }
    searchKey.set(c.id, fold(c.name));
  }
  const index: Index = { data, byId, byCountry, searchKey };
  memo = { index, at: Date.now() };
  return index;
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
  const catalogs: { type: string; id: string; name: string; extra: { name: string; options?: string[] }[] }[] =
    COUNTRY_CATALOGS.map((cc) => {
    const names = new Set<string>();
    for (const c of ix.byCountry.get(cc.country) ?? []) {
      for (const g of genresOf(ix, c)) names.add(g);
    }
    return {
      type: 'tv',
      id: cc.id,
      name: cc.name,
      extra: [
        { name: 'genre', options: [...names].sort((a, b) => a.localeCompare(b)) },
        { name: 'skip' },
      ],
    };
  });
  const countries = Object.values(ix.data.countries).sort((a, b) => a.localeCompare(b));
  catalogs.push({
    type: 'tv',
    id: 'iptv-all',
    name: 'En vivo · Todos los países',
    extra: [{ name: 'genre', options: countries }, { name: 'search' }, { name: 'skip' }],
  });
  return {
    id: 'com.yammbo.iptv',
    version: '1.0.0',
    name: 'Yammbo TV en vivo',
    description:
      'Canales de TV en vivo. Son emisiones públicas listadas por iptv-org; el vídeo llega directamente desde cada canal.',
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
    poster: c.logo ?? undefined,
    posterShape: 'square',
    logo: c.logo ?? undefined,
    genres: genresOf(ix, c),
    description: description(ix, c),
  };
}

function buildCatalog(ix: Index, catalogId: string, extra: Record<string, string>) {
  let list: Channel[];
  const cc = COUNTRY_CATALOGS.find((x) => x.id === catalogId);
  if (cc) list = ix.byCountry.get(cc.country) ?? [];
  else if (catalogId === 'iptv-all') list = ix.data.channels;
  else return null;

  if (extra.genre) {
    const g = extra.genre;
    list = list.filter((c) =>
      cc ? genresOf(ix, c).includes(g) : countryName(ix, c) === g,
    );
  }
  if (extra.search && catalogId === 'iptv-all') {
    const q = fold(extra.search.trim());
    if (q) list = list.filter((c) => ix.searchKey.get(c.id)!.includes(q));
  }
  const skip = Math.max(0, parseInt(extra.skip ?? '0', 10) || 0);
  return { metas: list.slice(skip, skip + PAGE_SIZE).map((c) => toMeta(ix, c)) };
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

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405);
  }

  let path = new URL(request.url).pathname;
  if (path === '/iptv' || path.startsWith('/iptv/')) path = path.slice('/iptv'.length) || '/';

  const notFound = () => json({ error: 'not found' }, 404);

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

  m = /^\/stream\/tv\/([^/]+)\.json$/.exec(path);
  if (m) {
    const ix = await loadIndex(env);
    const c = pickChannel(ix, m[1]);
    const streams = (c?.streams ?? []).map((s) => ({
      url: s.url,
      name: 'Yammbo TV',
      title: `${s.quality ?? 'Auto'} · En vivo`,
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
