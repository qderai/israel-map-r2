// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
// Copies MapLibre's CSP build, the pmtiles protocol and the RTL text plugin from node_modules into public/vendor,
// so the page loads nothing from a third party. Run after `npm install`.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "vendor", "maplibre");
mkdirSync(OUT, { recursive: true });
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));
const copies = [
  [join(pkg("maplibre-gl"), "dist", "maplibre-gl-csp.js"), "maplibre-gl-csp.js"],
  [join(pkg("maplibre-gl"), "dist", "maplibre-gl-csp-worker.js"), "maplibre-gl-csp-worker.js"],
  [join(pkg("maplibre-gl"), "dist", "maplibre-gl.css"), "maplibre-gl.css"],
  [join(pkg("maplibre-gl"), "LICENSE.txt"), "LICENSE-maplibre-gl.txt"],
  [join(pkg("pmtiles"), "dist", "pmtiles.js"), "pmtiles.js"],
  [join(pkg("@mapbox/mapbox-gl-rtl-text"), "mapbox-gl-rtl-text.min.js"), "mapbox-gl-rtl-text.min.js"],
  [join(pkg("@mapbox/mapbox-gl-rtl-text"), "LICENSE.md"), "LICENSE-mapbox-gl-rtl-text.md"],
];
for (const [from, to] of copies) { copyFileSync(from, join(OUT, to)); console.log(`public/vendor/maplibre/${to}`); }
