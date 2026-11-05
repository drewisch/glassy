// Glassy app shell: routing, header controls, pages, persisted prefs, data meter.

import { SPOTS, SPOT_BY_ID, searchSpots, haversineKm, nearestSpots } from './spots.js';
import { bytesUsed, onBytes } from './net.js';
import * as api from './api.js';
import * as geo from './geo.js';
import { computeSurf, bestWindows, RATINGS } from './model.js';
import { buildReport, fmtRange, fmtSpeed, fmtTemp, fmtTide, compass, fmtTime, fmtDay, bodyRange } from './report.js';
import { forecastChart, tideChart, swellPolar, depthProfile } from './charts.js';
import { createMap, tileBytes, onTileBytes } from './map.js';

const APP_VERSION = '1.0.0';

// ---------------------------------------------------------------- scope
// Launch scope: California, with the Santa Barbara coast first. The spot catalogue
// (spots.js) is global; the UI lists and maps only California for now. Custom points
// (#/at/…) work anywhere.
const inCalifornia = (s) => s.country === 'USA' && s.lat >= 32 && s.lat <= 42.1 && s.lon >= -124.5 && s.lon <= -114;
const inSantaBarbara = (s) => s.lat >= 34.1 && s.lat <= 34.6 && s.lon >= -120.6 && s.lon <= -119.1;
const SCOPE = SPOTS.filter(inCalifornia);
const SCOPE_VIEW = { lat: 34.4, lon: -119.75, zoom: 9 };
const SCOPE_REGIONS = [
  ['Santa Barbara coast', inSantaBarbara],
  ['Northern California', (s) => s.lat >= 36.8],
  ['Central Coast', (s) => s.lat >= 34.3 && s.lat < 36.8],
  ['Los Angeles', (s) => s.lat >= 33.7 && s.lat < 34.3],
  ['Orange County', (s) => s.lat >= 33.35 && s.lat < 33.7],
  ['San Diego', (s) => s.lat < 33.35],
];

// ---------------------------------------------------------------- utils
const $ = (sel, root = document) => root.querySelector(sel);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const ico = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const rcVar = (r) => { const c = RATINGS[r]?.color || '--r0'; return c.startsWith('--') ? `var(${c})` : c; };
const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
const fmtKm = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(2)} MB`);
const dirArrow = (fromDeg, cls = 'dir-arrow') => `<svg class="${cls}" style="transform:rotate(${((fromDeg ?? 0) + 180) % 360}deg)" aria-hidden="true"><use href="#i-arrow"/></svg>`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const announce = (msg) => { const s = $('#status'); s.textContent = ''; setTimeout(() => { s.textContent = msg; }, 30); };

const store = {
  get(k, d) { try { const v = localStorage.getItem('glassy:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('glassy:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function defaultUnits() {
  const lang = (navigator.language || 'en-US').toLowerCase();
  if (lang === 'en-us' || lang.startsWith('en-lr') || lang === 'my') return { height: 'ft', speed: 'mph', temp: 'f' };
  if (lang === 'en-gb') return { height: 'ft', speed: 'mph', temp: 'c' };
  return { height: 'm', speed: 'kmh', temp: 'c' };
}

const state = {
  units: { ...defaultUnits(), ...store.get('units', {}) },
  theme: store.get('theme', 'auto'),
  favs: store.get('favs', []),
  arrows: store.get('arrows', true),
  eco: store.get('eco', matchMedia('(prefers-reduced-motion: reduce)').matches || !!navigator.connection?.saveData),
  me: null, // {lat, lon}
  spot: null, // current spot page data
};
const mq = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => state.theme === 'dark' || (state.theme === 'auto' && mq.matches);

// Per-route resources to dispose on navigation.
let cleanups = [];
let routeSeq = 0;
const onLeave = (fn) => cleanups.push(fn);

// ---------------------------------------------------------------- favourites
const favKey = (s) => (s.id ? s.id : `at:${(+s.lat).toFixed(4)},${(+s.lon).toFixed(4)}`);
const isFav = (s) => state.favs.some((f) => f.key === favKey(s));
function toggleFav(s) {
  const k = favKey(s);
  if (isFav(s)) state.favs = state.favs.filter((f) => f.key !== k);
  else state.favs = [{ key: k, id: s.id || null, name: s.name, region: s.region || '', country: s.country || '', lat: +s.lat, lon: +s.lon }, ...state.favs].slice(0, 40);
  store.set('favs', state.favs);
  return isFav(s);
}
const hrefFor = (s) => (s.id ? `#/spot/${s.id}` : `#/at/${(+s.lat).toFixed(4)},${(+s.lon).toFixed(4)}`);

// ---------------------------------------------------------------- theme
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = state.theme;
  const b = $('#btn-theme');
  const icon = { auto: 'i-auto', light: 'i-sun', dark: 'i-moon' }[state.theme];
  b.innerHTML = ico(icon);
  b.setAttribute('aria-label', `Theme: ${state.theme} (click to change)`);
  b.title = `Theme: ${state.theme}`;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = isDark() ? '#05090f' : '#f3efe3';
    if (state.theme !== 'auto') m.removeAttribute('media');
  });
  document.dispatchEvent(new CustomEvent('glassy:theme', { detail: isDark() }));
}
$('#btn-theme').addEventListener('click', () => {
  state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme] || 'auto';
  store.set('theme', state.theme);
  applyTheme();
  announce(`Theme ${state.theme}`);
});
mq.addEventListener?.('change', () => state.theme === 'auto' && applyTheme());

// ---------------------------------------------------------------- units
function initUnits() {
  const menu = $('#units-menu');
  for (const [k, name] of [['height', 'u-height'], ['speed', 'u-speed'], ['temp', 'u-temp']]) {
    menu.querySelectorAll(`input[name="${name}"]`).forEach((inp) => {
      inp.checked = inp.value === state.units[k];
      inp.addEventListener('change', () => {
        state.units = { ...state.units, [k]: inp.value };
        store.set('units', state.units);
        document.dispatchEvent(new CustomEvent('glassy:units'));
      });
    });
  }
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); } });
}

