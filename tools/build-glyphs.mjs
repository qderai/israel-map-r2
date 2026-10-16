#!/usr/bin/env node
// Builds the map's SDF glyph PBFs from our own fonts, so MapLibre
// never asks a third party for a label glyph.
//
//   npm install --prefix tools/map        (once; tools/node_modules stays untracked)
//   node tools/build-glyphs.mjs       (writes public/map/fonts/<Stack>/<start>-<end>.pbf)
//   node tools/build-glyphs.mjs --calibrate
//       Build-time only: fetches Protomaps' Noto Sans Regular 0-255.pbf, renders the
//       same glyphs from Noto Sans (npm @fontsource/noto-sans) with this file's code and
//       prints both sets of metrics plus the mean bitmap difference. Nothing is written.
//
// Format (what MapLibre GL reads, the node-fontnik conventions):
//   message glyphs    { repeated fontstack stacks = 1; }
//   message fontstack { required string name = 1; required string range = 2; repeated glyph glyphs = 3; }
//   message glyph     { required uint32 id = 1; optional bytes bitmap = 2; required uint32 width = 3;
//                       required uint32 height = 4; required sint32 left = 5; required sint32 top = 6;
//                       required uint32 advance = 7; }
//   24 px per em, buffer 3, radius 8, cutoff 0.25; bitmap is (width+6) x (height+6) bytes, row 0 on top;
//   value = 255 - clamp(distance_px * 256/8 + 64) with distance negative inside, so the edge is 191.
//
// Rasteriser: the outline is flattened to line segments (as fontnik does), each pixel centre takes
// its exact Euclidean distance to the nearest segment (capped at the radius) and its inside/outside
// from the nonzero winding rule. That is fontnik's method (it measures distance to segments, it does
// not run an EDT on a coverage grid), so no tiny-sdf code is copied here.
//
// `top`: fontnik writes bbox_top - ascender, where ascender is FreeType's rounded size ascender.
// MapLibre's own client-side glyph path uses a fixed 27 for every font, because MapLibre's label
// layout (SHAPING_DEFAULT_OFFSET and the line-height centring) is tuned to that number. We use one
// fixed offset for every stack too (TOP_OFFSET, calibrated against Protomaps' Noto Sans with
// --calibrate), so Heebo labels centre on their anchor exactly as Noto/Open Sans ones do, instead of
// moving with Heebo's own, much taller, hhea ascender.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import opentype from "opentype.js";
import Pbf from "pbf";

const require = createRequire(import.meta.url);
const wawoff2 = require("wawoff2");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// Put the font files here (woff2 or ttf), e.g. Heebo from Google Fonts (SIL OFL 1.1): see README.
const FONTS = path.join(REPO, "fonts");
const OUT = path.join(REPO, "public", "map", "fonts");

const SIZE = 24;
const BUFFER = 3;
const RADIUS = 8;
const CUTOFF = 0.25;
// px between a glyph's bbox top and the `top` written (see the header). Calibrated: --calibrate.
const TOP_OFFSET = 25;

const STACKS = [
  { name: "Heebo Regular", files: ["heebo-400-latin.woff2", "heebo-400-hebrew.woff2"] },
  { name: "Heebo Medium", files: ["heebo-500-latin.woff2", "heebo-500-hebrew.woff2"] },
];

// Code points worth a glyph on a map label: printable Latin/Latin-1, Latin Extended bits the
// subsets carry, Hebrew, Hebrew presentation forms, general punctuation, currency, a few symbols.
function wanted(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  if (cp > 0xffff) return false;
  return true;
}

export async function loadFont(file) {
  const buf = fs.readFileSync(file);
  let ttf = buf;
  if (buf.subarray(0, 4).toString("latin1") === "wOF2") ttf = Buffer.from(await wawoff2.decompress(buf));
  const ab = ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength);
  return opentype.parse(ab);
}

