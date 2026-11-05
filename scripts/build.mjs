// Builds dist/channels.json from the iptv-org API, keeping only streams that
// a browser at https://tv.yammbo.com can actually play with hls.js
// (https, open CORS on playlist and segments, no required UA/Referer).
import { mkdir, writeFile } from 'node:fs/promises';

// DNS lookups (getaddrinfo) run on the libuv threadpool (4 threads by default).
// With dozens of probes in flight, dead hosts starve it and everything times
// out. Setting it here is too late (the ESM loader already started the pool),
// so it must come from the environment: see package.json and the workflow.
if (Number(process.env.UV_THREADPOOL_SIZE || 4) < 32) {
  console.warn('WARNING: run with UV_THREADPOOL_SIZE=128 or probes will time out falsely');
}

const API = 'https://iptv-org.github.io/api';
const ORIGIN = 'https://tv.yammbo.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY) || 48;
const LIMIT = Number(process.env.LIMIT) || 0;
const TIMEOUT_MS = 8000;
const MAX_BODY = 256 * 1024;
const MAX_STREAMS_PER_CHANNEL = 3;
// Publishing guards (full runs only): never replace good data with a near-empty
// catalog because the API changed shape or the runner's network failed.
const MIN_CHANNELS = Number(process.env.MIN_CHANNELS) || 1000;
const MAX_DROP = 0.5; // fail if channels fall below half of the previous build
const PREVIOUS_URL = process.env.PREVIOUS_URL || '';

async function getJson(name) {
  const res = await fetch(`${API}/${name}.json`);
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  return res.json();
}

class Fail extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// After a cross-origin redirect the browser sends `Origin: null`, so only a
// wildcard satisfies CORS from then on.
function corsOk(res, tainted = false) {
  const v = res.headers.get('access-control-allow-origin');
  return v === '*' || (!tainted && v === ORIGIN);
}

const MAX_REDIRECTS = 5;

// Fetches a URL with an 8 s budget (headers + body). With readBody, returns
// the text (max 256 KB); otherwise cancels the body right after the headers.
// Redirects are followed by hand, the way a browser does a CORS fetch: every
// hop must carry an open ACAO header and stay on https, or the player fails.
// `cors` is the failure code used when a hop has no valid ACAO header.
async function get(url, { readBody, cors, method = 'GET' }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let current = new URL(url);
    let tainted = false;
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(current.href, {
        method,
        redirect: 'manual',
        signal: ctl.signal,
        headers: { Origin: tainted ? 'null' : ORIGIN, 'User-Agent': UA, Accept: '*/*' },
      });
      const loc = res.headers.get('location');
      // Only the codes a browser follows; 300/304/305 end the chain as errors.
      if (![301, 302, 303, 307, 308].includes(res.status) || !loc) break;
      await res.body?.cancel();
      if (!corsOk(res, tainted)) throw new Fail(cors);
      if (hop >= MAX_REDIRECTS) throw new Fail('http_status');
      const nextUrl = new URL(loc, current);
      if (nextUrl.protocol !== 'https:') throw new Fail('insecure_redirect');
      if (nextUrl.origin !== current.origin) tainted = true;
      current = nextUrl;
    }
    if (res.ok && !corsOk(res, tainted)) {
      await res.body?.cancel();
      throw new Fail(cors);
    }
    res.finalUrl = current.href;
    if (!readBody) {
      await res.body?.cancel();
      return { res, text: '' };
    }
    let text = '';
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        text += dec.decode(value, { stream: true });
        if (size >= MAX_BODY) {
          await reader.cancel();
          break;
        }
      }
    }
    return { res, text };
  } catch (e) {
    if (e instanceof Fail) throw e;
    if (e.name === 'AbortError' || ctl.signal.aborted) throw new Fail('timeout');
    throw new Fail('error');
  } finally {
    clearTimeout(timer);
  }
}

function firstUri(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return null;
}