// ---------------------------------------------------------------- search
function initSearch() {
  const input = $('#q'), list = $('#q-list');
  let items = [], active = -1, placeSeq = 0, places = [], spots = [];

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const choose = (it) => {
    if (!it) return;
    close(); input.value = ''; input.blur();
    location.hash = it.href;
  };
  function render() {
    const q = input.value.trim();
    items = [
      ...spots.map((s) => ({ href: `#/spot/${s.id}`, name: s.name, sub: `${s.region}, ${s.country}`, grp: 'Surf breaks' })),
      ...places.map((p) => ({ href: `#/at/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, name: p.name, sub: [p.admin, p.country].filter(Boolean).join(', '), grp: 'Places' })),
    ];
    if (!q) { close(); return; }
    let html = '', g = '';
    items.forEach((it, i) => {
      if (it.grp !== g) { g = it.grp; html += `<li class="grp" role="presentation">${g}</li>`; }
      html += `<li role="option" id="q-o${i}" aria-selected="${i === active}" data-i="${i}"><span class="nm">${esc(it.name)}</span><span class="sub">${esc(it.sub)}</span></li>`;
    });
    if (!items.length) html = `<li class="empty" role="presentation">${q.length < 3 ? 'Keep typing…' : 'Searching places…'}</li>`;
    list.innerHTML = html;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `q-o${active}`); else input.removeAttribute('aria-activedescendant');
  }
  const lookupPlaces = debounce(async (q) => {
    const seq = ++placeSeq;
    let res = [];
    try { res = q.length >= 3 ? await api.geocode(q) : []; } catch { res = []; }
    if (seq !== placeSeq) return;
    places = res || [];
    if (!places.length && !spots.length && q.length >= 3) {
      list.innerHTML = `<li class="empty" role="presentation">No breaks or places match “${esc(q)}”.</li>`;
      return;
    }
    render();
  }, 350);

  input.addEventListener('input', () => {
    const q = input.value.trim();
    active = -1;
    spots = q ? searchSpots(q, 12).filter(inCalifornia).slice(0, 6) : [];
    places = [];
    render();
    if (q.length >= 3) lookupPlaces(q); else placeSeq++;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
      $(`#q-o${active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active >= 0 ? active : 0]);
    } else if (e.key === 'Escape') {
      if (!list.hidden) close(); else input.blur();
    }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => { const li = e.target.closest('[role="option"]'); if (li) choose(items[+li.dataset.i]); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => input.value.trim() && render());
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); input.focus(); }
  });
}

// ---------------------------------------------------------------- geolocation
function locate({ quiet = false } = {}) {
  const btn = $('#btn-locate');
  return new Promise((resolve) => {
    if (!navigator.geolocation) { if (!quiet) announce('Location is not available in this browser'); resolve(null); return; }
    btn.classList.add('busy');
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.classList.remove('busy');
      state.me = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) };
      resolve(state.me);
    }, (err) => {
      btn.classList.remove('busy');
      if (!quiet) announce(err.code === 1 ? 'Location permission denied' : 'Could not get your location');
      resolve(null);
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  });
}
$('#btn-locate').addEventListener('click', async () => {
  const me = await locate();
  if (!me) return;
  if (parseRoute().kind !== 'home') location.hash = '#/';
  else document.dispatchEvent(new CustomEvent('glassy:located'));
  announce('Showing spots near you');
});

// ---------------------------------------------------------------- data meter
const meter = { page: 0 };
function updateMeter() {
  const data = bytesUsed(), tiles = tileBytes();
  const total = meter.page + data + tiles;
  $('#m-total').textContent = fmtBytes(total);
  $('#m-split').textContent = `app ${fmtBytes(meter.page)} · data ${fmtBytes(data)} · map ≈${fmtBytes(tiles)}`;
  $('#m-co2').textContent = `${((total / 1048576) * 0.36).toFixed(total > 5 * 1048576 ? 1 : 2)} g`;
}
const updateMeterSoon = debounce(updateMeter, 120);
function initMeter() {
  // App shell + Leaflet via Resource Timing; API/terrain via net.js; map tiles via map.js.
  const take = (e) => {
    if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'beacon') return;
    if (/arcgisonline\.com/.test(e.name)) return; // counted by map.js
    meter.page += e.transferSize || 0;
  };
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) meter.page += nav.transferSize || 0;
    performance.getEntriesByType('resource').forEach(take);
    new PerformanceObserver((l) => { l.getEntries().forEach(take); updateMeterSoon(); }).observe({ type: 'resource', buffered: false });
  } catch { /* old browser */ }
  onBytes(updateMeterSoon);
  onTileBytes(updateMeterSoon);
  updateMeter();
}

// ---------------------------------------------------------------- routing
function parseRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [kind, arg = ''] = h.split('/');
  if (kind === 'spot' && arg) return { kind: 'spot', id: arg };
  if (kind === 'at') {
    const [lat, lon] = arg.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90) return { kind: 'at', lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
    return { kind: 'bad' };
  }
  if (!kind) return { kind: 'home' };
  return { kind: 'bad' };
}

function route() {
  routeSeq++;
  cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
  cleanups = [];
  state.spot = null;
  const r = parseRoute();
  const main = $('#main');
  main.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (r.kind === 'home') renderHome(main);
  else if (r.kind === 'spot') {
    const s = SPOT_BY_ID.get(r.id);
    if (!s) renderNotFound(main, 'That break isn’t in the list.');
    else renderSpot(main, { ...s });
  } else if (r.kind === 'at') {
    const near = nearestSpots(r, 1)[0];
    renderSpot(main, { id: null, name: 'Dropped pin', region: '', country: '', lat: r.lat, lon: r.lon, custom: true, near });
  } else renderNotFound(main, 'That page doesn’t exist.');
}

function focusMain(h1) {
  // Move focus for screen readers on in-app navigation, but not on first load.
  if (!route.first) { route.first = true; return; }
  (h1 || $('#main')).focus({ preventScroll: true });
}

