#!/usr/bin/env node
// Cuts a PMTiles v3 archive out of a remote Protomaps basemap build with HTTP Range requests,
// in pure JS (no pmtiles/go binary). The map serves the result from R2 at /map/tiles/<TILES_KEY> (wrangler.toml).
//
// RUNBOOK
//   npm install --prefix tools/map
//
//   1. The full Israel archive (z0-15). Estimate first (directories only, no tile data):
//        node tools/extract-pmtiles.mjs --src latest --bbox 34.2,29.45,35.95,33.35 --minzoom 0 --maxzoom 15 --estimate
//      then cut it:
//        node tools/extract-pmtiles.mjs --src latest --bbox 34.2,29.45,35.95,33.35 --minzoom 0 --maxzoom 15 --out israel.pmtiles
//      (--src takes a build date such as 20261013, "latest" from https://build-metadata.protomaps.dev/builds.json,
//      a full URL, or a local .pmtiles path. Keep the archive OUT of the repo.)
//
//   2. Upload to R2 (bucket israel-map, a NEW key per refresh, e.g. israel-20261013.pmtiles; then set TILES_KEY in wrangler.toml):
//        npx wrangler r2 bucket create israel-map --location weur
//        npx wrangler r2 object put israel-map/israel-YYYYMMDD.pmtiles --file israel-YYYYMMDD.pmtiles --remote --content-type application/vnd.pmtiles
//      `wrangler r2 object put` uploads in one request and refuses objects over ~300 MB (315 MB). For a larger
//      archive use R2's S3-compatible API with a multipart upload from npm, no binaries:
//        - in the dashboard, R2 > Manage API tokens: an "Object Read & Write" token scoped to israel-map
//          (gives an Access Key ID + Secret; the endpoint is https://<ACCOUNT_ID>.r2.cloudflarestorage.com);
//        - npm install --prefix <scratch> @aws-sdk/client-s3 @aws-sdk/lib-storage
//        - new Upload({ client: new S3Client({ region: "auto", endpoint, credentials }),
//            params: { Bucket: "israel-map", Key: "israel-YYYYMMDD.pmtiles", Body: fs.createReadStream(file),
//                      ContentType: "application/vnd.pmtiles" }, partSize: 64 * 1024 * 1024, queueSize: 4 }).done()
//        - delete the token afterwards. (rclone is a binary: not allowed here.)
//
//   3. Local dev (wrangler dev reads the local R2 simulation):
//        node tools/extract-pmtiles.mjs --src latest --bbox 34.2,29.45,35.95,33.35 --minzoom 0 --maxzoom 10 \
//             --also 34.95,32.77,35.06,32.84:11:15 --out fixture-haifa.pmtiles
//        npx wrangler r2 object put israel-map/israel-20261013.pmtiles --file fixture-haifa.pmtiles --local
//
// OPTIONS
//   --src <date|latest|url|file>   source archive (Protomaps v4 basemap builds are PMTiles v3 files)
//   --bbox minLon,minLat,maxLon,maxLat --minzoom N --maxzoom N    the main region
//   --also minLon,minLat,maxLon,maxLat:minzoom:maxzoom            extra region(s), repeatable (e.g. a city at z11-15)
//   --out <file>                   output archive
//   --estimate                     read directories only; print tiles, bytes, expected size and request count
//   --gap <bytes>                  merge source ranges closer than this (default 1 MiB)
//   --chunk <bytes>                largest single range request (default 32 MiB)
//   --concurrency N                parallel range requests (default 4)
//   --no-verify                    skip reading the result back with the pmtiles package
//
// Output layout: 127-byte header | root directory | metadata | leaf directories | tile data, all directories
// and the metadata gzip-compressed, tile data clustered in tile-id order, identical tiles stored once
// (source offset+length is the identity: the Protomaps builds are already deduplicated) and consecutive
// identical tiles folded into run lengths.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { PMTiles, zxyToTileId, tileIdToZxy, bytesToHeader } from "pmtiles";

