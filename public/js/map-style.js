// Copyright 2026 Qder AI (Itay Funes). Licensed under the Apache License, Version 2.0.
/**
 * The style: OpenStreetMap's standard look (OSM Carto) drawn from self-hosted vector tiles, rather than loading
 * tile.openstreetmap.org. Same colours, road widths and label colours as openstreetmap.org, on the Protomaps
 * basemap schema (layers earth / water / landuse / landcover / buildings / roads / pois / places / boundaries).
 * Everything it loads is ours: the tiles from /map/tiles/<key> (src/tiles.js), the glyphs from /map/fonts
 * (our Heebo, tools/build-glyphs.mjs) and the POI icons, drawn on a canvas by poiImages() below. Hebrew names
 * first, then the local name. Light only (dashboards are light).
 *
 * Zoom: openstreetmap.org draws 256 px raster tiles and MapLibre 512 px vector tiles, so OSM's zoom Z shows the
 * same ground as our Z - 1. The widths below are written at OSM's zooms (osm(...)) and shifted, so a number can be
 * checked against openstreetmap-carto's roads.mss directly.
 *
 * Fields read (Protomaps build 2026-10-13, Karmiel): roads kind highway / major_road / minor_road / other / path /
 * rail with kind_detail motorway, trunk, primary, secondary, tertiary (+ _link), residential, unclassified, service,
 * living_street, footway, path, steps, track, cycleway, pedestrian; landuse kind (park, grass, forest, scrub,
 * farmland, school, ...); buildings with addr_housenumber; pois kind / kind_detail / min_zoom; places kind.
 */

// openstreetmap-carto's colours (landcover.mss, roads.mss, water.mss, amenity-points.mss).
export const C = {
  land: "#F2EFE9", water: "#AAD3DF", waterLabel: "#4D80B3",
  residential: "#E0DFDF", commercial: "#F2DAD9", retail: "#FFD6D1", industrial: "#EBDBE8", military: "#F7D8D8",
  farmland: "#EEF0D5", orchard: "#AEDFA3", grass: "#CDEBB0", park: "#C8FACC", leisure: "#DFFCE2", pitch: "#AAE0CB",
  pitchLine: "#88B8A6", golf: "#DEF6C0", forest: "#ADD19E", scrub: "#C8D7AB", heath: "#D6D99F", cemetery: "#AACBAF",
  allotments: "#C9E1BF", societal: "#FFFFE5", societalLine: "#E3D7B4", pedestrianArea: "#DDDDE8", sand: "#F5E9C6",
  beach: "#FFF1BA", rock: "#EEE5DC", reserve: "#7CB06A",
  bldg: "#D9D0C9", bldgLine: "#C4B6AB",
  motorway: "#E892A2", motorwayCase: "#DC2A67", trunk: "#F9B29C", trunkCase: "#C84E2F",
  primary: "#FCD6A4", primaryCase: "#A06B00", secondary: "#F7FABF", secondaryCase: "#707D05",
  tertiary: "#FFFFFF", tertiaryCase: "#8F8F8F", minor: "#FFFFFF", minorCase: "#BBBBBB",
  living: "#EDEDED", livingCase: "#C6C6C6", pedestrian: "#DDDDE8", pedestrianCase: "#999999",
  footway: "#FA8072", cycleway: "#0000FF", track: "#996600", rail: "#707070", railDash: "#FFFFFF",
  label: "#222222", labelSoft: "#333333", place: "#000000", neighbourhood: "#666666", housenumber: "#666666",
  halo: "#FFFFFF", boundary: "#8D618B",
  parkLabel: "#1E8A28", forestLabel: "#46673B", societalLabel: "#6B6B2A",
  transport: "#0092DA", amenity: "#734A08", shop: "#AC39AC", health: "#BF0000", worship: "#000000",
};

export const FONT = { regular: ["Heebo Regular"], medium: ["Heebo Medium"] };