function renderNotFound(main, msg) {
  document.title = 'Not found — Glassy';
  main.innerHTML = errorHTML('Nothing here', msg, false);
  focusMain();
}

function errorHTML(title, msg, retry = true) {
  return `<section class="card error-card fade-in" role="alert">
    <svg class="glyph" aria-hidden="true"><use href="#i-wave"/></svg>
    <h2 tabindex="-1">${esc(title)}</h2><p>${esc(msg)}</p>
    <div class="row">${retry ? '<button class="btn primary" data-retry type="button">Try again</button>' : ''}<a class="btn" href="#/">Back to the map</a></div>
  </section>`;
}

// ---------------------------------------------------------------- home
function spotCardHTML(s, extra = '') {
  return `<a class="spot-card" href="${hrefFor(s)}" data-key="${esc(favKey(s))}">
    <span class="nm">${esc(s.name)}</span>
    <span class="rg">${esc([s.region, s.country].filter(Boolean).join(', '))}${extra}</span>
    <span class="sw" aria-label="Offshore swell now"></span>
  </a>`;
}

function renderHome(main) {
  document.title = 'Glassy — surf forecast';
  const seen = new Set();
  const byRegion = SCOPE_REGIONS.map(([name, test]) => {
    const list = SCOPE.filter((s) => !seen.has(s.id) && test(s));
    list.forEach((s) => seen.add(s.id));
    if (test === inSantaBarbara) list.sort((a, b) => a.lon - b.lon);
    return [name, list];
  });
  const rest = SCOPE.filter((s) => !seen.has(s.id));
  if (rest.length) byRegion.push(['More', rest]);

  main.innerHTML = `
    <section class="home-hero fade-in" aria-label="Map">
      <div class="home-map">
        <div class="map" id="home-map" role="application" aria-label="Map of California surf breaks, centred on the Santa Barbara Channel. Click a marker to open a break, or anywhere on the coast for a custom forecast."></div>
        <div class="map-overlay">
          <div class="map-hint"><b>Tap any coastline</b><span class="muted">Markers are known breaks. Click anywhere else and Glassy models that exact spot from the seabed up.</span></div>
          <button class="btn small" id="arrows-btn" type="button" aria-pressed="${state.arrows}">Swell arrows</button>
        </div>
      </div>
    </section>
    <div class="intro fade-in">
      <h1 tabindex="-1">Surf forecasts, worked out from the seafloor up.</h1>
      <p>Open ocean swell, wind and tide, refracted over real bathymetry for each break. No ads, no tracking, a few hundred kilobytes.</p>
    </div>
    <section class="sec" id="sec-favs" aria-labelledby="h-favs"><h2 id="h-favs">Favourites</h2><div id="favs"></div></section>
    <section class="sec" id="sec-near" aria-labelledby="h-near" hidden><h2 id="h-near">Near you</h2><div id="near"></div></section>
    <section class="sec" aria-labelledby="h-pop"><h2 id="h-pop">California breaks</h2>
      <div class="regions">${byRegion.filter(([, l]) => l.length).map(([name, list], k) => `
        <div class="region${k === 0 ? ' region-first' : ''}"><h3>${esc(name)} <span>${list.length}</span></h3><ul>
        ${list.map((s) => `<li><a href="#/spot/${s.id}"><span class="nm">${esc(s.name)}</span><span class="rg">${esc(s.region)}</span></a></li>`).join('')}
        </ul></div>`).join('')}
      </div>
    </section>`;

  // map
  const map = createMap($('#home-map'), {
    spots: SCOPE,
    view: SCOPE_VIEW,
    onPick: ({ lat, lon }) => { location.hash = `#/at/${lat.toFixed(4)},${lon.toFixed(4)}`; },
    onSpot: (id) => { location.hash = `#/spot/${id}`; },
  });
  map.setTheme(isDark());
  map.showSwellArrows(state.arrows);
  map.ready.catch(() => { $('#home-map').innerHTML = `<div class="scene-status">Map unavailable offline. Use search or the list below.</div>`; });
  const onTheme = (e) => map.setTheme(e.detail);
  document.addEventListener('glassy:theme', onTheme);
  onLeave(() => { document.removeEventListener('glassy:theme', onTheme); map.dispose(); });
  $('#arrows-btn').addEventListener('click', (e) => {
    state.arrows = !state.arrows; store.set('arrows', state.arrows);
    e.currentTarget.setAttribute('aria-pressed', state.arrows);
    map.showSwellArrows(state.arrows);
  });

  // favourites
  const favs = state.favs;
  $('#favs').innerHTML = favs.length
    ? `<div class="spot-grid">${favs.map((f) => spotCardHTML(f)).join('')}</div>`
    : `<p class="empty-note">Star a break to keep it here. Favourites stay on this device only.</p>`;

  const fillSwell = async (cards) => {
    if (!cards.length) return;
    const seq = routeSeq;
    let res;
    try { res = await api.currentSwellMany(cards.map((c) => ({ lat: c.lat, lon: c.lon }))); } catch { return; }
    if (seq !== routeSeq || !res) return;
    cards.forEach((c, i) => {
      const v = res[i];
      const el = document.querySelector(`.spot-card[data-key="${CSS.escape(c.key)}"] .sw`);
      if (!el || !v || !(v.h >= 0)) return;
      const hStr = state.units.height === 'm' ? `${v.h.toFixed(1)} m` : `${(v.h * 3.28084).toFixed(1)} ft`;
      el.innerHTML = `<b>${hStr}</b>${Math.round(v.t)}s ${compass(v.dir)} ${dirArrow(v.dir, 'arr')}`;
      el.title = 'Offshore swell now (before local refraction)';
    });
  };

  const showNear = (me) => {
    const sec = $('#sec-near');
    if (!sec || !me) return;
    const list = nearestSpots(me, 40).filter((x) => inCalifornia(x.s)).slice(0, 6);
    sec.hidden = false;
    $('#near').innerHTML = `<div class="spot-grid">${list.map(({ s, d }) => spotCardHTML(s, ` · ${fmtKm(d)}`)).join('')}</div>
      <p style="margin-top:12px"><a class="btn small" href="#/at/${me.lat.toFixed(4)},${me.lon.toFixed(4)}">${ico('i-pin')} Forecast for my exact location</a></p>`;
    map.marker(me.lat, me.lon, 'You are here');
    if (list.length && list[0].d < 400) map.flyTo(list[0].s.lat, list[0].s.lon, 9);
    fillSwell(list.map(({ s }) => ({ key: favKey(s), lat: s.lat, lon: s.lon })));
  };
  const onLocated = () => showNear(state.me);
  document.addEventListener('glassy:located', onLocated);
  onLeave(() => document.removeEventListener('glassy:located', onLocated));

  fillSwell(favs);
  if (state.me) showNear(state.me);
  else navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
    if (p.state === 'granted') locate({ quiet: true }).then((me) => me && showNear(me));
  }).catch(() => {});

  const onUnits = () => fillSwell(state.favs);
  document.addEventListener('glassy:units', onUnits);
  onLeave(() => document.removeEventListener('glassy:units', onUnits));
  focusMain($('.intro h1'));
}

