# Glassy module contracts

Static site, no build step, plain ES modules (`<script type="module">`), no npm deps.
Only external lib: Leaflet 1.9.4 from cdnjs (global `L`). No web fonts. Modern browsers.
Internal units are SI: metres, seconds, m/s, °C, degrees. Directions are compass
degrees the waves/wind come FROM (0 = N, 90 = E), matching Open-Meteo.
Times: Open-Meteo returns local ISO strings with `timezone=auto`; keep them as strings
plus `utcOffsetSeconds`; `Date` objects are built as `new Date(iso + 'Z')` and always
formatted with `timeZone: 'UTC'` so the spot's local time shows regardless of viewer.

## Files and owners
| file | exports |
|---|---|
| js/spots.js (done) | `SPOTS`, `SPOT_BY_ID`, `searchSpots(q, n)`, `haversineKm(a,b)`, `nearestSpots({lat,lon}, n)` -> `[{s, d}]` |
| js/net.js | `fetchCounted(url, opts)` -> Response; `bytesUsed()`; `onBytes(cb)`; `addBytes(n)` |
| js/api.js | see below |
| js/terrain.js | tile math + decoding, used inside the worker |
| js/geo.worker.js | module worker, see below |
| js/geo.js | main-thread wrapper of the worker |
| js/model.js | surf model |
| js/report.js | text report |
| js/charts.js | SVG charts |
| js/scene3d.js | WebGL2 diorama |
| js/map.js | Leaflet map |
| js/swellmap.js | swell crest lines on the home map |
| js/main.js | app shell, routing, state |
| index.html, css/app.css, sw.js, manifest.webmanifest, icon.svg | shell |

## js/net.js
Every network call to APIs/terrain goes through `fetchCounted`, which reads the body,
counts `byteLength` (or `content-length`), and returns a new `Response` of the same body.

## js/api.js
```js
export async function getForecast(lat, lon)  // -> Forecast
export async function geocode(query)          // -> [{name, admin, country, lat, lon}] (Open-Meteo geocoding, count=6)
export async function reverseGeocode(lat, lon)// -> {name, region, country} via Nominatim (zoom=12), never throws (fallback name 'Dropped pin')
export async function currentSwellMany(points)// points [{lat,lon}] (<=60, one multi-location marine request, current=swell_wave_height,swell_wave_period,swell_wave_direction) -> [{h,t,dir}|null]
export async function currentSwellAt(lat, lon) // nearest sea cell, current primary + secondary swell -> {primary:{h,t,dir}|null, secondary:{h,t,dir}|null}; cached 30 min per 0.25°
```
`Forecast`:
```js
{
  ref: {lat, lon},                 // grid cell returned by the MARINE api
  timezone, utcOffsetSeconds,
  time: [iso...],                  // hourly, 8 days, aligned for all arrays below
  swell:  [{h, t, dir}],           // primary swell (nulls allowed -> {h:0,t:0,dir:0})
  swell2: [{h, t, dir}],           // secondary swell
  windWave: [{h, t, dir}],
  waveHeight: [m], tide: [m] (sea_level_height_msl), sst: [°C],
  wind: [{speed, gust, dir}],      // m/s (request wind_speed_unit=ms)
  airTemp: [°C], weatherCode: [int],
  daily: [{date, sunrise, sunset}] // iso strings
}
```
Marine: `https://marine-api.open-meteo.com/v1/marine` with `cell_selection=sea`, hourly
`wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,secondary_swell_wave_height,secondary_swell_wave_period,secondary_swell_wave_direction,wind_wave_height,wind_wave_period,wind_wave_direction,sea_level_height_msl,sea_surface_temperature`, `forecast_days=8`, `timezone=auto`.
Forecast: `https://api.open-meteo.com/v1/forecast` hourly `wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,weather_code`, daily `sunrise,sunset`, `wind_speed_unit=ms`, `forecast_days=8`, `timezone=auto`. Align by time string.
Cache responses in memory for 30 min keyed by rounded lat/lon (3 dp).