const BUILDS = "https://build-metadata.protomaps.dev/builds.json";
const BUILD_URL = (key) => `https://build.protomaps.com/${key}`;
const HEADER_LEN = 127;
const ROOT_MAX = 16384 - HEADER_LEN;

// ---------- arguments ----------
function parseArgs(argv) {
  const o = { also: [], gap: 1 << 20, chunk: 32 << 20, concurrency: 4, verify: true, estimate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--src") o.src = v();
    else if (a === "--bbox") o.bbox = v().split(",").map(Number);
    else if (a === "--minzoom") o.minzoom = Number(v());
    else if (a === "--maxzoom") o.maxzoom = Number(v());
    else if (a === "--also") {
      const [b, z0, z1] = v().split(":");
      o.also.push({ bbox: b.split(",").map(Number), minzoom: Number(z0), maxzoom: Number(z1) });
    } else if (a === "--out") o.out = v();
    else if (a === "--gap") o.gap = Number(v());
    else if (a === "--chunk") o.chunk = Number(v());
    else if (a === "--concurrency") o.concurrency = Number(v());
    else if (a === "--estimate") o.estimate = true;
    else if (a === "--no-verify") o.verify = false;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.src || !o.bbox || o.bbox.length !== 4 || !(o.minzoom >= 0) || !(o.maxzoom >= o.minzoom)) {
    throw new Error("need --src, --bbox minLon,minLat,maxLon,maxLat, --minzoom, --maxzoom");
  }
  if (!o.estimate && !o.out) throw new Error("need --out (or --estimate)");
  o.regions = [{ bbox: o.bbox, minzoom: o.minzoom, maxzoom: o.maxzoom }, ...o.also];
  return o;
}

async function resolveSrc(src) {
  if (/^\d{8}$/.test(src)) return BUILD_URL(`${src}.pmtiles`);
  if (src === "latest") {
    const builds = await (await fetch(BUILDS)).json();
    const last = builds.map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort().pop();
    return BUILD_URL(last);
  }
  return src;
}

// ---------- byte sources ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReader(src) {
  if (!/^https?:/.test(src)) {
    const fd = fs.openSync(src, "r");
    return {
      key: src, requests: 0,
      async read(offset, length) {
        this.requests++;
        const b = Buffer.alloc(length);
        fs.readSync(fd, b, 0, length, offset);
        return b;
      },
    };
  }
  return {
    key: src, requests: 0, etag: null,
    async read(offset, length) {
      this.requests++;
      let err;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const res = await fetch(src, { headers: { range: `bytes=${offset}-${offset + length - 1}` } });
          if (res.status !== 206) throw new Error(`HTTP ${res.status} for range ${offset}+${length}`);
          const etag = res.headers.get("etag");
          if (etag && this.etag && etag !== this.etag) throw new Error(`source changed (etag ${this.etag} -> ${etag})`);
          if (etag) this.etag = etag;
          const b = Buffer.from(await res.arrayBuffer());
          if (b.length !== length) throw new Error(`short read ${b.length}/${length} at ${offset}`);
          return b;
        } catch (e) {
          err = e;
          if (String(e.message).startsWith("source changed")) throw e;
          await sleep(500 * 2 ** attempt);
        }
      }
      throw err;
    },
  };
}

// ---------- directories ----------
function readVarint(buf, pos) {
  let v = 0, mul = 1, b;
  do { b = buf[pos.i++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
  return v;
}

function gunzipIf(buf, compression) {
  if (compression === 2) return zlib.gunzipSync(buf);
  if (compression === 1 || compression === 0) return buf;
  throw new Error(`unsupported internal compression ${compression}`);
}

function parseDirectory(buf) {
  const pos = { i: 0 };
  const n = readVarint(buf, pos);
  const e = Array.from({ length: n }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 0 }));
  let last = 0;
  for (let k = 0; k < n; k++) { last += readVarint(buf, pos); e[k].tileId = last; }
  for (let k = 0; k < n; k++) e[k].runLength = readVarint(buf, pos);
  for (let k = 0; k < n; k++) e[k].length = readVarint(buf, pos);
  for (let k = 0; k < n; k++) {
    const v = readVarint(buf, pos);
    e[k].offset = v === 0 && k > 0 ? e[k - 1].offset + e[k - 1].length : v - 1;
  }
  return e;
}