// ---------------------------------------------------------------- spot page
const PART_LABEL = { swell: 'Primary', swell2: 'Secondary', windWave: 'Wind waves' };
const KIND_LABEL = { offshore: 'Offshore', 'cross-off': 'Cross-offshore', cross: 'Cross-shore', 'cross-on': 'Cross-onshore', onshore: 'Onshore', glassy: 'Glassy' };

function nowIndex(fc) {
  const local = new Date(Date.now() + (fc.utcOffsetSeconds || 0) * 1000).toISOString().slice(0, 13);
  const i = fc.time.findIndex((t) => t.slice(0, 13) >= local);
  return i < 0 ? fc.time.length - 1 : i;
}

function skeletonHTML(s) {
  return `
  <header class="spot-head">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Map</a><span aria-hidden="true">/</span><span>${esc([s.region, s.country].filter(Boolean).join(', ') || fmtCoord(s.lat, s.lon))}</span></nav>
    <h1 tabindex="-1" id="spot-name">${esc(s.name)}</h1>
    <button class="btn fav-btn" id="fav" type="button" aria-pressed="${isFav(s)}">${ico('i-star')}<span>${isFav(s) ? 'Saved' : 'Save'}</span></button>
    <div class="meta"><span>${fmtCoord(s.lat, s.lon)}</span><span id="meta-extra"></span></div>
  </header>
  <div id="spot-body" aria-busy="true">
    <div class="spot-grid-main">
      <section class="card"><div class="sk sk-line w40"></div><div class="sk sk-big"></div><div class="sk sk-line w80"></div><div class="sk sk-line w60"></div><div class="sk sk-block" style="height:110px;margin-top:14px"></div></section>
      <section class="card"><div class="sk sk-line w80" style="height:22px"></div><div class="sk sk-line"></div><div class="sk sk-line w80"></div><div class="sk sk-line w60"></div><div class="sk sk-line"></div><div class="sk sk-line w40"></div>
        <p class="progress" id="progress">Fetching swell and reading the seafloor…</p></section>
      <section class="card span-all"><div class="sk sk-block"></div></section>
    </div>
  </div>`;
}

async function renderSpot(main, spot) {
  const seq = routeSeq;
  const alive = () => seq === routeSeq;
  document.title = `${spot.name} surf forecast — Glassy`;
  main.innerHTML = skeletonHTML(spot);
  focusMain($('#spot-name'));

  $('#fav').addEventListener('click', (e) => {
    const on = toggleFav(spot);
    e.currentTarget.setAttribute('aria-pressed', on);
    e.currentTarget.querySelector('span').textContent = on ? 'Saved' : 'Save';
    announce(on ? `${spot.name} saved to favourites` : `${spot.name} removed from favourites`);
  });

  if (spot.custom) {
    api.reverseGeocode(spot.lat, spot.lon).then((r) => {
      if (!alive() || !r) return;
      Object.assign(spot, { name: r.name || 'Dropped pin', region: r.region || '', country: r.country || '' });
      $('#spot-name').textContent = spot.name;
      $('.crumbs span:last-child').textContent = [spot.region, spot.country].filter(Boolean).join(', ') || fmtCoord(spot.lat, spot.lon);
      document.title = `${spot.name} surf forecast — Glassy`;
      // keep a saved custom favourite's name fresh
      const f = state.favs.find((x) => x.key === favKey(spot));
      if (f) { Object.assign(f, { name: spot.name, region: spot.region, country: spot.country }); store.set('favs', state.favs); }
      if (state.spot) rebuildReport();
    }).catch(() => {});
    if (spot.near && spot.near.d < 25) {
      $('#meta-extra').innerHTML = `Nearest named break: <a href="#/spot/${spot.near.s.id}">${esc(spot.near.s.name)}</a> (${fmtKm(spot.near.d)})`;
    }
  }

  const progress = (t) => { const p = $('#progress'); if (p) p.textContent = t; };
  let data;
  try {
    data = await loadSpotData(spot, { onProgress: progress });
  } catch (err) {
    if (!alive()) return;
    showSpotError(main, err, () => renderSpot(main, spot));
    return;
  }
  if (!alive()) return;
  const { site, forecast: fc, refOpen, hourly, report } = data;
  const ni = nowIndex(fc);
  state.spot = { spot, fc, site, refOpen, hourly, i: ni, nowI: ni, rep: report, charts: {}, scene: null };
  renderSpotBody();
}

/**
 * The single place that loads and models a spot. Everything the spot page shows comes
 * from here, so the data source can be swapped (e.g. CDIP MOP nearshore output for
 * California) without touching rendering.
 * Optional site fields: window, blocked, rays, kd2, profile, normal, surf, slope.
 * @returns {Promise<{site, forecast, refOpen, hourly, report}>}
 */