## Worker: js/geo.worker.js (+ js/terrain.js), wrapper js/geo.js
`js/geo.js`:
```js
export function analyzeSite(lat, lon)          // Promise<Site>
export function referenceExposure(lat, lon)    // Promise<Float32Array(180)> openness 0..1 per 2° bin (bin i = from-direction i*2°)
export function sceneData(lat, lon)            // Promise<SceneData>
```
Worker message protocol: `{id, type: 'analyze'|'refExposure'|'scene', lat, lon}` ->
`{id, ok: true, result}` or `{id, ok: false, error: string}`. Typed arrays are transferred.

Terrain: AWS terrarium tiles `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
(CORS ok). Decode `e = R*256 + G + B/256 - 32768` (metres, negative = below sea level).
In the worker: `fetchCounted` is not available across threads, so the worker posts
`{type:'bytes', n}` messages which geo.js forwards to `net.addBytes`. Decode via
`createImageBitmap` + `OffscreenCanvas`. Grids: near = z12 3x3 tiles around the point,
far = z8 3x3 tiles. Cache tiles in a Map.

`Site`:
```js
{
  input: {lat, lon},
  coast: {lat, lon},             // snapped coastline point
  surf:  {lat, lon, depth},      // reference "surf point" ~8 m depth seaward of coast
  normal: deg,                   // seaward shore normal (compass dir the beach faces)
  slope: number,                 // nearshore slope (rise/run) between coast and surf point
  profile: [{d, z}],             // ~120 samples along normal, d metres from coast (negative = landward, to -500 m), out to 4000 m; z elevation m
  periods: [6,8,10,12,14,16,18,20,22],
  kd2: Float32Array(9*180),      // transfer table: kd2[p*180 + i] = directional/refraction coefficient Kd² for period p
                                 // and offshore mean direction i*2° (already convolved with directional spreading).
                                 // Kd² from backward ray tracing (Snell refraction over smoothed bathymetry,
                                 // blocked rays = 0), Kd² = (C0/Cn) * Σ_open D(θoff-θm) Δθn. Excludes shoaling.
  window: Float32Array(180),     // raw fraction of rays (T=14 s) arriving from each 2° offshore bin, normalised max=1, for the polar chart
  rays: [{period, open: bool, pts: [[lat,lon],...]}], // subset of traced rays for T=14 s (every 3rd ray), points decimated to <=60
  blocked: [{from, to}],         // offshore direction ranges (deg) blocked by land/islands within 300 km
  meta: {nearZoom:12, farZoom:8, ms}
}
```
`SceneData` (for scene3d): `{n: 160, sizeM: 6000, elev: Float32Array(n*n) row-major north-up (row 0 = north), centre = surf point, normal, surf:{lat,lon}}`.

## js/model.js
```js
export function computeSurf(site, forecast, refOpen /*Float32Array(180) or null*/) // -> Hourly[]
export function bestWindows(hourly, n=3)  // per day: [{date, start, end, rating}]
export const RATINGS                       // [{key, label, color(css var name)}] index 0..6: flat, very poor, poor, poor-fair, fair, good, epic
```
`Hourly` = `{time, hb, min, max, rating (0..6), ratingLabel, parts: [{kind:'swell'|'swell2'|'windWave', h, t, dir, kd, h0, hb}], wind:{speed,gust,dir, kind:'offshore'|'cross-off'|'cross'|'cross-on'|'onshore'|'glassy', score}, tide, sst, airTemp, weatherCode}`
Per partition: interpolate kd2 bilinearly in period (clamp 6..22) and direction; exposure
correction divides by the reference openness convolved with the same spreading (clamped >=0.2),
final Kd² capped at 1.3. `H0' = h*sqrt(Kd²)`; Komar–Gaughan `Hb = 0.39 g^0.2 (T H0'^2)^0.4`;
combine `hb = sqrt(Σ hb_p²)`; surf face range `min = 0.55 hb`, `max = 0.85 hb`.
Wind kind from angle between wind-from direction and landward bearing (normal+180): offshore
when wind comes from land. Speeds < 2 m/s are 'glassy'. Rating combines height, period, wind.

## js/report.js
```js
export function buildReport({spot, site, hourly, forecast, units}) // -> {headline, paragraphs:[string], outlook:[{date, text}], tides:[{time, h, kind:'high'|'low'}]}
```
`units = {height:'ft'|'m', speed:'kt'|'kmh'|'mph'|'ms', temp:'c'|'f'}`. Also export `fmtHeight(m, units)`, `fmtSpeed(ms, units)`, `fmtTemp(c, units)`, `compass(deg)` (16-point), `fmtTime(iso)`, `fmtDay(iso)`.
Report text is generated from the data (no LLM): surf height in body terms (ankle..double overhead+), dominant swell, how well it fits the break's window/normal, island shadowing (site.blocked), wind evolution through the day, tide extremes, best window, water temp + wetsuit suggestion.

## js/charts.js (pure SVG strings or elements, no libs, CSS variables for colours)
```js
export function forecastChart(el, hourly, {units, onSelect(i)})   // 8-day surf bars (3-hourly bars, coloured by rating), day separators, wind arrows row, tap/hover selects hour
export function tideChart(el, forecast, i0, i1, units)            // tide curve for a day with now marker and highs/lows
export function swellPolar(el, site, parts)                       // compass rose: site.window as filled area, normal arrow, blocked arcs, arrows for current parts sized by h
export function depthProfile(el, site, units)                     // profile area chart with surf point marker
```

## js/scene3d.js
```js
export function createScene(canvas, sceneData, opts) // -> {setSwell({dir, t, h}), setEco(bool), dispose()}
```
Raw WebGL2: terrain mesh (vertical exaggeration ~2–4x, nautical colouring by depth/elevation), animated water surface whose swell crests follow an eikonal phase field (fast-sweeping solve of |∇φ| = k(depth) from the offshore boundary in the swell direction), foam where depth < ~1.3·hb. Orbit (drag), zoom (wheel/pinch). Eco: renders only when on-screen (IntersectionObserver) and tab visible, ≤30 fps, `setEco(true)` = static frame; honours prefers-reduced-motion. Falls back gracefully (returns null) without WebGL2.

## js/map.js
```js
export function createMap(el, {onPick({lat,lon}), onSpot(id), units?: () => units, eco?: bool}) // -> {showSpot(spot, site), setTheme(dark), showSwell(bool), refreshSwell(), invalidate()}
```
Leaflet 1.9.4 (global L), Esri ocean / dark-gray basemaps (CARTO now needs a key), preferCanvas, spot circle markers, click on map = onPick, ray overlay (site.rays, open vs blocked styles), surf point & normal arrow, optional swell crest lines (js/swellmap.js, imported on first `showSwell(true)`; `showSwellArrows` is an alias).

## js/swellmap.js
```js
export function createSwellLayer(map, L, {units, eco}) // -> {setVisible(bool), setEco(bool), setTheme(dark), refresh(), remove()}
```
Canvas in its own map pane (between tiles and labels) covering the view plus a small margin. On `moveend` (debounced 250 ms) it fetches `api.currentSwellAt(view centre)` and terrarium tiles at `zt = clamp(zoom − 2, 5, 10)` (never above z10: no seabed there), samples depth on a 4 px grid, and per swell (secondary if h > 0.3 m) solves `|∇τ| = k(d)/k0` (Fenton–McKee, capped at 3) by fast sweeping from a plane wave on the upwind edges, land as obstacles. Crests are level sets `τ = (n + phase)·Δ`, Δ = 16–22 px by period, drawn by marching squares with opacity from a straight-line visibility field (blurred across the travel direction) and a shore fade. Colours `--crest`, `--crest-2`; legend chip with fmtHeight/compass. Animated (≤24 fps, one spacing per 2.5 s) only while on screen and the tab is visible; still frame in eco mode or with prefers-reduced-motion; hidden during zoom, frozen while panning. Visible between zoom 6 and 14.

## Design
Sustainable web design: system fonts only, tiny payload, lazy load heavy parts (3D only when
scrolled into view, map tiles only when map visible). Nautical chart palette in light mode
(paper #f3efe3, ink #14263a, chart-water blues, land buff, chart magenta accent #a3266b);
ECDIS night palette in dark mode (near-black blue bg, dim cyan/amber, low luminance). Spot
names in italic serif (`'Iowan Old Style', Palatino, 'Palatino Linotype', Georgia, serif`),
data in `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. CSS custom properties:
`--bg --surface --ink --muted --line --accent --water-0..4 --land --crest --crest-2 --r0..--r6` (rating colours).
