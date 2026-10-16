// Copyright 2026 Qder AI (Itay Funes). Licensed under the Apache License, Version 2.0.
/**
 * The map, served by us (no third party at runtime).
 *
 *   /map/tiles               Which archive is current: { url: "/map/tiles/<TILES_KEY>" }, or 404 while there is none.
 *   /map/tiles/<TILES_KEY>   One Protomaps PMTiles archive of Israel on R2 (bucket israel-map, binding MAPS, the object
 *                            named by the TILES_KEY var), read by the page's pmtiles protocol with HTTP Range
 *                            requests. VERSIONED : a refresh uploads a new key and changes the
 *                            var, so the URL and every edge-cache entry change with it and no page ever mixes ranges
 *                            of two archives. Built with tools/extract-pmtiles.mjs; README.md.
 *   /map/fonts/<stack>/<a>-<b>.pbf   SDF glyphs built from our own Heebo (tools/build-glyphs.mjs), static files
 *                            under public/map/fonts. A range the font has no letters in is answered with an empty
 *                            glyph set (a valid, empty protobuf) instead of a 404 the map would log as an error.
 *
 * Both are public and carry nothing about anybody: the same bytes for every visitor, cached at the edge.
 */

/** Pure. The archive the TILES_KEY var names, if it is a plain file name (it is part of a URL), else null. */
export function tilesKey(env                        )                {
  const k = String(env.TILES_KEY ?? "").trim();
  return /^[a-z0-9][a-z0-9._-]{0,80}\.pmtiles$/.test(k) && !k.includes("..") ? k : null;
}

/** GET /map/tiles: where the current archive is, once it is really there (one HEAD to R2, cached briefly). */
export async function currentTiles(env     )                    {
  const key = tilesKey(env);
  const head = key && env.MAPS ? await env.MAPS.head(key).catch(() => null) : null;
  if (!key || !head) return new Response(JSON.stringify({ error: "no map yet" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  return new Response(JSON.stringify({ url: `/map/tiles/${key}` }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}

/**
 * Pure. One HTTP byte range ("bytes=0-16383", "bytes=100-", "bytes=-500"), or null for no Range header, or
 * "bad" for anything else (several ranges, garbage, end before start). pmtiles asks for exactly one range.
 */
export function parseRange(header                           )                           {
  if (header == null || header === "") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  if (m[1] === "") {
    const suffix = Number(m[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : "bad";
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return "bad";
  if (m[2] === "") return { offset: start };
  const end = Number(m[2]);
  if (!Number.isSafeInteger(end) || end < start) return "bad";
  return { offset: start, length: end - start + 1 };
}

const TILE_HEADERS = {
  "content-type": "application/vnd.pmtiles",
  "accept-ranges": "bytes",
  // The URL carries the archive's key, and a new archive is a new key: the bytes at a URL never change.
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
};

/** The largest range one request may read : pmtiles asks for a 16 KB header, directories, tiles. */
export const MAX_RANGE = 2 * 1024 * 1024;

/**
 * Pure. Whether a parsed range may be served: one explicit start-end range of at most MAX_RANGE. A GET without a
 * range (the whole archive), an open-ended or suffix range, or a bigger one is refused, so nobody pulls the
 * archive through the Worker in one go; pmtiles always sends start-end.
 */
export function servableRange(r                          )                                            {
  if (!r || r === "bad" || "suffix" in r || r.length === undefined) return null;
  return r.length > 0 && r.length <= MAX_RANGE ? { offset: r.offset, length: r.length } : null;
}

const refuse = (text        ) => new Response(text, { status: 416, headers: { "accept-ranges": "bytes" } });

/**
 * GET (with one Range) or HEAD /map/tiles/<key>. 404 for any key but the current one, and while the bucket or
 * the archive is not there yet. Every range is cached at the edge (caches.default) under the versioned URL plus
 * the range, so an area's tiles are read from R2 once per data centre, not once per visitor, and a new archive
 * (a new key) never meets an old archive's cached bytes. The Cache API will not store a 206, so the bytes are
 * kept as a 200 under a key of their own and answered as the 206 the browser asked for.
 */
export async function serveTiles(env     , req         , asked        , ctx                                           )                    {
  const TILES_KEY = tilesKey(env);
  if (!env.MAPS || !TILES_KEY || asked !== TILES_KEY) return new Response("not found", { status: 404 });
  if (req.method === "HEAD") {
    const head = await env.MAPS.head(TILES_KEY);
    if (!head) return new Response(null, { status: 404 });
    return new Response(null, { headers: { ...TILE_HEADERS, "content-length": String(head.size), etag: head.httpEtag } });
  }
  const parsed = parseRange(req.headers.get("range"));
  if (parsed === null) return refuse("a Range is required");
  const range = servableRange(parsed);
  if (!range) return refuse(`one start-end range of at most ${MAX_RANGE} bytes`);

  const cache = typeof caches !== "undefined" ? (caches                                  ).default : undefined;
  const key = new Request(`${new URL(req.url).origin}/map/tiles/${TILES_KEY}?bytes=${range.offset}-${range.offset + range.length - 1}`);
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) {
    return new Response(hit.body, {
      status: 206,
      headers: { ...TILE_HEADERS, "content-length": hit.headers.get("content-length") ?? "", "content-range": hit.headers.get("x-content-range") ?? "", etag: hit.headers.get("etag") ?? "" },
    });
  }

  const obj = await env.MAPS.get(TILES_KEY, { range });
  if (!obj) return new Response("not found", { status: 404 });
  if (range.offset >= obj.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${obj.size}`, "accept-ranges": "bytes" } });
  const length = Math.min(range.length, obj.size - range.offset);
  const contentRange = `bytes ${range.offset}-${range.offset + length - 1}/${obj.size}`;
  const bytes = await obj.arrayBuffer();
  if (cache) {
    const put = cache.put(key, new Response(bytes.slice(0), {
      headers: { "content-type": TILE_HEADERS["content-type"], "content-length": String(length), "x-content-range": contentRange, etag: obj.httpEtag, "cache-control": "public, max-age=2592000" },
    })).catch(() => undefined);
    if (ctx) ctx.waitUntil(put); else await put;
  }
  return new Response(bytes, { status: 206, headers: { ...TILE_HEADERS, "content-length": String(length), "content-range": contentRange, etag: obj.httpEtag } });
}

/** Pure. A glyph request we serve: a font stack of plain words and a 256-code-point range, or null. */
export function glyphPath(stack        , file        )                {
  if (!/^[A-Za-z][A-Za-z ]{0,39}$/.test(stack)) return null;
  const m = /^(\d{1,5})-(\d{1,5})\.pbf$/.exec(file);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (a % 256 !== 0 || b !== a + 255 || b > 65535) return null;
  return `/map/fonts/${encodeURIComponent(stack)}/${a}-${b}.pbf`;
}

const GLYPH_HEADERS = {
  "content-type": "application/x-protobuf",
  "cache-control": "public, max-age=604800",
  "x-content-type-options": "nosniff",
};

/** /map/fonts/:stack/:file: the built glyph file, or an empty set for a range our font has no letters in. */
export async function serveGlyphs(env     , req         , stack        , file        )                    {
  const path = glyphPath(stack, file);
  if (!path) return new Response("not found", { status: 404 });
  const res = await env.ASSETS.fetch(new Request(new URL(path, req.url)));
  if (res.ok) return new Response(res.body, { headers: GLYPH_HEADERS });
  return new Response(new Uint8Array(0), { headers: GLYPH_HEADERS });
}
