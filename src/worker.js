// Copyright 2026 Qder AI (Itay Funes). Licensed under the Apache License, Version 2.0.
/**
 * The example Worker: the map's three routes, then the static files (public/).
 *
 *   GET  /map/tiles                   { url: "/map/tiles/<TILES_KEY>" }, or 404 until an archive is uploaded
 *   GET  /map/tiles/<TILES_KEY>       one byte range of the PMTiles archive in R2 (HEAD too)
 *   GET  /map/fonts/<stack>/<a>-<b>.pbf   SDF glyphs built by tools/build-glyphs.mjs
 */
import { currentTiles, serveGlyphs, serveTiles } from "./tiles.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    if (url.pathname === "/map/tiles") return currentTiles(env);
    let m = /^\/map\/tiles\/([^/]+)$/.exec(url.pathname);
    if (m) return serveTiles(env, req, decodeURIComponent(m[1]), ctx);
    m = /^\/map\/fonts\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m) return serveGlyphs(env, req, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    return env.ASSETS.fetch(req);
  },
};