function writeVarint(out, v) {
  while (v >= 0x80) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}

function serializeDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);
  let last = 0;
  for (const e of entries) { writeVarint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  entries.forEach((e, k) => {
    if (k > 0 && e.offset === entries[k - 1].offset + entries[k - 1].length) writeVarint(out, 0);
    else writeVarint(out, e.offset + 1);
  });
  return zlib.gzipSync(Buffer.from(out), { level: 9 });
}

// Root (+ leaves when it does not fit in the first 16 KiB), as go-pmtiles does.
function buildDirectories(entries) {
  const root = serializeDirectory(entries);
  if (root.length <= ROOT_MAX) return { root, leaves: Buffer.alloc(0) };
  for (let leafSize = 4096; ; leafSize *= 2) {
    const rootEntries = [], parts = [];
    let off = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = serializeDirectory(entries.slice(i, i + leafSize));
      rootEntries.push({ tileId: entries[i].tileId, offset: off, length: leaf.length, runLength: 0 });
      parts.push(leaf); off += leaf.length;
    }
    const r = serializeDirectory(rootEntries);
    if (r.length <= ROOT_MAX) return { root: r, leaves: Buffer.concat(parts) };
  }
}

function findEntry(entries, tileId) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = tileId - entries[mid].tileId;
    if (c > 0) lo = mid + 1; else if (c < 0) hi = mid - 1; else return entries[mid];
  }
  if (hi >= 0) {
    const e = entries[hi];
    if (e.runLength === 0) return e; // a leaf pointer
    if (tileId - e.tileId < e.runLength) return e;
  }
  return null;
}

function header(buf) {
  const h = bytesToHeader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  if (h.specVersion !== 3) throw new Error(`source spec version ${h.specVersion}, need 3`);
  return h;
}

function writeHeader(h) {
  const b = Buffer.alloc(HEADER_LEN);
  b.write("PMTiles", 0, "latin1");
  b.writeUInt8(3, 7);
  const u64 = (v, at) => b.writeBigUInt64LE(BigInt(v), at);
  u64(h.rootDirectoryOffset, 8); u64(h.rootDirectoryLength, 16);
  u64(h.jsonMetadataOffset, 24); u64(h.jsonMetadataLength, 32);
  u64(h.leafDirectoryOffset, 40); u64(h.leafDirectoryLength, 48);
  u64(h.tileDataOffset, 56); u64(h.tileDataLength, 64);
  u64(h.numAddressedTiles, 72); u64(h.numTileEntries, 80); u64(h.numTileContents, 88);
  b.writeUInt8(1, 96); // clustered
  b.writeUInt8(h.internalCompression, 97);
  b.writeUInt8(h.tileCompression, 98);
  b.writeUInt8(h.tileType, 99);
  b.writeUInt8(h.minZoom, 100); b.writeUInt8(h.maxZoom, 101);
  const i32 = (deg, at) => b.writeInt32LE(Math.round(deg * 1e7), at);
  i32(h.minLon, 102); i32(h.minLat, 106); i32(h.maxLon, 110); i32(h.maxLat, 114);
  b.writeUInt8(h.centerZoom, 118); i32(h.centerLon, 119); i32(h.centerLat, 123);
  return b;
}

// ---------- tile ranges ----------
const lon2x = (lon, n) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
const lat2y = (lat, n) => {
  const r = (lat * Math.PI) / 180;
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
};

