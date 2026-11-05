// Leaflet map: spot markers, click-to-pick, ray overlay, optional live swell arrows.
// Leaflet (global L) is injected lazily from cdnjs the first time a map is created,
// so pages without a map never download it. createMap() returns its API immediately;
// calls made before Leaflet arrives are queued on `ready`.

import { SPOTS } from './spots.js';
import { currentSwellMany } from './api.js';

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const SRI = {
  js: 'sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==',
  css: 'sha512-Zcn6bjR/8RZbLEpLIeOwNtzREBAJnUKESxces60Mpoj+2okopSAcSUIUOseddDm0cxnGQzxIR7vJgsLZbdLE3w==',
};
// Basemaps. The contract named CARTO light_all/dark_all, but CARTO now answers every
// keyless request with an "API KEY REQUIRED" image, so we use Esri's keyless tile services
// (CORS-enabled): World Ocean Base (with bathymetry shading, very chart-like) for light,
// Dark Gray Canvas for night, each with its thin label layer.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const BASEMAPS = {
  light: {
    base: ESRI + 'Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
    ref: ESRI + 'Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}',
    maxNative: 13,
    attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a> — GEBCO, NOAA, CHS, OSU, UNH, CSUMB, National Geographic, DeLorme, NAVTEQ',
  },
  dark: {
    base: ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    ref: ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    maxNative: 16,
    attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, © OpenStreetMap contributors',
  },
};
const TILE_EST = 15000; // bytes per tile when the server doesn't expose transfer size

let leafletP = null;
/** Inject Leaflet CSS + JS (with SRI) once. Resolves to the global L. */
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletP) return leafletP;
  leafletP = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    Object.assign(css, { rel: 'stylesheet', href: CDN + 'leaflet.css', integrity: SRI.css, crossOrigin: 'anonymous', referrerPolicy: 'no-referrer' });
    document.head.prepend(css);
    const s = document.createElement('script');
    Object.assign(s, { src: CDN + 'leaflet.js', integrity: SRI.js, crossOrigin: 'anonymous', referrerPolicy: 'no-referrer', async: true });
    s.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet failed to initialise')));
    s.onerror = () => { leafletP = null; s.remove(); reject(new Error('Could not load the map library (offline?)')); };
    document.head.append(s);
  });
  return leafletP;
}

// ---- tile byte accounting (shared by all maps) ----
let tileTotal = 0, tileCount = 0;
const tileListeners = new Set();
/** Estimated bytes of basemap tiles loaded this session. */
export function tileBytes() { return tileTotal; }
export function tileLoads() { return tileCount; }
export function onTileBytes(cb) { tileListeners.add(cb); return () => tileListeners.delete(cb); }
function countTile(src) {
  let n = TILE_EST; // CARTO sends no Timing-Allow-Origin, so sizes are usually hidden
  try {
    const e = performance.getEntriesByName(src).pop();
    if (e && e.encodedBodySize > 0) n = e.transferSize; // exposed: 0 = served from cache
  } catch { /* ignore */ }
  tileTotal += n; tileCount++;
  for (const cb of tileListeners) { try { cb(tileTotal); } catch { /* noop */ } }
}

// ---- helpers ----
const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};
const wrapLon = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
const R_EARTH = 6371000;
/** Point `dist` metres from (lat,lon) along compass bearing `brg`. */
function dest(lat, lon, brg, dist) {
  const b = (brg * Math.PI) / 180;
  const dLat = (dist * Math.cos(b)) / R_EARTH;
  const dLon = (dist * Math.sin(b)) / (R_EARTH * Math.cos((lat * Math.PI) / 180));
  return [lat + (dLat * 180) / Math.PI, lon + (dLon * 180) / Math.PI];
}

function arrowSvg(deg, len, color, label) {
  // arrow points the way the swell travels (from-direction + 180)
  const L = Math.round(len);
  return `<svg width="44" height="44" viewBox="-22 -22 44 44" aria-hidden="true" style="overflow:visible">
    <g transform="rotate(${(deg + 180) % 360})" stroke="${color}" fill="${color}" stroke-linecap="round">
      <line x1="0" y1="${L / 2}" x2="0" y2="${-L / 2 + 4}" stroke-width="2"/>
      <path d="M0 ${-L / 2 - 2} L4.5 ${-L / 2 + 6} L-4.5 ${-L / 2 + 6} Z" stroke="none"/>
    </g>${label ? `<text x="0" y="20" text-anchor="middle" class="swell-arrow-label">${label}</text>` : ''}
  </svg>`;
}

/**
 * @param {HTMLElement} el
 * @param {{onPick?:Function, onSpot?:Function, compact?:boolean, view?:{lat,lon,zoom}, spots?:Array}} opts
 *   (compact/view/spots are optional extras beyond the contract)
 */