const name = ["coalesce", ["get", "name:he"], ["get", "name"]];
/** Widths at OSM's zooms (raster Z = our Z + 1), interpolated exponentially like a road on a raster map. */
const osm = (...stops) => ["interpolate", ["exponential", 1.4], ["zoom"], ...stops.map((v, i) => (i % 2 ? v : v - 1))];
const z = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops];
const kind = (...k) => ["match", ["get", "kind"], k, true, false];
const detail = (...k) => ["match", ["get", "kind_detail"], k, true, false];
const notTunnel = ["!", ["to-boolean", ["get", "is_tunnel"]]];
const poly = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
const line = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const point = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
/** A POI the tiles say belongs at this zoom (Protomaps' min_zoom is on the 512 px scale already). */
const poiAtZoom = ["any", kind("bus_stop"), ["<=", ["coalesce", ["get", "min_zoom"], 0], ["+", ["zoom"], 0.5]]];

// Land use, carto's fill per kind (landcover.mss). One layer, drawn in Protomaps' sort_rank order.
const LANDUSE = [
  [["residential"], C.residential],
  [["commercial"], C.commercial], [["retail"], C.retail], [["industrial", "railway", "quarry"], C.industrial],
  [["military"], C.military],
  [["farmland", "farmyard"], C.farmland], [["orchard", "vineyard", "plant_nursery"], C.orchard],
  [["grass", "meadow", "village_green", "garden", "grassland"], C.grass], [["allotments"], C.allotments],
  [["park", "dog_park", "national_park"], C.park], [["playground", "recreation_ground", "sports_centre", "stadium"], C.leisure],
  [["pitch", "track"], C.pitch], [["golf_course"], C.golf],
  [["forest", "wood"], C.forest], [["scrub"], C.scrub], [["heath", "wetland"], C.heath], [["cemetery", "grave_yard"], C.cemetery],
  [["school", "kindergarten", "college", "university", "hospital"], C.societal], [["pedestrian"], C.pedestrianArea],
  [["beach"], C.beach], [["sand"], C.sand], [["bare_rock", "scree", "barren"], C.rock],
];
const landuseColor = ["match", ["get", "kind"], ...LANDUSE.flatMap(([k, c]) => [k, c]), "rgba(0,0,0,0)"];
const LANDUSE_KINDS = LANDUSE.flatMap(([k]) => k);

/**
 * One road class: casing and fill, carto's colours and widths (roads.mss), at OSM's zooms. `edge` is the casing
 * on each side. Returns [casing, fill]: the casings of every class are drawn under the fills of every class.
 */
