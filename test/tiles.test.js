// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RANGE, glyphPath, parseRange, servableRange, serveTiles, tilesKey, currentTiles } from "../src/tiles.js";

test("the archive key must be a plain .pmtiles file name", () => {
  assert.equal(tilesKey({ TILES_KEY: "israel-20261013.pmtiles" }), "israel-20261013.pmtiles");
  for (const bad of ["../x.pmtiles", "x.mbtiles", "a/b.pmtiles", "", undefined, "X.pmtiles"]) assert.equal(tilesKey({ TILES_KEY: bad }), null, String(bad));
});

test("ranges: one start-end range is served; whole files, open ends, suffixes and huge ranges are not", () => {
  assert.deepEqual(parseRange("bytes=0-16383"), { offset: 0, length: 16384 });
  assert.deepEqual(parseRange("bytes=100-"), { offset: 100 });
  assert.deepEqual(parseRange("bytes=-500"), { suffix: 500 });
  assert.equal(parseRange(null), null);
  for (const bad of ["bytes=5-1", "bytes=0-1,4-5", "items=0-1", "bytes=-"]) assert.equal(parseRange(bad), "bad", bad);
  assert.deepEqual(servableRange(parseRange("bytes=10-19")), { offset: 10, length: 10 });
  assert.equal(servableRange(parseRange("bytes=100-")), null);
  assert.equal(servableRange(parseRange("bytes=-500")), null);
  assert.equal(servableRange({ offset: 0, length: MAX_RANGE + 1 }), null);
});

test("glyph paths: a plain font stack and one 256-code-point range", () => {
  assert.equal(glyphPath("Heebo Regular", "1280-1535.pbf"), "/map/fonts/Heebo%20Regular/1280-1535.pbf");
  for (const [s, f] of [["../etc", "0-255.pbf"], ["Heebo", "0-256.pbf"], ["Heebo", "1-256.pbf"], ["Heebo", "65536-65791.pbf"]]) assert.equal(glyphPath(s, f), null);
});

function bucket(bytes) {
  return {
    head: async (key) => ({ size: bytes.length, httpEtag: '"e1"', key }),
    get: async (_key, opts) => {
      const r = opts?.range ?? { offset: 0, length: bytes.length };
      return { size: bytes.length, httpEtag: '"e1"', arrayBuffer: async () => bytes.slice(r.offset, r.offset + r.length).buffer };
    },
  };
}
const KEY = "israel-20261013.pmtiles";
const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);

test("serving: a range comes back as 206 with its Content-Range; the wrong key, no range or a bad range do not", async () => {
  const env = { MAPS: bucket(bytes), TILES_KEY: KEY };
  const res = await serveTiles(env, new Request(`https://x.test/map/tiles/${KEY}`, { headers: { range: "bytes=10-19" } }), KEY);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 10-19/1000");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal((await serveTiles(env, new Request(`https://x.test/map/tiles/old.pmtiles`, { headers: { range: "bytes=0-1" } }), "old.pmtiles")).status, 404);
  assert.equal((await serveTiles(env, new Request(`https://x.test/map/tiles/${KEY}`), KEY)).status, 416);
  assert.equal((await serveTiles(env, new Request(`https://x.test/map/tiles/${KEY}`, { headers: { range: "bytes=9-1" } }), KEY)).status, 416);
  assert.equal((await serveTiles(env, new Request(`https://x.test/map/tiles/${KEY}`, { headers: { range: "bytes=5000-5009" } }), KEY)).status, 416);
});

test("/map/tiles names the current archive only once it is really in the bucket", async () => {
  assert.equal((await currentTiles({ TILES_KEY: KEY })).status, 404);
  const ok = await currentTiles({ MAPS: bucket(bytes), TILES_KEY: KEY });
  assert.deepEqual(await ok.json(), { url: `/map/tiles/${KEY}` });
});