export function createMap(el, { onPick, onSpot, compact = false, view, spots = SPOTS } = {}) {
  let map, tiles = [], markers = [], spotLayer, rayLayer, arrowLayer, dark = false, arrowsOn = false;
  let disposed = false;
  const swellCache = new Map(); // spot id -> {v, at}
  let arrowTimer = 0, arrowSeq = 0;

  const ready = loadLeaflet().then((L) => {
    if (disposed) return null;
    const touch = matchMedia('(pointer: coarse)').matches;
    map = L.map(el, {
      preferCanvas: true,
      worldCopyJump: true,
      zoomControl: true,
      minZoom: 1,
      zoomSnap: 0.5,
      scrollWheelZoom: false, // enabled once the user interacts with the map (no scroll-jacking)
      dragging: compact ? !touch : true,
      tap: false,
      attributionControl: true,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    const v = view || { lat: 22, lon: 0, zoom: el.clientWidth < 600 ? 1 : 2 };
    map.setView([v.lat, v.lon], v.zoom);
    map.on('click', () => map.scrollWheelZoom.enable());
    map.on('focus', () => map.scrollWheelZoom.enable());
    el.addEventListener('mouseleave', () => map.scrollWheelZoom.disable());

    map.createPane('labels');
    map.getPane('labels').style.zIndex = 390; // above tiles, below vectors
    map.getPane('labels').style.pointerEvents = 'none';
    setTiles(L);
    spotLayer = L.layerGroup().addTo(map);
    drawSpots(L);
    if (onPick) {
      map.on('click', (e) => onPick({ lat: +e.latlng.lat.toFixed(4), lon: +wrapLon(e.latlng.lng).toFixed(4) }));
      el.classList.add('map-pickable');
    }
    map.on('moveend', scheduleArrows);
    return map;
  });

  function setTiles(L) {
    for (const t of tiles || []) t.remove();
    const bm = BASEMAPS[dark ? 'dark' : 'light'];
    const common = { maxZoom: 18, maxNativeZoom: bm.maxNative, crossOrigin: true };
    const base = L.tileLayer(bm.base, { ...common, attribution: bm.attribution });
    const ref = L.tileLayer(bm.ref, { ...common, pane: 'labels' });
    tiles = [base, ref];
    for (const t of tiles) { t.on('tileload', (e) => countTile(e.tile.src)); t.addTo(map); }
  }

  function spotStyle() {
    return {
      radius: compact ? 4 : 5,
      color: cssVar('--surface', '#fff'),
      weight: 1.5,
      fillColor: cssVar('--accent', '#a3266b'),
      fillOpacity: 0.95,
      bubblingMouseEvents: false,
    };
  }

  function drawSpots(L) {
    spotLayer.clearLayers();
    markers = spots.map((s) => {
      const m = L.circleMarker([s.lat, s.lon], spotStyle());
      m.bindTooltip(`<b>${s.name}</b><br><span>${s.region}, ${s.country}</span>`, { direction: 'top', offset: [0, -4], className: 'spot-tip' });
      if (onSpot) m.on('click', () => onSpot(s.id));
      m.spot = s;
      m.addTo(spotLayer);
      return m;
    });
  }

  // ---- swell arrows ----
  function scheduleArrows() {
    clearTimeout(arrowTimer);
    if (!arrowsOn) return;
    arrowTimer = setTimeout(updateArrows, 600);
  }
  async function updateArrows() {
    if (!map || !arrowsOn) return;
    const L = window.L;
    const seq = ++arrowSeq;
    const b = map.getBounds().pad(0.05);
    const z = map.getZoom();
    let vis = spots.filter((s) => b.contains([s.lat, s.lon]) || b.contains([s.lat, s.lon + 360]) || b.contains([s.lat, s.lon - 360]));
    if (vis.length > 60) {
      // thin out: keep spots spread over the view
      const step = vis.length / 60;
      vis = Array.from({ length: 60 }, (_, k) => vis[Math.floor(k * step)]);
    }
    const now = Date.now();
    const need = vis.filter((s) => !(swellCache.get(s.id)?.at > now - 30 * 60e3));
    if (need.length) {
      try {
        const res = await currentSwellMany(need.map((s) => ({ lat: s.lat, lon: s.lon })));
        need.forEach((s, k) => swellCache.set(s.id, { v: res?.[k] || null, at: now }));
      } catch { /* network errors: just skip arrows */ }
    }
    if (seq !== arrowSeq || !arrowsOn) return;
    if (!arrowLayer) arrowLayer = L.layerGroup().addTo(map);
    arrowLayer.clearLayers();
    const color = cssVar('--water-ink', cssVar('--ink', '#14263a'));
    for (const s of vis) {
      const v = swellCache.get(s.id)?.v;
      if (!v || !(v.h > 0)) continue;
      const len = Math.max(12, Math.min(34, 10 + v.h * 7));
      const label = z >= 10 ? `${v.h.toFixed(1)}m ${Math.round(v.t)}s` : '';
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: 'swell-arrow', html: arrowSvg(v.dir, len, color, label), iconSize: [44, 44], iconAnchor: [22, 22] }),
        interactive: false, keyboard: false,
      }).addTo(arrowLayer);
    }
  }

  // ---- spot / ray overlay ----
  function showSpotImpl(spot, site) {
    const L = window.L;
    if (rayLayer) rayLayer.remove();
    rayLayer = L.layerGroup().addTo(map);
    const accent = cssVar('--accent', '#a3266b');
    const ray = cssVar('--ray', '#2f6f95');
    const muted = cssVar('--muted', '#888');
    const pts = [];
    if (site?.rays) {
      for (const r of site.rays) {
        if (!r.pts || r.pts.length < 2) continue;
        L.polyline(r.pts, r.open
          ? { color: ray, weight: 1.4, opacity: 0.75, interactive: false }
          : { color: muted, weight: 1, opacity: 0.55, dashArray: '3 4', interactive: false }).addTo(rayLayer);
        pts.push(...r.pts);
      }
    }
    if (site?.surf) {
      const sp = [site.surf.lat, site.surf.lon];
      if (Number.isFinite(site.normal)) {
        const tip = dest(site.surf.lat, site.surf.lon, site.normal, 900);
        const l = dest(tip[0], tip[1], site.normal + 155, 220);
        const r = dest(tip[0], tip[1], site.normal - 155, 220);
        L.polyline([sp, tip], { color: accent, weight: 2.5, interactive: false }).addTo(rayLayer);
        L.polygon([tip, l, r], { color: accent, fillColor: accent, fillOpacity: 1, weight: 1, interactive: false }).addTo(rayLayer);
        pts.push(tip);
      }
      L.circleMarker(sp, { radius: 6, color: cssVar('--surface', '#fff'), weight: 2, fillColor: accent, fillOpacity: 1, bubblingMouseEvents: false })
        .bindTooltip(`${Number.isFinite(site.surf.depth) ? `Surf point · ${Math.abs(site.surf.depth).toFixed(0)} m deep` : 'Surf point'}`, { direction: 'top', className: 'spot-tip' })
        .addTo(rayLayer);
      pts.push(sp);
    }
    if (site?.coast) {
      L.circleMarker([site.coast.lat, site.coast.lon], { radius: 3, color: accent, weight: 1.5, fillOpacity: 0, interactive: false }).addTo(rayLayer);
    }
    if (spot && !(site?.surf)) pts.push([spot.lat, spot.lon]);
    if (spot) {
      L.circleMarker([spot.lat, spot.lon], { radius: 3, color: cssVar('--ink', '#14263a'), weight: 1, fillColor: cssVar('--ink', '#14263a'), fillOpacity: 1, interactive: false }).addTo(rayLayer);
    }
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [16, 16], maxZoom: 14 });
    else if (pts.length === 1) map.setView(pts[0], 12);
  }

  const api = {
    ready,
    showSpot(spot, site) { ready.then((m) => m && showSpotImpl(spot, site)); },
    setTheme(isDark) {
      dark = !!isDark;
      ready.then((m) => {
        if (!m) return;
        setTiles(window.L);
        const st = spotStyle();
        markers.forEach((mk) => mk.setStyle(st));
        if (arrowsOn) updateArrows();
      });
    },
    showSwellArrows(on) {
      arrowsOn = !!on;
      ready.then((m) => {
        if (!m) return;
        if (arrowsOn) updateArrows();
        else if (arrowLayer) arrowLayer.clearLayers();
      });
    },
    invalidate() { ready.then((m) => m && m.invalidateSize()); },
    // extras (not in the contract, used by main.js)
    flyTo(lat, lon, zoom = 8) { ready.then((m) => m && m.flyTo([lat, lon], zoom, { duration: 0.8 })); },
    marker(lat, lon, label) {
      ready.then((m) => {
        if (!m) return;
        window.L.circleMarker([lat, lon], { radius: 6, color: cssVar('--accent', '#a3266b'), weight: 2, fillOpacity: 0.15, interactive: false })
          .addTo(m).bindTooltip(label || 'You', { permanent: false });
      });
    },
    dispose() { disposed = true; clearTimeout(arrowTimer); ready.then((m) => m && m.remove()); },
  };
  return api;
}