function road(id, filter, fill, casing, widths, edge, minzoom = 0) {
  const f = ["all", filter, notTunnel];
  const caseWidths = widths.map((w, i) => (i % 2 ? w + 2 * edge(widths[i - 1]) : w));
  const base = { type: "line", source: "pm", "source-layer": "roads", minzoom, filter: f };
  return [
    { ...base, id: `${id}-case`, layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": casing, "line-width": osm(...caseWidths) } },
    { ...base, id, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": fill, "line-width": osm(...widths) } },
  ];
}
/** carto's casing per side, by OSM zoom: thin at 12-13, 0.6-0.75 px through 16, 1 px and more beyond. */
const edgeAt = (zoom) => (zoom <= 12 ? 0.3 : zoom <= 13 ? 0.5 : zoom <= 15 ? 0.6 : zoom <= 16 ? 0.75 : zoom <= 17 ? 1 : 1.25);
const majorEdge = (zoom) => (zoom <= 12 ? 0.4 : zoom <= 15 ? 0.6 : zoom <= 16 ? 0.8 : zoom <= 17 ? 1 : 1.25);

/* ------------------------------------------------------------------ POI icons */

// Which pois get an icon, and in which of carto's colours: transport blue, amenity brown, shops purple,
// health red, worship black. Street furniture (crossings, lamps, benches, bins, trees) stays off, as on
// openstreetmap.org at these zooms.
export const POI = {
  "poi-parking": { kinds: ["parking", "parking_entrance", "parking_space"], color: C.transport },
  "poi-bus": { kinds: ["bus_stop", "bus_station", "station", "halt", "tram_stop"], color: C.transport },
  "poi-food": { kinds: ["restaurant", "fast_food", "food_court"], color: C.amenity },
  "poi-cafe": { kinds: ["cafe", "ice_cream"], color: C.amenity },
  "poi-bar": { kinds: ["bar", "pub", "biergarten", "nightclub"], color: C.amenity },
  "poi-fuel": { kinds: ["fuel", "charging_station"], color: C.amenity },
  "poi-money": { kinds: ["bank", "atm", "bureau_de_change"], color: C.amenity },
  "poi-amenity": { kinds: ["townhall", "community_centre", "library", "theatre", "cinema", "museum", "post_office", "police",
    "fire_station", "toilets", "arts_centre", "courthouse", "hotel", "attraction", "information"], color: C.amenity },
  "poi-shop": { kinds: ["supermarket", "mall", "convenience", "department_store", "bakery", "butcher", "greengrocer",
    "clothes", "shoes", "toys", "books", "hardware", "doityourself", "electronics", "mobile_phone", "furniture", "florist",
    "optician", "jewelry", "gift", "kiosk", "beauty", "hairdresser", "chemist", "variety_store", "marketplace", "alcohol",
    "wine", "beverages", "deli", "confectionery", "pastry", "seafood", "sports", "pet", "stationery"], color: C.shop },
  "poi-health": { kinds: ["pharmacy", "hospital", "clinic", "doctors", "dentist"], color: C.health },
  "poi-worship": { kinds: ["place_of_worship", "synagogue", "mosque", "church"], color: C.worship },
};
const poiIcon = ["match", ["get", "kind"], ...Object.entries(POI).flatMap(([id, p]) => [p.kinds, id]), ""];
const poiColor = ["match", ["get", "kind"], ...Object.values(POI).flatMap((p) => [p.kinds, p.color]), C.amenity];
const POI_KINDS = Object.values(POI).flatMap((p) => p.kinds);
const AREA_GREEN = ["park", "garden", "nature_reserve", "national_park", "dog_park", "playground", "recreation_ground", "cemetery"];
const AREA_WOOD = ["forest", "wood"];
const AREA_SOCIETAL = ["school", "kindergarten", "college", "university"]; // a hospital is named by its POI icon
const AREA_NAMED = [...AREA_GREEN, ...AREA_WOOD, ...AREA_SOCIETAL];
const placeScale = ["match", ["get", "kind_detail"], "city", 1.2, "town", 1, 0.85];
const areaColor = ["match", ["get", "kind"], AREA_WOOD, C.forestLabel, AREA_SOCIETAL, C.societalLabel, C.parkLabel];

/**
 * The POI icons, drawn here (no sprite file, nothing fetched): carto's 14 px pictograms in their category colour,
 * the parking sign a blue square with a white P like on openstreetmap.org. Browser only (a canvas).
 * Returns [{ id, image: ImageData, pixelRatio }].
 */
export function poiImages(ratio = 2) {
  const S = 14 * ratio, out = [];
  const make = (id, draw) => {
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const g = c.getContext("2d");
    g.scale(ratio, ratio);
    g.lineCap = "round"; g.lineJoin = "round";
    draw(g, POI[id].color);
    out.push({ id, image: g.getImageData(0, 0, S, S), pixelRatio: ratio });
  };
  const rrect = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); };
  make("poi-parking", (g, col) => {
    rrect(g, 1, 1, 12, 12, 2); g.fillStyle = col; g.fill();
    g.fillStyle = "#fff"; g.font = "bold 10px Arial, Helvetica, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("P", 7, 7.6);
  });
  make("poi-bus", (g, col) => {
    // openstreetmap.org's bus stop at these zooms: a small blue square.
    rrect(g, 3.5, 3.5, 7, 7, 1); g.fillStyle = col; g.fill();
  });
  make("poi-food", (g, col) => {
    g.strokeStyle = col; g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(4, 2); g.lineTo(4, 12); g.moveTo(2.5, 2); g.lineTo(2.5, 5); g.quadraticCurveTo(4, 7, 5.5, 5); g.lineTo(5.5, 2); g.stroke();
    g.beginPath(); g.moveTo(10, 12); g.lineTo(10, 2); g.quadraticCurveTo(12.2, 3.5, 12, 7.5); g.lineTo(10, 7.5); g.stroke();
  });
  make("poi-cafe", (g, col) => {
    g.fillStyle = col; g.beginPath(); g.moveTo(2, 4.5); g.lineTo(10, 4.5); g.lineTo(9.3, 10); g.quadraticCurveTo(6, 12, 2.7, 10); g.closePath(); g.fill();
    g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.arc(10.3, 7, 1.8, -Math.PI / 2, Math.PI / 2); g.stroke();
    g.fillRect(1.5, 11.5, 9, 1.2);
  });
  make("poi-bar", (g, col) => {
    g.fillStyle = col; g.beginPath(); g.moveTo(2, 2.5); g.lineTo(12, 2.5); g.lineTo(7.6, 7.5); g.lineTo(6.4, 7.5); g.closePath(); g.fill();
    g.fillRect(6.4, 7, 1.2, 4); g.fillRect(4, 11, 6, 1.3);
  });
  make("poi-fuel", (g, col) => {
    g.fillStyle = col; rrect(g, 2, 2, 6.5, 10.5, 1); g.fill();
    g.fillStyle = "#fff"; g.fillRect(3.2, 3.3, 4.1, 2.8);
    g.strokeStyle = col; g.lineWidth = 1.1; g.beginPath(); g.moveTo(8.5, 5); g.lineTo(10.8, 6.5); g.lineTo(10.8, 10.5); g.quadraticCurveTo(11.5, 11.8, 12.3, 10.5); g.lineTo(12.3, 5); g.stroke();
  });
  make("poi-money", (g, col) => {
    g.fillStyle = col; rrect(g, 1, 3.5, 12, 7.5, 1.2); g.fill();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(7, 7.25, 2.1, 0, Math.PI * 2); g.fill();
  });
  make("poi-amenity", (g, col) => {
    g.fillStyle = col; g.beginPath(); g.arc(7, 7, 3.6, 0, Math.PI * 2); g.fill();
  });
  make("poi-shop", (g, col) => {
    g.fillStyle = col; g.beginPath(); g.moveTo(2.5, 5); g.lineTo(11.5, 5); g.lineTo(12, 12.5); g.lineTo(2, 12.5); g.closePath(); g.fill();
    g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.arc(7, 5, 2.4, Math.PI, 0); g.stroke();
  });
  make("poi-health", (g, col) => {
    g.fillStyle = col; g.fillRect(5.3, 1.5, 3.4, 11); g.fillRect(1.5, 5.3, 11, 3.4);
  });
  make("poi-worship", (g, col) => {
    // A Star of David: the places of worship around our venues are mostly synagogues (carto draws each faith).
    g.strokeStyle = col; g.lineWidth = 1.3;
    const tri = (rot) => {
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = rot + (i * 2 * Math.PI) / 3;
        g[i ? "lineTo" : "moveTo"](7 + 5.4 * Math.sin(a), 7.3 - 5.4 * Math.cos(a));
      }
      g.closePath(); g.stroke();
    };
    tri(0); tri(Math.PI);
  });
  return out;
}

