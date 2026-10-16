# Fonts for the map labels

`npm run glyphs` turns the font files in this folder into the SDF glyph files MapLibre draws labels with
(`public/map/fonts/<Stack>/<start>-<end>.pbf`). The default stacks (`tools/build-glyphs.mjs` STACKS,
`public/js/map-style.js` FONT) use **Heebo** (SIL Open Font License 1.1), which covers Latin and Hebrew:

    heebo-400-latin.woff2   heebo-400-hebrew.woff2   heebo-500-latin.woff2   heebo-500-hebrew.woff2

Get them from Google Fonts or `npm i @fontsource/heebo` (files/heebo-*-normal.woff2, renamed as above). Font files
are not committed here; their own licence travels with them. Any other font works: change STACKS and FONT together.