async function loadSpotData(spot, { onProgress = () => {} } = {}) {
  const { lat, lon } = spot;
  const fP = api.getForecast(lat, lon).then((x) => { onProgress('Swell in. Tracing rays over the bathymetry…'); return x; });
  const sP = geo.analyzeSite(lat, lon).then((x) => { onProgress('Seafloor mapped. Waiting for the swell model…'); return x; });
  const [forecast, site] = await Promise.all([fP, sP]);
  onProgress('Correcting for the model grid cell’s exposure…');
  const refOpen = forecast.ref ? await geo.referenceExposure(forecast.ref.lat, forecast.ref.lon).catch(() => null) : null;
  const hourly = computeSurf(site, forecast, refOpen);
  if (!hourly?.length) throw new Error('The forecast came back empty.');
  const report = makeReport(spot, site, hourly, forecast);
  return { site, forecast, refOpen, hourly, report };
}

function makeReport(spot, site, hourly, forecast) {
  try {
    return buildReport({ spot, site, hourly, forecast, units: state.units });
  } catch (err) {
    console.warn('report', err);
    return { headline: 'Forecast', paragraphs: [], outlook: [], tides: [] };
  }
}

function showSpotError(main, err, retry) {
  const msg = String(err?.message || err || 'Unknown error');
  let title = 'Couldn’t build a forecast here', text = msg;
  if (/ocean|sea|water|coast/i.test(msg)) { title = 'No ocean found nearby'; }
  else if (/fetch|network|offline|load/i.test(msg) || !navigator.onLine) { title = 'Can’t reach the forecast servers'; text = navigator.onLine ? msg : 'You appear to be offline. Previously viewed spots may still work.'; }
  const body = $('#spot-body');
  (body || main).innerHTML = errorHTML(title, text, true);
  body?.removeAttribute('aria-busy');
  (body || main).querySelector('[data-retry]')?.addEventListener('click', retry);
  (body || main).querySelector('h2')?.focus();
  announce(title);
}

function rebuildReport() {
  const S = state.spot;
  S.rep = makeReport(S.spot, S.site, S.hourly, S.fc);
  renderReport();
}

function renderReport() {
  const el = $('#report');
  if (el) el.innerHTML = reportHTML();
  const ol = $('#outlook');
  if (ol) ol.innerHTML = outlookHTML();
}

function reportHTML() {
  const S = state.spot, r = S.rep;
  let wins = [];
  try { wins = bestWindows(S.hourly, 3) || []; } catch { wins = []; }
  const nowT = S.hourly[S.nowI].time;
  const endOf = (w) => (typeof w.end === 'number' ? S.hourly[w.end]?.time : w.end) || '';
  wins = wins.flat().filter((w) => w && endOf(w) > nowT && w.rating > 0).slice(0, 3);
  const winHTML = wins.length ? `
    <div class="card-h" style="margin:16px 0 8px"><h3>Best windows</h3></div>
    <ul class="windows">${wins.map((w) => {
      const st = typeof w.start === 'number' ? S.hourly[w.start]?.time : w.start;
      const en = typeof w.end === 'number' ? S.hourly[w.end]?.time : w.end;
      return `<li style="--rc:${rcVar(w.rating)}"><i></i>${fmtDay(st).split(' ')[0]} ${fmtTime(st)}–${fmtTime(en)} · ${esc(RATINGS[w.rating]?.label || '')}</li>`;
    }).join('')}</ul>` : '';
  return `<h2 class="headline">${esc(r.headline)}</h2>${(r.paragraphs || []).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')}${winHTML}`;
}

function outlookHTML() {
  const S = state.spot;
  const byDay = new Map();
  S.hourly.forEach((h) => {
    const d = h.time.slice(0, 10);
    const o = byDay.get(d) || { min: 0, max: 0, rating: 0 };
    if (h.daylight !== false) { o.min = Math.max(o.min, h.min); o.max = Math.max(o.max, h.max); o.rating = Math.max(o.rating, h.rating); }
    byDay.set(d, o);
  });
  const texts = new Map((S.rep.outlook || []).map((o) => [o.date, o.text]));
  return [...byDay].map(([d, o]) => `<li style="--rc:${rcVar(o.rating)}">
      <span class="d">${esc(fmtDay(d))}</span>
      <span class="h"><i aria-hidden="true"></i>${esc(fmtRange(o.min, o.max, state.units))}</span>
      <span class="t">${esc(texts.get(d) || RATINGS[o.rating]?.label || '')}</span></li>`).join('');
}