// Checks one playlist: status 200, #EXTM3U, open CORS. `corsReason` is the
// failure code used when the CORS header is wrong at this level.
async function checkPlaylist(url, corsReason) {
  const { res, text } = await get(url, { readBody: true, cors: corsReason });
  if (res.status !== 200) throw new Fail('http_status');
  if (!text.includes('#EXTM3U')) throw new Fail('no_m3u');
  return { text, base: res.finalUrl };
}

function isM3u8Path(url) {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function probe(url) {
  try {
    let { text, base } = await checkPlaylist(url, 'no_cors_playlist');
    if (text.includes('#EXT-X-STREAM-INF')) {
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
      let uri = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          uri = lines[j];
          break;
        }
      }
      if (!uri) throw new Fail('no_m3u');
      let variant;
      try {
        variant = new URL(uri, base);
      } catch {
        throw new Fail('error');
      }
      if (variant.protocol !== 'https:') throw new Fail('insecure_variant');
      ({ text, base } = await checkPlaylist(variant.href, 'no_cors_variant'));
    }
    const segUri = firstUri(text);
    if (!segUri) throw new Fail('no_m3u');
    let seg;
    try {
      seg = new URL(segUri, base);
    } catch {
      throw new Fail('error');
    }
    if (seg.protocol !== 'https:') throw new Fail('insecure_segment');
    const { res } = await get(seg.href, { readBody: false, cors: 'no_cors_segment' });
    if (res.status !== 200 && res.status !== 206) throw new Fail('http_status');
    // The web player (stremio-video getContentType) first sends a CORS HEAD to
    // the stream URL and only uses hls.js when the content-type is exactly
    // this; anything else goes to <video src>, which Chrome can't play.
    // .m3u8 paths skip it: browsers with native HLS fall back to <video src>
    // and the rest get hls.js without the HEAD (Yammbo-Tv-web
    // patches/getContentType.yambo-hls.js, same isM3u8Path test).
    if (isM3u8Path(url)) return { ok: true };
    const head = await get(url, { readBody: false, cors: 'no_cors_head', method: 'HEAD' });
    if (!head.res.ok) throw new Fail('head_status');
    if (head.res.headers.get('content-type') !== 'application/vnd.apple.mpegurl') {
      throw new Fail('head_not_hls');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Fail ? e.reason : 'error' };
  }
}

