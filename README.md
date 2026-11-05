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

1. **Offshore sea state**: Open-Meteo marine and weather models give hourly primary swell,
   secondary swell and wind-wave partitions (height, period, direction), plus wind, tide
   (sea level), sea-surface temperature and air temperature for the nearest sea grid cell.
2. **Seabed**: a Web Worker downloads AWS Terrain Tiles (Terrarium PNG, metres = R·256 + G +
   B/256 − 32768): zoom 12 around the break and zoom 8 for the open ocean. It snaps the
   point to the coastline, finds the seaward shore normal, and picks a "surf point" at about
   8 m depth.
3. **Refraction and shadowing**: from the surf point, rays are traced backwards for nine
   periods (6–22 s) with Snell's law over smoothed depth. Rays that hit land are blocked.
   The rays that reach open ocean give a coefficient K<sub>d</sub>² for each period and
   offshore direction, convolved with directional spreading.
4. **Exposure correction**: the wave-model grid cell may be sheltered itself, so its own
   openness is divided out (floored at 0.2). K<sub>d</sub>² is capped at 1.3.
5. **Breaking**: each partition is transformed (`H0′ = H·Kd`) and broken with Komar–Gaughan
   `Hb = 0.39·g^0.2·(T·H0′²)^0.4`. The partitions combine as `sqrt(Σ Hb²)`, and the face
   range shown is 0.55–0.85 × Hb.
6. **Rating and report**: height, period and wind relative to the shore combine into a
   seven-step rating (flat to epic). Tide extremes, best windows, wetsuit advice and the
   prose all come from these numbers.

It is a model, not an observation. Sandbars, reef shape and tide effects on breaking are not
resolved, and the wave model itself can be wrong.

## Data sources

- Swell, wind, tide and water temperature: [Open-Meteo](https://open-meteo.com) (Marine and
  Forecast APIs, CC BY 4.0)
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
| `js/api.js`, `js/net.js` | Open-Meteo / Nominatim requests with byte counting |
| `js/geo.js`, `js/geo.worker.js`, `js/terrain.js` | bathymetry analysis and ray tracing in a worker |
| `js/model.js`, `js/report.js` | surf model and generated text |
| `js/charts.js` | SVG charts |
| `js/scene3d.js` | WebGL2 diorama |
| `js/spots.js` | curated breaks |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | PWA |

See `docs/CONTRACTS.md` for the module interfaces.