function renderSpotBody() {
  const S = state.spot;
  const { spot, site, fc } = S;
  const body = $('#spot-body');
  // Optional site layers (a nearshore-model data source may not provide them)
  const hasNormal = Number.isFinite(site.normal);
  const hasWindow = !!site.window?.length;
  const hasProfile = (site.profile?.length || 0) >= 2;
  const hasRays = !!site.rays?.length;
  const distRef = fc.ref ? haversineKm(site.surf || spot, fc.ref) : null;
  const metaBits = [hasNormal ? `Faces ${compass(site.normal)} (${Math.round(site.normal)}°)` : '', fc.timezone ? `local time ${esc(fc.timezone.replace(/_/g, ' '))}` : ''].filter(Boolean);
  $('#meta-extra').insertAdjacentHTML('beforeend', `${$('#meta-extra').textContent && metaBits.length ? ' · ' : ''}${metaBits.join(' · ')}`);
  const fact = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;

  body.innerHTML = `
    <div class="spot-grid-main">
      <section class="card hero fade-in" id="hero" aria-labelledby="hero-when"></section>
      <section class="card report fade-in" id="report" aria-label="Surf report"></section>

      <section class="card span-all fade-in" aria-labelledby="h-fc">
        <div class="card-h"><h2 id="h-fc">8-day forecast</h2><span class="sub">tap a bar to inspect an hour</span></div>
        <div class="chart-box tall" id="fc-chart"></div>
      </section>

      ${hasWindow ? `<section class="card fade-in" aria-labelledby="h-polar">
        <div class="card-h"><h2 id="h-polar">Swell window</h2><span class="sub">which directions reach this break</span></div>
        <div class="chart-box" id="polar"></div>
      </section>` : ''}
      <section class="card fade-in${hasWindow ? '' : ' span-all'}" aria-labelledby="h-parts">
        <div class="card-h"><h2 id="h-parts">Swell components</h2><span class="sub mono" id="parts-when"></span></div>
        <div class="tbl-wrap" id="parts"></div>
        <p class="chart-note">Offshore height is from the Open-Meteo wave model; <i>at break</i> is after refraction &amp; island shadowing (K<sub>d</sub>); breaking height uses Komar–Gaughan.</p>
      </section>


      <section class="card span-all fade-in" aria-labelledby="h-tide">
        <div class="card-h"><h2 id="h-tide">Tide</h2><span class="sub mono" id="tide-when"></span></div>
        <div class="chart-box" id="tide"></div>
      </section>

      <section class="card span-all fade-in" aria-labelledby="h-3d">
        <div class="card-h"><h2 id="h-3d">Swell over the seabed</h2>
          <button class="btn small" id="eco" type="button" aria-pressed="${state.eco}" title="Eco mode renders a single still frame">${ico('i-leaf')} Eco</button></div>
        <div class="scene-wrap" id="scene-wrap">
          <canvas id="scene" role="img" aria-label="3D diorama of the seafloor and coast around the break with animated swell crests"></canvas>
          <div class="scene-status" id="scene-status">The 3D view loads when you scroll here.</div>
        </div>
        <p class="caption">This is the real seafloor and coastline in a 6 km square around the surf point (AWS Terrain Tiles bathymetry, height exaggerated). Crests follow the selected hour’s dominant swell as it bends over the contours, solved from the wave-speed field; white water marks where depth drops below the breaking depth. Drag to orbit, scroll or pinch to zoom.</p>
      </section>

      ${hasProfile ? `<section class="card fade-in" aria-labelledby="h-depth">
        <div class="card-h"><h2 id="h-depth">Depth profile</h2><span class="sub">along the shore normal</span></div>
        <div class="chart-box" id="depth"></div>
      </section>` : ''}
      <section class="card fade-in${hasProfile ? '' : ' span-all'}" aria-labelledby="h-map">
        <div class="card-h"><h2 id="h-map">${hasRays ? 'Wave rays' : 'Location'}</h2>${hasRays ? '<span class="sub">14 s swell, traced back offshore</span>' : ''}</div>
        <div class="mini-map" id="mini-map" aria-label="${hasRays ? 'Map showing refracted wave rays reaching the break' : 'Map of the break'}"></div>
        ${hasRays || hasNormal ? `<div class="legend">${hasRays ? '<span><i></i>open to the ocean</span><span><i class="blk"></i>blocked by land</span>' : ''}${hasNormal ? '<span><i class="nrm"></i>shore normal</span>' : ''}</div>` : ''}
      </section>

      <section class="card span-all fade-in" aria-labelledby="h-out">
        <div class="card-h"><h2 id="h-out">Outlook</h2><span class="sub">daylight peak per day</span></div>
        <ol class="outlook" id="outlook"></ol>
      </section>

      <details class="card how span-all">
        <summary>How this is modelled</summary>
        <div class="how-body">
          <dl class="facts">
            ${hasNormal ? fact('Beach faces', `${compass(site.normal)} ${Math.round(site.normal)}°`) : ''}
            ${Number.isFinite(site.surf?.depth) ? fact('Surf point depth', `${Math.abs(site.surf.depth).toFixed(1)} m`) : ''}
            ${site.slope > 0 ? fact('Nearshore slope', `1:${Math.round(1 / site.slope)}`) : ''}
            ${distRef != null ? fact('Wave model cell', `${fmtKm(distRef)} away`) : ''}
            ${site.blocked ? fact('Blocked sectors', site.blocked.length ? site.blocked.map((b) => `${Math.round(b.from)}–${Math.round(b.to)}°`).slice(0, 3).join(', ') : 'none') : ''}
            ${site.meta?.ms ? fact('Site analysis', `${Math.round(site.meta.ms)} ms`) : ''}
          </dl>
          <ol>
            <li><b>Offshore sea state.</b> Hourly swell partitions (primary, secondary, wind waves), wind, tide and water temperature come from Open-Meteo’s marine and weather models for the nearest sea grid cell.</li>
            <li><b>The seabed.</b> Terrain tiles (z12 near the break, z8 for the wider ocean) are decoded in a background worker. Glassy snaps your point to the coastline, finds the shore normal, and picks a surf point at about 8 m depth.</li>
            <li><b>Refraction &amp; shadowing.</b> From the surf point, rays are traced backwards for nine wave periods using Snell’s law over smoothed depth. Rays that hit land are blocked; the rest give a directional coefficient K<sub>d</sub>² for each period and offshore direction, spread over a realistic directional spectrum.</li>
            <li><b>Exposure correction.</b> The model grid cell may itself be sheltered, so its own openness is divided out (floored at 0.2) and K<sub>d</sub>² capped at 1.3.</li>
            <li><b>Breaking.</b> Each component is transformed (<code>H0′ = H·K<sub>d</sub></code>) and broken with Komar–Gaughan, <code>Hb = 0.39·g<sup>0.2</sup>(T·H0′²)<sup>0.4</sup></code>, then combined as the root sum of squares. Face heights shown are 0.55–0.85 × Hb.</li>
            <li><b>Rating.</b> Height, period and wind relative to the shore (offshore is good, onshore bad, under 2 m/s glassy) combine into a seven-step rating. The report is written from these numbers by rules, not by a language model.</li>
          </ol>
          <p class="muted">Limitations: no sandbar detail finer than ~30 m, no reef/point-specific breaking, tide effects on breaking are not modelled, and the wave model itself can be wrong. Treat it as an informed estimate.</p>
        </div>
      </details>
    </div>`;
  body.removeAttribute('aria-busy');

  renderReport();

  // forecast chart
  try {
    S.charts.fc = forecastChart($('#fc-chart'), S.hourly, { units: state.units, onSelect: (i) => setHour(i, { fromChart: true }) });
  } catch (err) { chartError('#fc-chart', err); }
  if (hasProfile) { try { depthProfile($('#depth'), site, state.units); } catch (err) { chartError('#depth', err); } }

  setHour(S.i, { initial: true });
  S.charts.fc?.select?.(S.i);

  // 3D scene, lazily
  initScene();
  // mini map, lazily
  lazy($('#mini-map'), () => {
    const m = createMap($('#mini-map'), { compact: true, spots: SCOPE, onSpot: (id) => { location.hash = `#/spot/${id}`; }, view: { lat: spot.lat, lon: spot.lon, zoom: 12 } });
    m.setTheme(isDark());
    m.showSpot(spot, site);
    m.ready.catch(() => { $('#mini-map').innerHTML = '<div class="inline-err">Map unavailable.</div>'; });
    const onTheme = (e) => m.setTheme(e.detail);
    document.addEventListener('glassy:theme', onTheme);
    onLeave(() => { document.removeEventListener('glassy:theme', onTheme); m.dispose(); });
  });

  const onUnits = () => {
    if (!state.spot) return;
    rebuildReport();
    try { S.charts.fc = forecastChart($('#fc-chart'), S.hourly, { units: state.units, onSelect: (i) => setHour(i, { fromChart: true }) }); S.charts.fc?.select?.(S.i); } catch (err) { chartError('#fc-chart', err); }
    if (hasProfile) { try { depthProfile($('#depth'), site, state.units); } catch { /* shown before */ } }
    setHour(S.i, { initial: true });
  };
  document.addEventListener('glassy:units', onUnits);
  onLeave(() => document.removeEventListener('glassy:units', onUnits));
  announce(`Forecast loaded for ${spot.name}`);
}

