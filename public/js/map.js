// Copyright 2026 Qder AI (Itay Funes). Licensed under the Apache License, Version 2.0.
/**
 * A small map with a pin, drawn by MapLibre GL from
 * files we serve ourselves: /vendor/maplibre (the library, its RTL plugin and pmtiles), /map/tiles/<key>
 * (tiles, Range requests) and /map/fonts (glyphs). Nothing is fetched from anybody else.
 *
 * Loaded on demand: the library is ~800 KB and most conversations never show a card, so the script tags are
 * added the first time a map is asked for. No WebGL, or no tile archive on the server yet, and mapsAvailable()
 * says no: the caller shows its card without the map .
 *
 * The pin is a MAP LAYER (a symbol with icon-allow-overlap, placed first because it is on top), not an HTML
 * marker over the canvas: the street and place labels then collide with it and are moved or dropped instead
 * of being drawn under it, so they stay readable around the pin .
 */
import { addMapImages, isOurImage, mapStyle } from "./map-style.js";

const VENDOR = "/vendor/maplibre";
let loading = null;
let available = null;

/** WebGL at all? A phone in battery saver or an old browser says no, and the card goes without its map. */
export function webglOk() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch { return false; }
}

function addScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error(`load ${src}`));
    document.head.appendChild(s);
  });
}

/** The library, the protocol and the RTL plugin, once per page. */
export function loadMapLibre() {
  if (loading) return loading;
  loading = (async () => {
    if (!document.querySelector(`link[href="${VENDOR}/maplibre-gl.css"]`)) {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = `${VENDOR}/maplibre-gl.css`;
      document.head.appendChild(l);
    }
    // The CSP build: its tile worker is our own file, not a blob: URL, so worker-src stays 'self'.
    await Promise.all([addScript(`${VENDOR}/maplibre-gl-csp.js`), addScript(`${VENDOR}/pmtiles.js`)]);
    const ml = window.maplibregl;
    ml.setWorkerUrl(`${location.origin}${VENDOR}/maplibre-gl-csp-worker.js`);
    const protocol = new window.pmtiles.Protocol();
    ml.addProtocol("pmtiles", protocol.tile);
    // Hebrew street names are drawn right to left (bidi) by the plugin, loaded lazily inside the tile worker.
    try { ml.setRTLTextPlugin(`${location.origin}${VENDOR}/mapbox-gl-rtl-text.min.js`, true); } catch { /* already set */ }
    return ml;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/**
 * Whether a map can be drawn here at all: WebGL, and the tile archive answering on our server. Asked once per
 * page: GET /map/tiles names the current, versioned archive (src/tiles.js), or answers 404 until one is
 * uploaded (README.md), and then every card goes without its map.
 */
let tilesPath = null;
export function mapsAvailable() {
  if (available) return available;
  available = (async () => {
    if (!webglOk()) return false;
    try {
      const r = await fetch("/map/tiles", { credentials: "omit" });
      if (!r.ok) return false;
      const { url } = await r.json();
      if (typeof url !== "string" || !/^\/map\/tiles\/[a-z0-9._-]+\.pmtiles$/.test(url)) return false;
      tilesPath = url;
      return true;
    } catch { return false; }
  })();
  return available;
}

/** The pin as an image: the GPU map's dot (white rim, soft shadow) and halo, in cobalt. 46 px, drawn at 2x. */
function pinImage(ratio = 2) {
  const S = 46 * ratio, c = document.createElement("canvas");
  c.width = S; c.height = S;
  const g = c.getContext("2d");
  const mid = S / 2;
  g.fillStyle = "rgba(11,63,217,.16)";
  g.beginPath(); g.arc(mid, mid, 23 * ratio, 0, Math.PI * 2); g.fill();
  g.save();
  g.shadowColor = "rgba(10,19,48,.28)"; g.shadowBlur = 6 * ratio; g.shadowOffsetY = 1.5 * ratio;
  g.fillStyle = "#FFFFFF";
  g.beginPath(); g.arc(mid, mid, 12 * ratio, 0, Math.PI * 2); g.fill();
  g.restore();
  g.fillStyle = "#0B3FD9";
  g.beginPath(); g.arc(mid, mid, 9 * ratio, 0, Math.PI * 2); g.fill();
  return { image: g.getImageData(0, 0, S, S), ratio };
}

/** Our own attribution line (the ODbL asks for it on every map): "© OpenStreetMap contributors", bottom left, small. */
function attribution(container) {
  const at = document.createElement("div");
  at.className = "vmap-osm";
  at.setAttribute("data-no-i18n", "");
  at.textContent = "© OpenStreetMap contributors";
  container.appendChild(at);
}

/**
 * A map in `el` centred on `pin`. Options: interactive (default false: the card's map is a picture, the page
 * scrolls through it), zoom (15), showPin (true; the editor draws its own fixed pin in the middle instead).
 * Resolves with the map, or null when no map can be drawn.
 */
export async function drawMap(el, pin, opts = {}) {
  if (!(await mapsAvailable())) return null;
  let ml;
  try { ml = await loadMapLibre(); } catch { return null; }
  const interactive = opts.interactive === true;
  const map = new ml.Map({
    container: el,
    style: mapStyle(location.origin, tilesPath),
    center: [pin.lng, pin.lat],
    zoom: opts.zoom ?? 15,
    interactive,
    attributionControl: false,
    fadeDuration: 0,
    pitchWithRotate: false,
    dragRotate: false,
    touchPitch: false,
    cooperativeGestures: false,
    maxZoom: 18,
    minZoom: 6,
  });
  if (interactive) { try { map.touchZoomRotate.disableRotation(); } catch { /* older build */ } }
  attribution(el);
  // The POI icons and the forest pattern are drawn on a canvas (map-style.js), not loaded: added the first time
  // the style asks for one.
  map.on("styleimagemissing", (e) => { if (isOurImage(e.id)) addMapImages(map); });
  if (opts.showPin !== false) {
    map.on("load", () => {
      const { image, ratio } = pinImage();
      if (!map.hasImage("map-pin")) map.addImage("map-pin", image, { pixelRatio: ratio });
      map.addSource("map-pin", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [pin.lng, pin.lat] } } });
      map.addLayer({
        id: "map-pin", type: "symbol", source: "map-pin",
        layout: { "icon-image": "map-pin", "icon-allow-overlap": true, "icon-ignore-placement": false, "icon-padding": 4 },
      });
    });
  }
  // A map that cannot reach its tiles is an empty grey square: say so to the caller, who hides it.
  map.on("error", (e) => { if (opts.onError) opts.onError(e); });
  return map;
}