// Outline in font units (y up) -> closed rings of [x, y] in px at SIZE.
function flatten(glyph, scale) {
  const rings = [];
  let ring = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const push = (x, y) => { ring.push([x * scale, y * scale]); cx = x; cy = y; };
  const steps = (len) => Math.max(2, Math.min(32, Math.ceil(len * scale / 1.5)));
  for (const c of glyph.path.commands) {
    if (c.type === "M") {
      if (ring && ring.length > 2) rings.push(ring);
      ring = []; sx = c.x; sy = c.y; push(c.x, c.y);
    } else if (c.type === "L") {
      push(c.x, c.y);
    } else if (c.type === "Q") {
      const x0 = cx, y0 = cy;
      const n = steps(Math.hypot(c.x1 - x0, c.y1 - y0) + Math.hypot(c.x - c.x1, c.y - c.y1));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        push(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === "C") {
      const x0 = cx, y0 = cy;
      const n = steps(Math.hypot(c.x1 - x0, c.y1 - y0) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        push(u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
             u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y);
      }
    } else if (c.type === "Z") {
      if (ring && ring.length > 2) rings.push(ring);
      ring = null; cx = sx; cy = sy;
    }
  }
  if (ring && ring.length > 2) rings.push(ring);
  return rings;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// Renders one glyph the fontnik way. Returns { id, bitmap, width, height, left, top, advance }.
export function renderGlyph(font, glyph, id) {
  const scale = SIZE / font.unitsPerEm;
  const advance = Math.floor(glyph.advanceWidth * scale + 1e-6);
  const rings = flatten(glyph, scale);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!rings.length) return { id, bitmap: null, width: 0, height: 0, left: 0, top: -TOP_OFFSET, advance };
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const width = x1 - x0, height = y1 - y0;
  if (width === 0 || height === 0) return { id, bitmap: null, width: 0, height: 0, left: 0, top: -TOP_OFFSET, advance };

  const segs = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      segs.push([a[0], a[1], b[0], b[1]]);
    }
  }
  const bw = width + 2 * BUFFER, bh = height + 2 * BUFFER;
  const bitmap = new Uint8Array(bw * bh);
  const r2 = RADIUS * RADIUS;
  for (let y = 0; y < bh; y++) {
    const gy = bh - y - 0.5 + y0 - BUFFER;
    for (let x = 0; x < bw; x++) {
      const gx = x + 0.5 + x0 - BUFFER;
      let best = r2, wind = 0;
      for (const [ax, ay, bx, by] of segs) {
        // nonzero winding: count signed crossings of the ray to +x
        if (ay <= gy) {
          if (by > gy && (bx - ax) * (gy - ay) - (gx - ax) * (by - ay) > 0) wind++;
        } else if (by <= gy && (bx - ax) * (gy - ay) - (gx - ax) * (by - ay) < 0) wind--;
        if (Math.min(ax, bx) - gx > RADIUS || gx - Math.max(ax, bx) > RADIUS ||
            Math.min(ay, by) - gy > RADIUS || gy - Math.max(ay, by) > RADIUS) continue;
        const d2 = segDist2(gx, gy, ax, ay, bx, by);
        if (d2 < best) best = d2;
      }
      let d = Math.sqrt(best) * (256 / RADIUS);
      if (wind !== 0) d = -d;
      d += CUTOFF * 256;
      let n = d > 255 ? 255 : Math.trunc(d);
      if (n < 0) n = 0;
      bitmap[y * bw + x] = 255 - n;
    }
  }
  return { id, bitmap, width, height, left: x0, top: y1 - TOP_OFFSET, advance };
}

function writeGlyph(g, pbf) {
  pbf.writeVarintField(1, g.id);
  if (g.bitmap && g.bitmap.length) pbf.writeBytesField(2, g.bitmap);
  pbf.writeVarintField(3, g.width);
  pbf.writeVarintField(4, g.height);
  pbf.writeSVarintField(5, g.left);
  pbf.writeSVarintField(6, g.top);
  pbf.writeVarintField(7, g.advance);
}

export function encodeRange(name, start, glyphs) {
  const pbf = new Pbf();
  pbf.writeMessage(1, (_, p) => {
    p.writeStringField(1, name);
    p.writeStringField(2, `${start}-${start + 255}`);
    for (const g of glyphs) p.writeMessage(3, writeGlyph, g);
  }, null);
  return pbf.finish();
}

export function decodeRange(buf) {
  const glyphs = [];
  let name = "", range = "";
  new Pbf(buf).readFields((tag, _, pbf) => {
    if (tag !== 1) return;
    pbf.readMessage((t, __, p) => {
      if (t === 1) name = p.readString();
      else if (t === 2) range = p.readString();
      else if (t === 3) {
        const g = { id: 0, bitmap: null, width: 0, height: 0, left: 0, top: 0, advance: 0 };
        p.readMessage((k, o, q) => {
          if (k === 1) o.id = q.readVarint();
          else if (k === 2) o.bitmap = q.readBytes();
          else if (k === 3) o.width = q.readVarint();
          else if (k === 4) o.height = q.readVarint();
          else if (k === 5) o.left = q.readSVarint();
          else if (k === 6) o.top = q.readSVarint();
          else if (k === 7) o.advance = q.readVarint();
        }, g);
        glyphs.push(g);
      }
    }, null);
  }, null);
  return { name, range, glyphs };
}