function chartError(sel, err) {
  console.warn(sel, err);
  const el = $(sel);
  if (el) el.innerHTML = `<div class="inline-err">This chart couldn’t be drawn.</div>`;
}

function lazy(el, fn, margin = '250px') {
  if (!el) return;
  if (!('IntersectionObserver' in window)) { fn(); return; }
  const io = new IntersectionObserver((ents) => {
    if (ents.some((e) => e.isIntersecting)) { io.disconnect(); fn(); }
  }, { rootMargin: margin });
  io.observe(el);
  onLeave(() => io.disconnect());
}

function dominantPart(h) {
  return (h.parts || []).reduce((a, p) => (!a || p.hb > a.hb ? p : a), null);
}

function heroHTML(i) {
  const S = state.spot, h = S.hourly[i], u = state.units, fc = S.fc;
  const isNow = i === S.nowI;
  const rng = fmtRange(h.min, h.max, u);
  const m = rng.match(/^([<\d.–-]+)\s*(\S+)$/);
  const flat = h.max < 0.1;
  const tideNext = fc.tide?.[i + 1] ?? fc.tide?.[i];
  const rising = tideNext != null && h.tide != null ? tideNext > h.tide : null;
  const nextTide = (S.rep?.tides || []).find((t) => t.time > h.time);
  const dp = dominantPart(h);
  const w = h.wind || {};
  const r = Math.max(0, Math.min(6, h.rating | 0));
  return `
    <div class="when-bar">
      <button class="icon-btn" data-step="-3" type="button" aria-label="3 hours earlier">${ico('i-chev-l')}</button>
      <span class="when" id="hero-when">${isNow ? '<b>Now</b> · ' : ''}${esc(fmtDay(h.time))} · <b>${esc(fmtTime(h.time))}</b></span>
      ${isNow ? '' : '<button class="btn" data-now type="button">Now</button>'}
      <button class="icon-btn" data-step="3" type="button" aria-label="3 hours later">${ico('i-chev-r')}</button>
    </div>
    <div class="surf-now">
      <span class="surf-range">${flat ? 'Flat' : esc(m ? m[1] : rng)}</span>${flat || !m ? '' : `<span class="surf-unit">${esc(m[2])}</span>`}
      <span class="surf-body">${esc(flat ? 'No surf to speak of' : bodyRange(h.min, h.max).replace(/^./, (c) => c.toUpperCase()))}</span>
    </div>
    <div class="rating" style="--rc:${rcVar(r)}">
      <div class="rating-bar" role="img" aria-label="Rating ${r} of 6">${[1, 2, 3, 4, 5, 6].map((k) => `<i style="${k <= r ? `background:${rcVar(r)}` : ''}"></i>`).join('')}</div>
      <span class="rating-label">${esc(h.ratingLabel || RATINGS[r]?.label || '')}</span>
    </div>
    <dl class="stats">
      <div class="stat"><dt>Wind</dt><dd>${dirArrow(w.dir)}${esc(fmtSpeed(w.speed, u))} <span class="wind-kind k-${esc(w.kind)}">${esc(KIND_LABEL[w.kind] || w.kind || '')}</span><small>${compass(w.dir)} · gusts ${esc(fmtSpeed(w.gust, u))}</small></dd></div>
      <div class="stat"><dt>Tide</dt><dd>${esc(fmtTide(h.tide, u))}${rising == null ? '' : `<span class="dim">${rising ? '↑' : '↓'}</span>`}<small>${rising == null ? 'no tide data' : rising ? 'rising' : 'falling'}${nextTide ? ` · ${nextTide.kind} ${esc(fmtTime(nextTide.time))}` : ''}</small></dd></div>
      <div class="stat"><dt>Water</dt><dd>${esc(fmtTemp(h.sst, u))}<small>air ${esc(fmtTemp(h.airTemp, u))}</small></dd></div>
      <div class="stat"><dt>Swell</dt><dd>${dp && dp.h > 0 ? `${dirArrow(dp.dir)}${esc(state.units.height === 'm' ? dp.h.toFixed(1) + ' m' : (dp.h * 3.28084).toFixed(1) + ' ft')}` : '–'}<small>${dp && dp.h > 0 ? `${Math.round(dp.t)} s ${compass(dp.dir)} ${Math.round(dp.dir)}°` : 'no swell'}</small></dd></div>
    </dl>`;
}

