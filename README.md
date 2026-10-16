# israel-map-r2

A self-hosted vector map of Israel, with Hebrew labels drawn right to left, served entirely from your own
Cloudflare account. No Google Maps bill, no map provider's script on your page, and the visitor's location goes to
nobody but you.

- **Tiles**: one [PMTiles](https://github.com/protomaps/PMTiles) archive of Israel (an extract of a Protomaps
  OpenStreetMap build) in an **R2** bucket, read by the browser with HTTP **range requests** through a Worker that
  caches every range at the edge.
- **Map**: [MapLibre GL](https://maplibre.org)'s **CSP build** (its tile worker is a file you serve, never a
  `blob:`), the pmtiles protocol and the RTL text plugin, all served from your own origin.
- **Style**: OpenStreetMap's standard look (OSM Carto colours and road widths) on the Protomaps schema, with POI
  icons drawn on a canvas (no sprite sheet to host).
- **Labels**: SDF glyphs you build from an open font (Heebo by default), so Hebrew and Latin share one typeface.

We run this in production at [qder.ai](https://qder.ai).

## Quick start

```sh
npm install
npm run vendor     # MapLibre CSP build, pmtiles, RTL plugin -> public/vendor/maplibre
npm run glyphs     # fonts/*.woff2 -> public/map/fonts (see fonts/README.md)

# Cut Israel out of a Protomaps daily build (pure JS, no Go binary). --estimate first to see the size.
npm run extract -- --src latest --bbox 34.2,29.45,35.95,33.35 --minzoom 0 --maxzoom 15 --out israel-20261013.pmtiles

# Upload it under a NEW key every time, then point TILES_KEY at it.
npx wrangler r2 bucket create israel-map
npx wrangler r2 object put israel-map/israel-20261013.pmtiles --file israel-20261013.pmtiles --remote --content-type application/vnd.pmtiles

cp wrangler.toml.example wrangler.toml
npx wrangler deploy
```

Open the Worker's URL: `public/index.html` draws Haifa. Use the client in your own page:

```js
import { drawMap } from "/js/map.js";
const map = await drawMap(element, { lat: 32.0853, lng: 34.7818 }, { interactive: true, zoom: 15 });
if (!map) { /* no WebGL, or no archive yet: show your fallback */ }
```

Archives over ~300 MB are too big for `wrangler r2 object put`; `tools/extract-pmtiles.mjs` explains the multipart
upload through R2's S3 API.

## The Worker (`src/tiles.js`)

| Route | What |
|---|---|
| `GET /map/tiles` | `{ "url": "/map/tiles/<TILES_KEY>" }` once the archive is really in the bucket, else 404 (the page then skips the map). |
| `GET /map/tiles/<TILES_KEY>` | One byte range of the archive, as 206. Only the current key; one `start-end` range of at most 2 MB (no whole-file downloads through the Worker). `HEAD` gives the size. |
| `GET /map/fonts/<stack>/<a>-<b>.pbf` | The glyph file, or an empty glyph set for a range the font has no letters in (instead of a 404 the map logs as an error). |

**Versioned keys:** every refresh is a new object name and a new `TILES_KEY`. The URL then changes with the bytes,
so tiles can be cached as immutable for a year and no browser or edge cache ever mixes ranges of two archives.
The Cache API refuses to store a 206, so each range is cached as a 200 under its own key and answered as the 206
the browser asked for.

## Content Security Policy

The page needs only your own origin, plus two allowances for MapLibre:

```
worker-src 'self'; img-src 'self' data: blob:; connect-src 'self'
```

## Attribution

The map data is © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open
Database License (ODbL 1.0). **Every map you show must credit it**; `drawMap` adds the line for you. The tiles are
built by [Protomaps](https://protomaps.com). MapLibre GL (BSD-3-Clause), pmtiles (BSD-3-Clause) and
mapbox-gl-rtl-text (BSD-2-Clause) keep their own licences, copied next to them by `npm run vendor`.

## Tests

```sh
npm test
```

## License

The code is Apache-2.0, copyright 2026 Qder AI. The map data, fonts and vendored libraries are under their own
licences (above).
