# Glassy

A free, lightweight surf forecast. Glassy takes open ocean swell, wind and tide data and
works out what actually reaches each break by tracing waves over the real seafloor, all in
your browser. No accounts, no ads, no tracking, no build step.

Launch scope is **California**, starting with the Santa Barbara coast. Any custom point can
still be forecast by clicking the map.

## Features

- **Map home**: an ocean basemap with bathymetry, known breaks as markers, optional live
  swell arrows, favourites, spots near you (if you allow location) and the California list
  grouped by region (Santa Barbara coast first).
- **Any point**: click a coastline (or search a place) to open `#/at/lat,lon`. The point is
  snapped to the coast and modelled from scratch, and its name comes from reverse geocoding.
- **Spot page**:
  - a "now" panel with the surf range, a body-height description, a rating bar, wind
    (offshore/onshore relative to the beach), tide, and water and air temperature
  - a written report: headline, paragraphs and best windows, generated from the numbers by
    rules (no language model)
  - an 8-day chart; selecting an hour updates the now panel, the tide chart, the swell
    polar, the swell table and the 3D view
  - a table of swell components (offshore height, refraction coefficient, height at the
    break, breaking height), a swell-window polar and a tide curve
  - a **3D diorama** of the real seabed and coast, with swell crests that bend over the
    contours (WebGL2; it loads only when you scroll to it and has an eco still-frame mode)
  - a depth profile, a map of traced wave rays, an 8-day outlook, and a "How this is
    modelled" section
- **Units**: ft/m, kt/km/h/mph, °C/°F. **Theme**: auto, light (nautical chart) or dark
  (ECDIS night palette). Units, theme and favourites are saved in `localStorage`.
- **Sustainable by design**: system fonts only and no frameworks. Leaflet and the 3D code
  load only when needed, and map tiles load only where a map is visible. The footer shows
  the bytes transferred this session and an estimate of CO₂e (Sustainable Web Design model,
  about 0.36 g per MB).
- **Offline-friendly**: a service worker precaches the app shell. Bathymetry tiles and
  libraries are served cache-first, forecasts network-first with a cache fallback, and
  basemap tiles stale-while-revalidate with a size cap.

## How the model works

### California (primary)
1. **Nearshore swell**: Scripps Institution of Oceanography's
   [CDIP MOP](https://cdip.ucsd.edu/) model publishes spectral wave forecasts at 10 m depth
   every ~100 m of California coastline (about 11,600 points, ~7 days ahead). It back-traces
   rays from each point over high-resolution bathymetry, so refraction and Channel Islands
   shadowing are already included. `data/mop-index.json` maps any coastal point to its
   nearest MOP point; the browser then reads that point's spectrum over OPeNDAP.
2. **Swell systems**: the frequency spectrum is split at its valleys (watershed) into
   separate swells, merging weak or overlapping systems, giving height, peak period and
   mean direction for each.
3. **To the break**: each swell is un-shoaled from 10 m to a deep-water equivalent,
   refracted the last stretch toward the shore normal (`Kr = sqrt(cos θ)`), and broken with
   Komar–Gaughan `Hb = 0.39·g^0.2·(T·H0′²)^0.4`. Swells combine as `sqrt(Σ Hb²)`; the face
   range shown is 0.55–0.85 × Hb.
4. **Wind, weather, tide**: wind, weather and water temperature from Open-Meteo; tides are
   NOAA CO-OPS harmonic predictions (MLLW) from the nearest station
   (`data/tide-stations.json`).
5. **Rating and report**: height, period and wind relative to the shore combine into a
   seven-step rating (flat to epic). Tide extremes, best windows, wetsuit advice and the
   prose all come from these numbers by rules.

Elevation tiles are only used for the 3D seabed view on California spots.

### Elsewhere (fallback)
Where there is no MOP coverage, Glassy models the nearshore itself: Open-Meteo offshore
swell partitions, AWS Terrain Tiles bathymetry (z12 land with z10/z8 depth fallback, since
the tiles carry no seabed above z10), a coast snap and 8 m surf point, and backward ray
tracing for nine periods with Snell refraction and island blocking, then the same breaking
and rating steps.

It is a model, not an observation. Sandbars, reef shape and tide effects on breaking are not
resolved, and the wave model itself can be wrong.

## Data sources

- California nearshore waves: [CDIP](https://cdip.ucsd.edu/) MOP model, Scripps Institution
  of Oceanography
- Tides (California): [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/) harmonic predictions
- Wind, weather, water temperature and offshore swell: [Open-Meteo](https://open-meteo.com)
  (Marine and Forecast APIs, CC BY 4.0)
- Bathymetry and terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (ETOPO1, GEBCO, SRTM, NOAA Coastal Relief)
- Place search: Open-Meteo Geocoding. Reverse geocoding: OpenStreetMap
  [Nominatim](https://nominatim.org/)
- Map: [Leaflet](https://leafletjs.com) 1.9.4 (cdnjs, with SRI), Esri World Ocean Base and
  Dark Gray Canvas tiles (© Esri, GEBCO, NOAA, National Geographic, HERE, Garmin,
  © OpenStreetMap contributors). Glassy uses Esri because CARTO basemaps now require an API
  key.

## Run locally

There is no build step. Serve the folder with any static server:

```bash
python3 -m http.server 5173
# open http://localhost:5173/
```

Routes: `#/` (home), `#/spot/{id}` (e.g. `#/spot/rincon`), `#/at/{lat},{lon}`.

When you change any shell file, bump `VERSION` in `sw.js` so returning visitors get the
update. In DevTools, "Update on reload" under Application → Service Workers helps while
developing.

## Project layout

| file | role |
|---|---|
| `index.html`, `css/app.css`, `css/charts.css` | shell and styles |
| `js/main.js` | routing, state, pages, data meter |
| `js/map.js` | Leaflet map (lazy loaded), markers, rays, swell arrows |
| `js/nearshore.js` | CDIP MOP nearshore forecasts, spectrum partitioning, NOAA tides |
| `js/api.js`, `js/net.js` | Open-Meteo / Nominatim requests with byte counting |
| `js/geo.js`, `js/geo.worker.js`, `js/terrain.js` | bathymetry analysis and ray tracing in a worker |
| `js/model.js`, `js/report.js` | surf model and generated text |
| `js/charts.js` | SVG charts |
| `js/scene3d.js` | WebGL2 diorama |
| `js/spots.js` | curated breaks |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | PWA |

See `docs/CONTRACTS.md` for the module interfaces.