/** carto's forest pattern: a few faint round trees on a 40 px tile, laid over the forest green. Browser only. */
export function forestPattern(ratio = 2) {
  const S = 40 * ratio, c = document.createElement("canvas");
  c.width = S; c.height = S;
  const g = c.getContext("2d");
  g.scale(ratio, ratio);
  g.strokeStyle = "rgba(90,140,72,.4)"; g.fillStyle = "rgba(90,140,72,.16)"; g.lineWidth = 0.7;
  for (const [x, y] of [[7, 8], [27, 15], [15, 31]]) {
    g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(x, y + 2.2); g.lineTo(x, y + 3.6); g.stroke();
  }
  return { id: FOREST_PATTERN, image: g.getImageData(0, 0, S, S), pixelRatio: ratio };
}
export const FOREST_PATTERN = "forest-pattern";

/** Whether the style asked for one of our drawn images (the map's styleimagemissing event). */
export const isOurImage = (id) => Boolean(POI[id]) || id === FOREST_PATTERN;

/** Adds the POI icons and the forest pattern to a map once (MapLibre keeps images per map and style). */
export function addMapImages(map) {
  for (const { id, image, pixelRatio } of [...poiImages(), forestPattern()]) {
    if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio });
  }
}

/* ------------------------------------------------------------------ the style */