function qualityNum(q) {
  const m = /(\d+)/.exec(q || '');
  return m ? parseInt(m[1], 10) : null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function main() {
  const [channels, streams, logos, blocklist, categories, countries, feeds] = await Promise.all(
    ['channels', 'streams', 'logos', 'blocklist', 'categories', 'countries', 'feeds'].map(getJson),
  );

  const chById = new Map(channels.map((c) => [c.id, c]));
  const blocked = new Set(blocklist.map((b) => b.channel));

  let candidates = streams.filter((s) => {
    if (!s.channel || !s.url || !s.url.startsWith('https://')) return false;
    if (s.user_agent || s.referrer) return false;
    const c = chById.get(s.channel);
    if (!c || c.is_nsfw || c.closed || blocked.has(c.id)) return false;
    return true;
  });
  // Same URL listed twice: probe once.
  const seen = new Set();
  candidates = candidates.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  const totalCandidates = candidates.length;
  if (LIMIT > 0) candidates = shuffle(candidates).slice(0, LIMIT);

  console.log(
    `Candidates: ${totalCandidates}; probing ${candidates.length} (concurrency ${CONCURRENCY})`,
  );

  const failures = {};
  const okByChannel = new Map();
  let next = 0;
  let done = 0;
  let okCount = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= candidates.length) return;
      const s = candidates[i];
      const r = await probe(s.url);
      if (r.ok) {
        okCount++;
        if (!okByChannel.has(s.channel)) okByChannel.set(s.channel, []);
        okByChannel.get(s.channel).push(s);
      } else {
        failures[r.reason] = (failures[r.reason] || 0) + 1;
      }
      if (++done % 500 === 0) console.log(`  ${done}/${candidates.length} probed, ${okCount} ok`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

  // Logos: first https logo with null feed, else any https logo of the channel.
  const logoBy = new Map();
  for (const l of logos) {
    if (!l.channel || !l.url || !l.url.startsWith('https://')) continue;
    const cur = logoBy.get(l.channel);
    if (!cur || (cur.feed && !l.feed)) logoBy.set(l.channel, l);
  }

  // Languages (ISO 639-3) per channel: those of its main feeds, or the union of
  // all its feeds when none is flagged as main.
  const mainLangs = new Map();
  const allLangs = new Map();
  for (const f of feeds) {
    if (!f.channel) continue;
    const target = f.is_main ? mainLangs : allLangs;
    if (!target.has(f.channel)) target.set(f.channel, new Set());
    for (const l of f.languages || []) target.get(f.channel).add(l);
  }
  const languagesOf = (id) => [...(mainLangs.get(id)?.size ? mainLangs.get(id) : allLangs.get(id) || [])];

  const catNames = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const countryNames = Object.fromEntries(countries.map((c) => [c.code, c.name]));
  const usedCats = {};
  const usedCountries = {};

  const out = [];
  let keptStreams = 0;
  for (const [id, list] of okByChannel) {
    const c = chById.get(id);
    list.sort((a, b) => {
      const qa = qualityNum(a.quality);
      const qb = qualityNum(b.quality);
      if (qa === qb) return 0;
      if (qa === null) return 1;
      if (qb === null) return -1;
      return qb - qa;
    });
    const kept = list
      .slice(0, MAX_STREAMS_PER_CHANNEL)
      .map((s) => ({ url: s.url, quality: s.quality || null, title: s.title || null }));
    keptStreams += kept.length;
    const cats = (c.categories || []).filter((k) => catNames[k]);
    for (const k of cats) usedCats[k] = catNames[k];
    if (c.country && countryNames[c.country]) usedCountries[c.country] = countryNames[c.country];
    out.push({
      id,
      name: c.name,
      country: c.country || null,
      categories: cats,
      logo: logoBy.get(id)?.url || null,
      languages: languagesOf(id),
      network: c.network || null,
      // `list` is sorted best quality first.
      hd: (qualityNum(list[0].quality) ?? 0) >= 720,
      website: c.website || null,
      streams: kept,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));

  const data = {
    generated_at: new Date().toISOString(),
    source: 'iptv-org',
    counts: {
      candidates: totalCandidates,
      probed: candidates.length,
      ok_streams: okCount,
      channels: out.length,
    },
    categories: usedCats,
    countries: usedCountries,
    channels: out,
  };

  if (LIMIT === 0) {
    if (out.length < MIN_CHANNELS) {
      throw new Error(`only ${out.length} channels (< ${MIN_CHANNELS}); not publishing`);
    }
    if (PREVIOUS_URL) {
      const prev = await fetch(PREVIOUS_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const prevCount = prev?.counts?.channels || 0;
      if (prevCount && out.length < prevCount * MAX_DROP) {
        throw new Error(`channels dropped ${prevCount} -> ${out.length}; not publishing`);
      }
      console.log(`previous build: ${prevCount || 'none'} channels`);
    }
  }

  await mkdir('dist', { recursive: true });
  await writeFile('dist/channels.json', JSON.stringify(data));
  await writeFile('dist/report.json', JSON.stringify({ probed: candidates.length, ok: okCount, failures }));

  console.log('--- Summary ---');
  console.log(`candidates: ${totalCandidates}`);
  console.log(`probed:     ${candidates.length}`);
  console.log(`ok streams: ${okCount} (kept ${keptStreams})`);
  console.log(`channels:   ${out.length}`);
  console.log('failures:', JSON.stringify(failures));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