// Merges several subset files of one face: first file that maps a code point wins.
async function collect(files) {
  const byCp = new Map();
  for (const f of files) {
    const font = await loadFont(path.join(FONTS, f));
    for (const [cpStr, gi] of Object.entries(font.tables.cmap.glyphIndexMap)) {
      const cp = Number(cpStr);
      if (!wanted(cp) || byCp.has(cp)) continue;
      byCp.set(cp, { font, glyph: font.glyphs.get(gi) });
    }
  }
  return byCp;
}

async function build() {
  let files = 0, bytes = 0;
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const stack of STACKS) {
    const byCp = await collect(stack.files);
    const ranges = new Map();
    for (const [cp, { font, glyph }] of [...byCp].sort((a, b) => a[0] - b[0])) {
      const start = cp - (cp % 256);
      if (!ranges.has(start)) ranges.set(start, []);
      ranges.get(start).push(renderGlyph(font, glyph, cp));
    }
    const dir = path.join(OUT, stack.name);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0, sb = 0;
    for (const [start, glyphs] of ranges) {
      const buf = encodeRange(stack.name, start, glyphs);
      fs.writeFileSync(path.join(dir, `${start}-${start + 255}.pbf`), buf);
      n++; sb += buf.length;
    }
    console.log(`${stack.name}: ${byCp.size} glyphs in ${n} ranges (${[...ranges.keys()].map((s) => `${s}-${s + 255}`).join(", ")}), ${sb} bytes`);
    files += n; bytes += sb;
  }
  console.log(`total: ${files} files, ${bytes} bytes -> ${path.relative(REPO, OUT)}`);
}

async function calibrate() {
  const url = "https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/0-255.pbf";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const ref = decodeRange(new Uint8Array(await res.arrayBuffer()));
  const font = await loadFont(path.join(HERE, "node_modules", "@fontsource", "noto-sans", "files", "noto-sans-latin-400-normal.woff2"));
  const scale = SIZE / font.unitsPerEm;
  console.log(`reference ${ref.name} ${ref.range}: ${ref.glyphs.length} glyphs`);
  console.log(`Noto Sans: upm ${font.unitsPerEm}, hhea ascender ${font.tables.hhea.ascender} (${(font.tables.hhea.ascender * scale).toFixed(2)} px), TOP_OFFSET ${TOP_OFFSET}`);
  const pick = [..."Ax g0HOQ.,é"].map((c) => c.codePointAt(0));
  let worst = 0, sumDiff = 0, cnt = 0;
  const all = ref.glyphs.filter((g) => font.tables.cmap.glyphIndexMap[g.id] !== undefined);
  for (const r of all) {
    const m = renderGlyph(font, font.glyphs.get(font.tables.cmap.glyphIndexMap[r.id]), r.id);
    const dm = Math.max(Math.abs(m.left - r.left), Math.abs(m.top - r.top), Math.abs(m.advance - r.advance),
      Math.abs(m.width - r.width), Math.abs(m.height - r.height));
    worst = Math.max(worst, dm);
    if (m.bitmap && r.bitmap && m.bitmap.length === r.bitmap.length) {
      let s = 0; for (let i = 0; i < m.bitmap.length; i++) s += Math.abs(m.bitmap[i] - r.bitmap[i]);
      sumDiff += s / m.bitmap.length; cnt++;
    }
    if (pick.includes(r.id)) {
      const f = (g) => `w${g.width} h${g.height} l${g.left} t${g.top} a${g.advance}`;
      console.log(`${JSON.stringify(String.fromCodePoint(r.id))} protomaps ${f(r)} | ours ${f(m)}`);
    }
  }
  console.log(`${all.length} glyphs compared; worst metric difference ${worst} px; mean |bitmap diff| ${(sumDiff / cnt).toFixed(2)}/255 over ${cnt} same-size bitmaps`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (process.argv.includes("--calibrate") ? calibrate() : build()).catch((e) => { console.error(e); process.exit(1); });
}
