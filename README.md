# yammbo-iptv

Stremio addon (Cloudflare Worker) that serves live TV channels listed by
[iptv-org](https://github.com/iptv-org/iptv) to the Stremio web fork at
tv.yammbo.com/app. The video goes straight from the channel to the viewer;
this service only serves small JSON.

## How the data is generated

`scripts/build.mjs` (Node 20, no dependencies) downloads the iptv-org API and
probes every candidate stream the way a browser would: HTTPS only, playlist,
first variant and first segment must answer with open CORS
(`*` or `https://tv.yammbo.com`), and the stream must not need a custom
User-Agent or Referer. It keeps up to 3 working streams per channel and writes
`dist/channels.json` and `dist/report.json` (failure counts by reason).

A daily GitHub Action (`.github/workflows/build-data.yml`) runs it and
force-pushes `dist/` as a single commit to the orphan branch `data`; the Worker
reads `channels.json` from there (`DATA_URL` in `wrangler.toml`).

Env vars: `LIMIT=N` probes N random candidates (local tests),
`PROBE_CONCURRENCY` (default 48).

## Local testing

```sh
LIMIT=400 node scripts/build.mjs
python3 -m http.server 8799 --bind 127.0.0.1 --directory dist &
npx wrangler dev --port 8798 --var DATA_URL:http://127.0.0.1:8799/channels.json
curl http://127.0.0.1:8798/iptv/manifest.json
```

Routes work with or without the `/iptv` prefix. The route
`tv.yammbo.com/iptv/*` is not configured yet.