function partsHTML(i) {
  const h = state.spot.hourly[i], u = state.units;
  const ft = u.height !== 'm';
  const fh = (m) => (m > 0 ? (ft ? (m * 3.28084).toFixed(1) : m.toFixed(2)) : '–');
  const rows = (h.parts || []).map((p) => `<tr>
      <td>${esc(PART_LABEL[p.kind] || p.kind)}</td>
      <td class="num">${fh(p.h)}</td>
      <td class="num">${p.t > 0 ? `${p.t.toFixed(1)} s` : '–'}</td>
      <td>${p.h > 0 ? `<span class="dir">${dirArrow(p.dir)}${compass(p.dir)} <span class="dim">${Math.round(p.dir)}°</span></span>` : '–'}</td>
      <td class="num opt">${p.h > 0 && Number.isFinite(p.kd) ? `×${p.kd.toFixed(2)}` : '–'}</td>
      <td class="num opt">${fh(p.h0)}</td>
      <td class="num">${fh(p.hb)}</td></tr>`).join('');
  return `<table class="parts"><caption class="sr-only">Swell components for the selected hour, heights in ${ft ? 'feet' : 'metres'}</caption>
    <thead><tr><th scope="col">Component</th><th class="num" scope="col">Offshore</th><th class="num" scope="col">Period</th><th scope="col">From</th><th class="num opt" scope="col" title="Refraction / exposure coefficient">K<sub>d</sub></th><th class="num opt" scope="col">At break</th><th class="num" scope="col">Breaking</th></tr></thead>
    <tbody>${rows}<tr class="tot"><td>Combined</td><td></td><td></td><td></td><td class="opt"></td><td class="opt"></td><td class="num">${fh(h.hb)} ${ft ? 'ft' : 'm'}</td></tr></tbody></table>`;
}

function setHour(i, { fromChart = false, initial = false } = {}) {
  const S = state.spot;
  if (!S) return;
  i = Math.max(0, Math.min(S.hourly.length - 1, i | 0));
  const dayChanged = initial || S.hourly[i].time.slice(0, 10) !== S.hourly[S.i].time.slice(0, 10);
  S.i = i;
  const h = S.hourly[i];

  const hero = $('#hero');
  hero.style.setProperty('--hero-tint', rcVar(h.rating));
  hero.innerHTML = heroHTML(i);
  hero.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    setHour(S.i + +b.dataset.step); S.charts.fc?.select?.(S.i);
    hero.querySelector(`[data-step="${b.dataset.step}"]`)?.focus();
  }));
  hero.querySelector('[data-now]')?.addEventListener('click', () => { setHour(S.nowI); S.charts.fc?.select?.(S.i); hero.querySelector('[data-step="3"]')?.focus(); });

  $('#parts').innerHTML = partsHTML(i);
  $('#parts-when').textContent = `${fmtDay(h.time)} ${fmtTime(h.time)}`;

  if ($('#polar')) { try { swellPolar($('#polar'), S.site, h.parts || []); } catch (err) { chartError('#polar', err); } }

  // tide for the selected day
  const date = h.time.slice(0, 10);
  if (dayChanged || !S.charts.tide) {
    const i0 = S.hourly.findIndex((x) => x.time.slice(0, 10) === date);
    const i1 = Math.min(S.hourly.length - 1, i0 + 24);
    $('#tide-when').textContent = fmtDay(date);
    try { S.charts.tide = tideChart($('#tide'), S.fc, i0, i1, state.units, i); } catch (err) { chartError('#tide', err); }
  } else S.charts.tide?.select?.(i);

  if (S.scene && dominantPart(h)) {
    const p = dominantPart(h);
    S.scene.setSwell({ dir: p.dir, t: p.t, h: p.h0 || p.h, hb: h.hb });
  }
  if (!initial && !fromChart) announce(`${fmtDay(h.time)} ${fmtTime(h.time)}: ${fmtRange(h.min, h.max, state.units)}, ${h.ratingLabel}`);
}

function initScene() {
  const S = state.spot;
  const wrap = $('#scene-wrap'), status = $('#scene-status'), canvas = $('#scene'), ecoBtn = $('#eco');
  ecoBtn.addEventListener('click', () => {
    state.eco = !state.eco; store.set('eco', state.eco);
    ecoBtn.setAttribute('aria-pressed', state.eco);
    S.scene?.setEco(state.eco);
    announce(state.eco ? 'Eco mode on: still frame' : 'Eco mode off: animated');
  });
  lazy(wrap, async () => {
    const seq = routeSeq;
    status.textContent = 'Loading the seafloor…';
    try {
      const [{ createScene }, data] = await Promise.all([import('./scene3d.js'), geo.sceneData(S.spot.lat, S.spot.lon)]);
      if (seq !== routeSeq) return;
      const scene = createScene(canvas, data, { dark: isDark(), eco: state.eco, hb: S.hourly[S.i].hb });
      if (!scene) { status.textContent = 'The 3D view needs WebGL2, which this browser doesn’t offer. Everything else works without it.'; return; }
      status.remove();
      S.scene = scene;
      scene.setEco(state.eco);
      const p = dominantPart(S.hourly[S.i]);
      if (p) scene.setSwell({ dir: p.dir, t: p.t, h: p.h0 || p.h, hb: S.hourly[S.i].hb });
      const onTheme = (e) => scene.setTheme?.(e.detail);
      document.addEventListener('glassy:theme', onTheme);
      onLeave(() => { document.removeEventListener('glassy:theme', onTheme); scene.dispose(); });
    } catch (err) {
      if (seq !== routeSeq) return;
      console.warn('scene', err);
      status.textContent = `3D view unavailable: ${err?.message || err}`;
    }
  }, '150px');
}

// ---------------------------------------------------------------- service worker
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => console.warn('SW', e));
  });
}

// ---------------------------------------------------------------- boot
document.documentElement.dataset.version = APP_VERSION;
applyTheme();
initUnits();
initSearch();
initMeter();
addEventListener('hashchange', route);
route();
registerSW();