/** The style for an origin (absolute URLs: the pmtiles protocol and the glyph loader both want them). */
/** `tilesPath` is the current, versioned archive (GET /map/tiles answers it: /map/tiles/<TILES_KEY>). */
export function mapStyle(origin, tilesPath) {
  const motorway = kind("highway");
  const trunk = ["all", kind("major_road"), detail("trunk", "trunk_link")];
  const primary = ["all", kind("major_road"), detail("primary", "primary_link")];
  const secondary = ["all", kind("major_road"), detail("secondary", "secondary_link")];
  const tertiary = ["all", kind("major_road"), detail("tertiary", "tertiary_link")];
  const service = ["all", kind("minor_road"), detail("service")];
  const minor = ["all", kind("minor_road"), ["!", detail("service")]];
  const living = ["any", ["all", kind("other"), detail("living_street")], ["all", kind("minor_road"), detail("living_street")]];
  const pedestrianRoad = ["all", kind("path"), detail("pedestrian")];
  const footway = ["all", kind("path"), detail("footway", "path", "sidewalk", "crossing", "corridor", "bridleway")];
  const steps = ["all", kind("path"), detail("steps")];
  const cycleway = ["all", kind("path"), detail("cycleway")];
  const track = ["all", kind("path"), detail("track")];
  const majorAny = ["any", motorway, trunk, primary, secondary, tertiary];

  // Widths at OSM's zooms, measured against openstreetmap.org over Karmiel (2026-10-14) and roads.mss.
  const W = {
    motorway: [7, 0.6, 10, 1.4, 12, 2, 13, 3.5, 14, 6, 16, 8, 17, 10, 18, 18, 19, 21],
    secondary: [10, 0.8, 12, 1.6, 13, 3.5, 14, 6, 16, 7.5, 17, 9.5, 18, 18, 19, 21],
    tertiary: [11, 0.6, 13, 2.5, 14, 4, 15, 5, 16, 6.5, 17, 9.5, 18, 18, 19, 21],
    minor: [13, 0.8, 14, 2.5, 15, 3.5, 16, 5, 17, 9.5, 18, 18, 19, 24],
    living: [14, 2, 15, 3, 16, 4.5, 17, 9, 18, 15, 19, 20],
    service: [15, 1.5, 16, 2.5, 17, 4, 18, 7, 19, 8.5],
  };
  const majorHalo = ["match", ["get", "kind_detail"],
    ["motorway", "motorway_link"], C.motorway, ["trunk", "trunk_link"], C.trunk, ["primary", "primary_link"], C.primary,
    ["secondary", "secondary_link"], C.secondary, C.halo];

  const roads = [
    road("road-service", service, C.minor, C.minorCase, W.service, edgeAt, 13),
    road("road-living", living, C.living, C.livingCase, W.living, edgeAt, 12),
    road("road-pedestrian", pedestrianRoad, C.pedestrian, C.pedestrianCase, W.living, edgeAt, 13),
    road("road-minor", minor, C.minor, C.minorCase, W.minor, edgeAt, 11),
    road("road-tertiary", tertiary, C.tertiary, C.tertiaryCase, W.tertiary, majorEdge, 9),
    road("road-secondary", secondary, C.secondary, C.secondaryCase, W.secondary, majorEdge, 8),
    road("road-primary", primary, C.primary, C.primaryCase, W.motorway, majorEdge, 6),
    road("road-trunk", trunk, C.trunk, C.trunkCase, W.motorway, majorEdge, 5),
    road("road-motorway", motorway, C.motorway, C.motorwayCase, W.motorway, majorEdge, 5),
  ];

  return {
    version: 8,
    name: "Israel OSM",
    glyphs: `${origin}/map/fonts/{fontstack}/{range}.pbf`,
    sources: {
      pm: { type: "vector", url: `pmtiles://${origin}${tilesPath}`, attribution: "© OpenStreetMap contributors" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.land } },
      // Low zooms (the pin editor's first view of the country): Protomaps' landcover, carto's colours.
      { id: "landcover", type: "fill", source: "pm", "source-layer": "landcover", maxzoom: 9,
        paint: { "fill-color": ["match", ["get", "kind"], "forest", C.forest, "scrub", C.scrub, "grassland", C.grass,
          "farmland", C.farmland, "barren", C.rock, "urban_area", C.residential, "rgba(0,0,0,0)"], "fill-opacity": 0.7 } },
      { id: "landuse", type: "fill", source: "pm", "source-layer": "landuse", filter: ["all", poly, kind(...LANDUSE_KINDS)],
        layout: { "fill-sort-key": ["coalesce", ["get", "sort_rank"], 0] },
        paint: { "fill-color": landuseColor } },
      { id: "landuse-forest-trees", type: "fill", source: "pm", "source-layer": "landuse", minzoom: 12, filter: ["all", poly, kind("forest", "wood")],
        paint: { "fill-pattern": FOREST_PATTERN } },
      { id: "landuse-pitch-line", type: "line", source: "pm", "source-layer": "landuse", minzoom: 14, filter: kind("pitch", "track"),
        paint: { "line-color": C.pitchLine, "line-width": 0.6 } },
      { id: "landuse-societal-line", type: "line", source: "pm", "source-layer": "landuse", minzoom: 13,
        filter: kind("school", "kindergarten", "college", "university", "hospital"),
        paint: { "line-color": C.societalLine, "line-width": 0.6 } },
      { id: "landuse-reserve-line", type: "line", source: "pm", "source-layer": "landuse", minzoom: 9,
        filter: kind("nature_reserve", "protected_area", "national_park"),
        paint: { "line-color": C.reserve, "line-width": z(9, 1, 14, 3), "line-opacity": 0.35 } },
      { id: "water", type: "fill", source: "pm", "source-layer": "water", filter: poly,
        paint: { "fill-color": C.water } },
      { id: "waterway", type: "line", source: "pm", "source-layer": "water", minzoom: 11, filter: line,
        paint: { "line-color": C.water, "line-width": osm(12, 1, 15, 2, 18, 4) } },
      { id: "building", type: "fill", source: "pm", "source-layer": "buildings", minzoom: 13, filter: poly,
        paint: { "fill-color": C.bldg, "fill-outline-color": C.bldgLine, "fill-opacity": z(13, 0, 13.5, 1) } },
      // Paths under the roads, as carto draws them: a faint white casing, then the dashed line.
      { id: "path-case", type: "line", source: "pm", "source-layer": "roads", minzoom: 14.5, filter: ["all", ["any", footway, steps, cycleway], notTunnel],
        paint: { "line-color": "#FFFFFF", "line-opacity": 0.4, "line-width": osm(15, 2.4, 18, 3.2) } },
      { id: "path-footway", type: "line", source: "pm", "source-layer": "roads", minzoom: 13, filter: ["all", footway, notTunnel],
        paint: { "line-color": C.footway, "line-width": osm(14, 1, 16, 1.4, 18, 1.8), "line-dasharray": [1.5, 1.5] } },
      { id: "path-steps", type: "line", source: "pm", "source-layer": "roads", minzoom: 14, filter: ["all", steps, notTunnel],
        paint: { "line-color": C.footway, "line-width": osm(15, 2.5, 18, 4), "line-dasharray": [0.4, 0.4] } },
      { id: "path-cycleway", type: "line", source: "pm", "source-layer": "roads", minzoom: 13, filter: ["all", cycleway, notTunnel],
        paint: { "line-color": C.cycleway, "line-width": osm(14, 1, 16, 1.4, 18, 1.8), "line-dasharray": [1.5, 1.5] } },
      { id: "path-track", type: "line", source: "pm", "source-layer": "roads", minzoom: 12, filter: ["all", track, notTunnel],
        paint: { "line-color": C.track, "line-opacity": z(12, 0.35, 14, 0.8), "line-width": osm(13, 0.8, 16, 1.5, 18, 2), "line-dasharray": [3, 2] } },
      ...roads.map(([casing]) => casing),
      ...roads.map(([, fill]) => fill),
      { id: "rail", type: "line", source: "pm", "source-layer": "roads", minzoom: 10, filter: ["all", kind("rail"), notTunnel],
        paint: { "line-color": C.rail, "line-width": osm(11, 1, 14, 2, 18, 3) } },
      { id: "rail-dash", type: "line", source: "pm", "source-layer": "roads", minzoom: 12, filter: ["all", kind("rail"), notTunnel],
        paint: { "line-color": C.railDash, "line-width": osm(13, 0.6, 14, 1, 18, 1.2), "line-dasharray": [4, 6] } },
      { id: "boundary", type: "line", source: "pm", "source-layer": "boundaries", filter: kind("country", "region"),
        paint: { "line-color": C.boundary, "line-width": 1, "line-opacity": 0.5, "line-dasharray": [4, 2] } },
      // Labels: house numbers first (they yield to everything), then streets, POIs and places.
      { id: "housenumber", type: "symbol", source: "pm", "source-layer": "buildings", minzoom: 16.5, filter: ["has", "addr_housenumber"],
        layout: { "text-field": ["get", "addr_housenumber"], "text-font": FONT.regular, "text-size": 9.5, "text-padding": 2 },
        paint: { "text-color": C.housenumber, "text-halo-color": "rgba(255,255,255,.6)", "text-halo-width": 1 } },
      { id: "water-name", type: "symbol", source: "pm", "source-layer": "water", filter: point,
        layout: { "text-field": name, "text-font": FONT.regular, "text-size": 12, "text-max-width": 8 },
        paint: { "text-color": C.waterLabel, "text-halo-color": "rgba(255,255,255,.7)", "text-halo-width": 1.2 } },
      { id: "street-name-minor", type: "symbol", source: "pm", "source-layer": "roads", minzoom: 14.5,
        filter: ["any", minor, living, pedestrianRoad, ["all", service, [">=", ["zoom"], 16]]],
        layout: { "symbol-placement": "line", "text-field": name, "text-font": FONT.regular, "text-size": z(14.5, 10, 16, 11, 18, 13), "text-padding": 4, "symbol-spacing": 220, "text-max-angle": 50 },
        paint: { "text-color": C.labelSoft, "text-halo-color": C.halo, "text-halo-width": 1.2 } },
      { id: "street-name", type: "symbol", source: "pm", "source-layer": "roads", minzoom: 12.5, filter: majorAny,
        layout: { "symbol-placement": "line", "text-field": name, "text-font": FONT.regular, "text-size": z(12.5, 10, 15, 11, 18, 13.5), "text-padding": 8, "symbol-spacing": 340 },
        paint: { "text-color": C.label, "text-halo-color": majorHalo, "text-halo-width": 1.4 } },
      { id: "poi", type: "symbol", source: "pm", "source-layer": "pois", minzoom: 14.5, filter: ["all", kind(...POI_KINDS), poiAtZoom],
        layout: {
          "icon-image": poiIcon, "icon-size": 1, "icon-padding": 2,
          "text-field": ["step", ["zoom"], "", 16.5, name], "text-font": FONT.regular, "text-size": 10.5,
          "text-anchor": "top", "text-offset": [0, 0.8], "text-max-width": 7, "text-optional": true,
          "symbol-sort-key": ["coalesce", ["get", "min_zoom"], 20],
        },
        paint: { "text-color": poiColor, "text-halo-color": C.halo, "text-halo-width": 1.2 } },
      // Names of parks, woods and schools, without an icon, in carto's green and olive.
      { id: "area-name", type: "symbol", source: "pm", "source-layer": "pois", minzoom: 14, filter: ["all", kind(...AREA_NAMED), poiAtZoom, ["has", "name"]],
        layout: { "text-field": name, "text-font": FONT.regular, "text-size": z(14, 10.5, 17, 12.5), "text-max-width": 8, "text-padding": 6,
          "symbol-sort-key": ["coalesce", ["get", "min_zoom"], 20] },
        paint: { "text-color": areaColor, "text-halo-color": "rgba(255,255,255,.75)", "text-halo-width": 1.2 } },
      { id: "place-neigh", type: "symbol", source: "pm", "source-layer": "places", minzoom: 12.5, filter: kind("neighbourhood", "macrohood"),
        layout: { "text-field": name, "text-font": FONT.regular, "text-size": z(12.5, 11, 16, 14), "text-max-width": 7, "text-padding": 12 },
        paint: { "text-color": C.neighbourhood, "text-halo-color": "rgba(255,255,255,.75)", "text-halo-width": 1.4 } },
      { id: "place-city", type: "symbol", source: "pm", "source-layer": "places", maxzoom: 15, filter: kind("locality"),
        // openstreetmap.org's sizes: a city a little bigger than a town, a village smaller and lighter.
        layout: { "text-field": name, "text-font": FONT.medium, "text-size": z(6, ["*", placeScale, 10], 10, ["*", placeScale, 12], 13, ["*", placeScale, 14.5]),
          "symbol-sort-key": ["coalesce", ["get", "min_zoom"], 20] },
        paint: { "text-color": C.place, "text-halo-color": "rgba(255,255,255,.8)", "text-halo-width": 1.6 } },
    ],
  };
}