function wantedTileIds(regions) {
  const ids = new Set();
  for (const { bbox: [w, s, e, n], minzoom, maxzoom } of regions) {
    for (let z = minzoom; z <= maxzoom; z++) {
      const N = 2 ** z;
      const x0 = lon2x(w, N), x1 = lon2x(e, N), y0 = lat2y(n, N), y1 = lat2y(s, N);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) ids.add(zxyToTileId(z, x, y));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

// Groups sorted [offset, length] ranges into requests: merge while the gap is small and the request stays under chunk.
function coalesce(ranges, gap, chunk) {
  const reqs = [];
  for (const r of ranges) {
    const last = reqs[reqs.length - 1];
    if (last && r.offset - (last.offset + last.length) <= gap && r.offset + r.length - last.offset <= chunk) {
      last.length = Math.max(last.length, r.offset + r.length - last.offset);
      last.items.push(r);
    } else reqs.push({ offset: r.offset, length: r.length, items: [r] });
  }
  return reqs;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function locateTiles(reader, h, ids) {
  const rootBuf = await reader.read(h.rootDirectoryOffset, h.rootDirectoryLength);
  const root = parseDirectory(gunzipIf(rootBuf, h.internalCompression));
  const leafCache = new Map();
  // Which leaves do we need? Resolve level by level (Protomaps planets have one leaf level; deeper is handled).
  let pending = ids.map((id) => ({ id, dir: root }));
  const found = [];
  while (pending.length) {
    const needLeaves = new Map();
    const next = [];
    for (const p of pending) {
      const e = findEntry(p.dir, p.id);
      if (!e) continue;
      if (e.runLength > 0) { found.push({ tileId: p.id, offset: e.offset, length: e.length }); continue; }
      const key = h.leafDirectoryOffset + e.offset;
      if (!leafCache.has(key)) needLeaves.set(key, { offset: key, length: e.length });
      next.push({ id: p.id, key });
    }
    if (needLeaves.size) {
      const reqs = coalesce([...needLeaves.values()].sort((a, b) => a.offset - b.offset), 256 << 10, 16 << 20);
      for (const r of reqs) {
        const buf = await reader.read(r.offset, r.length);
        for (const it of r.items) {
          leafCache.set(it.offset, parseDirectory(gunzipIf(buf.subarray(it.offset - r.offset, it.offset - r.offset + it.length), h.internalCompression)));
        }
        process.stderr.write(`\rdirectories: ${leafCache.size} leaves read`);
      }
    }
    pending = next.map((p) => ({ id: p.id, dir: leafCache.get(p.key) }));
  }
  if (leafCache.size) process.stderr.write("\n");
  return found.sort((a, b) => a.tileId - b.tileId);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const src = await resolveSrc(o.src);
  const reader = makeReader(src);
  const t0 = Date.now();
  console.log(`source ${src}`);
  const h = header(await reader.read(0, HEADER_LEN));
  console.log(`source: z${h.minZoom}-${h.maxZoom}, ${h.numAddressedTiles} tiles, tile compression ${h.tileCompression}, type ${h.tileType}`);

  const ids = wantedTileIds(o.regions);
  const tiles = await locateTiles(reader, h, ids);
  // unique contents in source-offset order (= tile-id order of first use in a clustered archive)
  const uniq = new Map();
  for (const t of tiles) if (!uniq.has(t.offset)) uniq.set(t.offset, { offset: h.tileDataOffset + t.offset, length: t.length, src: t.offset });
  const contents = [...uniq.values()].sort((a, b) => a.offset - b.offset);
  const dataBytes = contents.reduce((s, c) => s + c.length, 0);
  const reqs = coalesce(contents, o.gap, o.chunk);
  const fetchBytes = reqs.reduce((s, r) => s + r.length, 0);
  const perZoom = {};
  for (const t of tiles) { const z = tileIdToZxy(t.tileId)[0]; perZoom[z] = (perZoom[z] || 0) + 1; }
  console.log(`wanted ${ids.length} tile ids, ${tiles.length} present in source, ${contents.length} unique contents`);
  console.log(`per zoom: ${Object.entries(perZoom).map(([z, n]) => `z${z}:${n}`).join(" ")}`);
  console.log(`tile data ${mb(dataBytes)}; ${reqs.length} range requests downloading ${mb(fetchBytes)} (gap ${mb(o.gap)}, chunk ${mb(o.chunk)})`);
  if (o.estimate) { console.log(`estimate done in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${reader.requests} requests`); return; }

  // Download, writing unique contents to a temp data file in order.
  const tmp = `${o.out}.data.tmp`;
  const fd = fs.openSync(tmp, "w");
  const newOffset = new Map();
  let written = 0, done = 0, doneBytes = 0;
  const inflight = new Map();
  let nextStart = 0;
  const startOne = (i) => inflight.set(i, reader.read(reqs[i].offset, reqs[i].length));
  for (; nextStart < Math.min(o.concurrency, reqs.length); nextStart++) startOne(nextStart);
  for (let i = 0; i < reqs.length; i++) {
    const buf = await inflight.get(i);
    inflight.delete(i);
    if (nextStart < reqs.length) startOne(nextStart++);
    const r = reqs[i];
    for (const it of r.items) {
      const slice = buf.subarray(it.offset - r.offset, it.offset - r.offset + it.length);
      fs.writeSync(fd, slice);
      newOffset.set(it.src, written);
      written += it.length;
    }
    done++; doneBytes += r.length;
    const secs = (Date.now() - t0) / 1000;
    process.stderr.write(`\rtiles: ${done}/${reqs.length} requests, ${mb(doneBytes)}/${mb(fetchBytes)}, ${(doneBytes / 1048576 / secs).toFixed(1)} MB/s   `);
  }
  process.stderr.write("\n");
  fs.closeSync(fd);

  // Entries with run lengths.
  const entries = [];
  for (const t of tiles) {
    const off = newOffset.get(t.offset);
    const last = entries[entries.length - 1];
    if (last && last.offset === off && last.tileId + last.runLength === t.tileId) last.runLength++;
    else entries.push({ tileId: t.tileId, offset: off, length: t.length, runLength: 1 });
  }
  const { root, leaves } = buildDirectories(entries);

  // Metadata: the source's, with our extent.
  const metaBuf = await reader.read(h.jsonMetadataOffset, h.jsonMetadataLength);
  const meta = JSON.parse(gunzipIf(metaBuf, h.internalCompression).toString("utf8"));
  const w = Math.min(...o.regions.map((r) => r.bbox[0])), s = Math.min(...o.regions.map((r) => r.bbox[1]));
  const e = Math.max(...o.regions.map((r) => r.bbox[2])), n = Math.max(...o.regions.map((r) => r.bbox[3]));
  const minZoom = Math.min(...o.regions.map((r) => r.minzoom)), maxZoom = Math.max(...o.regions.map((r) => r.maxzoom));
  const c = o.regions[o.regions.length - 1];
  const center = [(c.bbox[0] + c.bbox[2]) / 2, (c.bbox[1] + c.bbox[3]) / 2, o.regions.length > 1 ? c.minzoom : Math.min(maxZoom, minZoom + 8)];
  meta.bounds = [w, s, e, n].join(",");
  meta.center = center.join(",");
  meta.minzoom = String(minZoom);
  meta.maxzoom = String(maxZoom);
  meta.extract = { source: src, regions: o.regions, created: new Date().toISOString() };
  const metaOut = zlib.gzipSync(Buffer.from(JSON.stringify(meta)), { level: 9 });

  const oh = {
    rootDirectoryOffset: HEADER_LEN, rootDirectoryLength: root.length,
    jsonMetadataOffset: HEADER_LEN + root.length, jsonMetadataLength: metaOut.length,
    leafDirectoryOffset: HEADER_LEN + root.length + metaOut.length, leafDirectoryLength: leaves.length,
    tileDataOffset: HEADER_LEN + root.length + metaOut.length + leaves.length, tileDataLength: written,
    numAddressedTiles: tiles.length, numTileEntries: entries.length, numTileContents: contents.length,
    internalCompression: 2, tileCompression: h.tileCompression, tileType: h.tileType,
    minZoom, maxZoom, minLon: w, minLat: s, maxLon: e, maxLat: n,
    centerZoom: center[2], centerLon: center[0], centerLat: center[1],
  };
  const out = fs.openSync(o.out, "w");
  fs.writeSync(out, writeHeader(oh));
  fs.writeSync(out, root);
  fs.writeSync(out, metaOut);
  fs.writeSync(out, leaves);
  const tfd = fs.openSync(tmp, "r");
  const chunk = Buffer.alloc(8 << 20);
  for (let pos = 0; pos < written;) {
    const nRead = fs.readSync(tfd, chunk, 0, chunk.length, pos);
    fs.writeSync(out, chunk, 0, nRead);
    pos += nRead;
  }
  fs.closeSync(tfd); fs.closeSync(out); fs.rmSync(tmp);
  const size = fs.statSync(o.out).size;
  console.log(`wrote ${o.out}: ${mb(size)} (${size} bytes), ${tiles.length} tiles, ${entries.length} entries, ${contents.length} contents, ` +
    `leaves ${leaves.length} B, ${reader.requests} source requests, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  if (o.verify) await verify(o.out, src, tiles);
}

// Reads the result back with the pmtiles package and compares sample tiles with the source.
async function verify(file, src, tiles) {
  const fd = fs.openSync(file, "r");
  const local = new PMTiles({
    getKey: () => file,
    getBytes: async (offset, length) => {
      const b = Buffer.alloc(length);
      const n = fs.readSync(fd, b, 0, length, offset);
      return { data: b.buffer.slice(b.byteOffset, b.byteOffset + n) };
    },
  });
  const remote = new PMTiles(/^https?:/.test(src) ? src : {
    getKey: () => src,
    getBytes: async (offset, length) => {
      const f = fs.openSync(src, "r"); const b = Buffer.alloc(length); fs.readSync(f, b, 0, length, offset); fs.closeSync(f);
      return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) };
    },
  });
  const lh = await local.getHeader();
  console.log(`verify header: spec ${lh.specVersion}, z${lh.minZoom}-${lh.maxZoom}, bounds ${[lh.minLon, lh.minLat, lh.maxLon, lh.maxLat].map((v) => v.toFixed(3)).join(",")}, ` +
    `${lh.numAddressedTiles} tiles, clustered ${lh.clustered}`);
  const meta = await local.getMetadata();
  console.log(`verify metadata: ${Object.keys(meta).length} keys, vector_layers ${(meta.vector_layers || []).length}, attribution ${JSON.stringify(meta.attribution || "").slice(0, 120)}`);
  const sample = [];
  const byZoom = new Map();
  for (const t of tiles) { const z = tileIdToZxy(t.tileId)[0]; if (!byZoom.has(z)) byZoom.set(z, []); byZoom.get(z).push(t); }
  for (const list of byZoom.values()) { sample.push(list[0], list[list.length >> 1], list[list.length - 1]); }
  let ok = 0;
  for (const t of sample) {
    const [z, x, y] = tileIdToZxy(t.tileId);
    const [a, b] = await Promise.all([local.getZxy(z, x, y), remote.getZxy(z, x, y)]);
    const same = a && b && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
    if (same) ok++; else console.log(`MISMATCH ${z}/${x}/${y}`);
  }
  // a tile outside every region must be absent
  const outside = await local.getZxy(10, 0, 0);
  console.log(`verify tiles: ${ok}/${sample.length} sample tiles identical to the source; outside tile 10/0/0 ${outside ? "PRESENT (bad)" : "absent"}`);
  fs.closeSync(fd);
  if (ok !== sample.length || outside) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
