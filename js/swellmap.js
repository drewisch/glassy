// Glassy — animated swell crest lines for the home map.
// The current offshore swell at the view centre (Open-Meteo) is carried over the real
// seafloor (AWS terrarium bathymetry): the eikonal |∇τ| = 1/c(depth, T) is solved by fast
// sweeping on a ~4 px screen grid (as in scene3d.js), with τ in deep-water pixels, and the
// crests are its level sets τ = (n + phase)·spacing. They bunch up and bend over the shelf
// and wrap behind islands; a straight-line visibility field, softened across the travel
// direction (≈ directional spreading), fades them in island and headland shadows.
// Drawn with marching squares on a canvas in its own map pane; the phase drifts slowly
// toward shore unless eco mode or reduced motion asks for a still frame.

import { currentSwellAt } from './api.js';
import { addBytes } from './net.js';
import { browserFetchTile } from './terrain.js';
import { fmtHeight, compass } from './report.js';

const CS = 4;          // grid cell (CSS px)
const PAD = 10;        // cells beyond the view on each side, so short pans show no gap
const SMAX = 3;        // cap on k/k0 (slowness): crests stay >= ~6 px apart in the shallows
const DRIFT_MS = 2500; // time for crests to drift one spacing
const FPS = 24;
const MIN_ZOOM = 6, MAX_ZOOM = 14; // terrarium has no seabed above z10, so z14 is ~16 px/sample
const NB = 5;          // opacity buckets (one Path2D each)
const INF = 1e30;
const G = 9.81;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---- bathymetry tiles, shared by all maps (small LRU of decoded Float32Arrays) ----
const fetchTile = browserFetchTile(addBytes);
const tileCache = new Map();
function tile(z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  x = ((x % n) + n) % n;
  const k = `${z}/${x}/${y}`;
  let p = tileCache.get(k);
  if (p) tileCache.delete(k); // re-insert as most recent
  else p = fetchTile(z, x, y).catch(() => { tileCache.delete(k); return null; });
  tileCache.set(k, p);
  if (tileCache.size > 36) tileCache.delete(tileCache.keys().next().value);
  return p;
}

/** Depth (m; <= 0 on land) at grid node (i,j) = world pixel o + (i,j)·CS at map zoom z. */
async function depthGrid(o, z, nx, ny) {
  const zt = clamp(Math.round(z) - 2, 5, 10), f = 2 ** (zt - z), s = CS * f;
  const X0 = o.x * f - 0.5, Y0 = o.y * f - 0.5; // terrarium pixel centres sit at +0.5
  const tx0 = Math.floor(X0 / 256), ty0 = Math.floor(Y0 / 256);
  const ntx = Math.floor((X0 + (nx - 1) * s + 1) / 256) - tx0 + 1;
  const nty = Math.floor((Y0 + (ny - 1) * s + 1) / 256) - ty0 + 1;
  if (ntx * nty > 30) return null;
  const jobs = [];
  for (let j = 0; j < nty; j++) for (let i = 0; i < ntx; i++) jobs.push(tile(zt, tx0 + i, ty0 + j));
  const T = await Promise.all(jobs);
  const at = (X, Y) => { const t = T[((Y >> 8) - ty0) * ntx + (X >> 8) - tx0]; return t ? t[(Y & 255) * 256 + (X & 255)] : 1; };
  const d = new Float32Array(nx * ny);
  for (let j = 0, id = 0; j < ny; j++) {
    const fy = Y0 + j * s, Y = Math.floor(fy), ay = fy - Y;
    for (let i = 0; i < nx; i++, id++) {
      const fx = X0 + i * s, X = Math.floor(fx), ax = fx - X;
      const a = at(X, Y) * (1 - ax) + at(X + 1, Y) * ax, b = at(X, Y + 1) * (1 - ax) + at(X + 1, Y + 1) * ax;
      d[id] = -(a + (b - a) * ay);
    }
  }
  return d;
}

/** 1-D box blur of an nx*ny field along x or y (edges clamped). */
function blur1(src, nx, ny, r, alongX) {
  const out = new Float32Array(src.length), n = alongX ? nx : ny, m = alongX ? ny : nx;
  const st = alongX ? 1 : nx, ls = alongX ? nx : 1, w = 2 * r + 1;
  for (let k = 0; k < m; k++) {
    const o = k * ls;
    let acc = 0;
    for (let t = -r; t <= r; t++) acc += src[o + clamp(t, 0, n - 1) * st];
    for (let t = 0; t < n; t++) {
      out[o + t * st] = acc / w;
      acc += src[o + Math.min(n - 1, t + r + 1) * st] - src[o + Math.max(0, t - r) * st];
    }
  }
  return out;
}

/** Phase (τ/spacing) and crest opacity for one swell {h, t, dir} over the depth grid. */
function solveSwell(d, nx, ny, o, sw) {
  const N = nx * ny, T = clamp(sw.t || 10, 4, 25), w = (2 * Math.PI) / T, k0 = (w * w) / G;
  const sp = 16 + 6 * clamp((T - 6) / 12, 0, 1); // deep-water crest spacing (px): longer period, wider
  // slowness per cell, k/k0 from Fenton–McKee's explicit dispersion relation; 0 = land
  const F = new Float32Array(N), tau = new Float64Array(N).fill(INF), fixed = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (d[i] > 0) F[i] = CS * Math.min(SMAX, Math.tanh((k0 * Math.max(d[i], 1)) ** 0.75) ** (-2 / 3));
  // plane wave on the water cells of the edges facing the swell (screen y points south)
  const r = (sw.dir * Math.PI) / 180, px = -Math.sin(r), py = Math.cos(r);
  const off = (((o.x * px + o.y * py) % sp) + sp) % sp; // pins deep-water crests to the map across pans
  let seeded = 0;
  const seed = (i, j) => { const id = j * nx + i; if (F[id] && !fixed[id]) { tau[id] = off + (px * i + py * j) * CS; fixed[id] = 1; seeded++; } };
  for (const lim of [0.1, -0.5]) { // side edges only if the facing ones are all land
    if (seeded) break;
    for (let j = 0; j < ny; j++) { if (px > lim) seed(0, j); if (-px > lim) seed(nx - 1, j); }
    for (let i = 0; i < nx; i++) { if (py > lim) seed(i, 0); if (-py > lim) seed(i, ny - 1); }
  }
  if (!seeded) return null;
  // fast sweeping (Godunov upwind), land cells are obstacles
  for (let it = 0; it < 5; it++) {
    let changed = 0;
    for (let sw4 = 0; sw4 < 4; sw4++) {
      const rx = sw4 & 1, ry = sw4 >> 1;
      for (let jj = 0; jj < ny; jj++) {
        const j = ry ? ny - 1 - jj : jj;
        for (let ii = 0; ii < nx; ii++) {
          const i = rx ? nx - 1 - ii : ii, id = j * nx + i, f = F[id];
          if (!f || fixed[id]) continue;
          const a0 = Math.min(i > 0 ? tau[id - 1] : INF, i < nx - 1 ? tau[id + 1] : INF);
          const b0 = Math.min(j > 0 ? tau[id - nx] : INF, j < ny - 1 ? tau[id + nx] : INF);
          const a = Math.min(a0, b0), b = Math.max(a0, b0);
          if (a >= INF) continue;
          const v = b - a >= f ? a + f : (a + b + Math.sqrt(2 * f * f - (b - a) * (b - a))) / 2;
          if (v < tau[id] - 1e-4) { tau[id] = v; changed++; }
        }
      }
    }
    if (!changed) break;
  }
  // straight-line visibility: lit if the path back upwind to the grid edge stays in water
  const V = new Float32Array(N), wet = new Float32Array(N);
  for (let i = 0; i < N; i++) wet[i] = F[i] ? 1 : 0;
  const byX = Math.abs(px) >= Math.abs(py), M = byX ? nx : ny, Q = byX ? ny : nx;
  const pm = byX ? px : py, sm = pm >= 0 ? 1 : -1, slope = (byX ? py : px) / Math.abs(pm || 1);
  const idx = byX ? (m, q) => q * nx + m : (m, q) => m * nx + q;
  for (let mm = 0; mm < M; mm++) {
    const m = sm > 0 ? mm : M - 1 - mm;
    for (let q = 0; q < Q; q++) {
      const id = idx(m, q);
      if (!wet[id]) continue;
      if (!mm) { V[id] = 1; continue; }
      const fq = q - slope, q0 = Math.floor(fq), t = fq - q0;
      const v0 = q0 < 0 || q0 >= Q ? 1 : V[idx(m - sm, q0)], v1 = q0 + 1 < 0 || q0 + 1 >= Q ? 1 : V[idx(m - sm, q0 + 1)];
      V[id] = v0 + (v1 - v0) * t;
    }
  }
  // soften across the travel direction (normalised so land doesn't count), fade at the shore
  let bv = V, bw = wet;
  for (let p = 0; p < 2; p++) { bv = blur1(bv, nx, ny, 5, !byX); bw = blur1(bw, nx, ny, 5, !byX); }
  const shore = blur1(blur1(wet, nx, ny, 2, true), nx, ny, 2, false); // water fraction in 5x5
  const E = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (wet[i]) E[i] = (0.15 + 0.85 * clamp(bv[i] / Math.max(bw[i], 1e-3), 0, 1)) * clamp((shore[i] - 0.62) / 0.38, 0, 1);
  }
  // marching-squares cells that can carry a crest, with their phase range and opacity bucket
  const u = new Float32Array(N), q = [], bk = [], lo = [], hi = [];
  for (let i = 0; i < N; i++) u[i] = tau[i] / sp;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx + 1, e = a + nx;
    if (tau[a] >= INF || tau[b] >= INF || tau[c] >= INF || tau[e] >= INF) continue;
    const k = Math.round(((E[a] + E[b] + E[c] + E[e]) / 4) * NB);
    if (!k) continue;
    q.push(a); bk.push(k);
    lo.push(Math.min(u[a], u[b], u[c], u[e])); hi.push(Math.max(u[a], u[b], u[c], u[e]));
  }
  return { nx, u, q: Int32Array.from(q), bk: Uint8Array.from(bk), lo: Float32Array.from(lo), hi: Float32Array.from(hi) };
}

const pts = new Float32Array(8);
/** Stroke the level sets u = n + ph of one field. */
function strokeField(ctx, f, ph, color, width, alpha) {
  const paths = [];
  for (let b = 1; b <= NB; b++) paths[b] = new Path2D();
  const { nx, u, q, bk, lo, hi } = f;
  for (let k = 0; k < q.length; k++) {
    let n = Math.ceil(lo[k] - ph);
    const n1 = hi[k] - ph;
    if (n > n1) continue;
    const id = q[k], i = id % nx, x = i * CS, y = ((id - i) / nx) * CS, P = paths[bk[k]];
    const a = u[id], b = u[id + 1], c = u[id + nx + 1], e = u[id + nx];
    for (; n <= n1; n++) {
      const L = n + ph;
      let m = 0;
      if ((a < L) !== (b < L)) { pts[m++] = x + (CS * (L - a)) / (b - a); pts[m++] = y; }
      if ((b < L) !== (c < L)) { pts[m++] = x + CS; pts[m++] = y + (CS * (L - b)) / (c - b); }
      if ((e < L) !== (c < L)) { pts[m++] = x + (CS * (L - e)) / (c - e); pts[m++] = y + CS; }
      if ((a < L) !== (e < L)) { pts[m++] = x; pts[m++] = y + (CS * (L - a)) / (e - a); }
      for (let t = 0; t + 3 < m; t += 4) { P.moveTo(pts[t], pts[t + 1]); P.lineTo(pts[t + 2], pts[t + 3]); }
    }
  }
  ctx.strokeStyle = color; ctx.lineWidth = width;
  for (let b = 1; b <= NB; b++) { ctx.globalAlpha = (alpha * b) / NB; ctx.stroke(paths[b]); }
  ctx.globalAlpha = 1;
}

/**
 * Swell crest layer on a Leaflet map.
 * @param {{units?: Function|object, eco?: boolean}} opts  units: getter for the user's units
 * @returns {{setVisible(on), setEco(on), setTheme(dark), refresh(), remove()}}
 */
export function createSwellLayer(map, L, opts = {}) {
  const units = typeof opts.units === 'function' ? opts.units : () => opts.units;
  const box = map.getContainer();
  const pane = map.getPane('swell') || map.createPane('swell');
  Object.assign(pane.style, { zIndex: 380, pointerEvents: 'none' }); // above tiles, below labels and markers
  const cv = L.DomUtil.create('canvas', 'swell-canvas', pane), ctx = cv.getContext('2d');
  const legend = L.DomUtil.create('div', 'swell-legend', box);
  legend.hidden = true;
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  let on = false, eco = !!opts.eco, moving = false, onScreen = true, seq = 0, timer = 0, raf = 0, last = 0;
  let layers = [], colors = {}, dpr = 1;

  const animated = () => !eco && !rm.matches;
  const live = () => on && !moving && layers.length && onScreen && !document.hidden;
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    colors = { 1: cs.getPropertyValue('--crest').trim() || '#163f66', 2: cs.getPropertyValue('--crest-2').trim() || '#6a4f86' };
  }
  function render(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!layers.length) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = ctx.lineJoin = 'round';
    const ph = animated() ? (now / DRIFT_MS) % 1 : 0;
    for (const l of layers) strokeField(ctx, l.f, ph, colors[l.tint], l.width, l.alpha);
  }
  function loop(now) {
    raf = 0;
    if (!live() || !animated()) return;
    if (now - last >= 1000 / FPS - 3) { last = now; render(now); }
    raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf && live() && animated()) raf = requestAnimationFrame(loop); };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const redraw = () => { if (live()) { render(performance.now()); kick(); } };
  function setLegend(html) {
    legend.hidden = !html;
    if (html && legend.innerHTML !== html) legend.innerHTML = html;
  }
  function clear(msg = '') { layers = []; stop(); render(0); setLegend(msg && `<span>${msg}</span>`); }

  async function compute() {
    const my = ++seq;
    clearTimeout(timer);
    if (!on) return;
    const z = map.getZoom(), size = map.getSize();
    if (z < MIN_ZOOM || z > MAX_ZOOM) { clear(z < MIN_ZOOM ? 'Zoom in for swell lines' : 'Zoom out for swell lines'); return; }
    const nx = Math.ceil(size.x / CS) + 2 * PAD + 1, ny = Math.ceil(size.y / CS) + 2 * PAD + 1;
    const lp = map.containerPointToLayerPoint([-PAD * CS, -PAD * CS]), o = lp.add(map.getPixelOrigin());
    const c = map.getCenter().wrap();
    const [sw, d] = await Promise.all([
      currentSwellAt(c.lat, c.lng).catch(() => null),
      depthGrid(o, z, nx, ny).catch(() => null),
    ]);
    if (my !== seq || !on) return;
    if (!sw?.primary) { clear(sw ? 'No swell here right now' : 'Swell data unavailable'); return; }
    if (!d) { clear(); return; }
    const parts = [[sw.primary, 1]];
    if (sw.secondary && sw.secondary.h > 0.3) parts.push([sw.secondary, 2]);
    layers = parts.map(([s, tint]) => {
      const h = clamp(s.h, 0, 4), main = tint === 1;
      return { s, tint, f: solveSwell(d, nx, ny, o, s), width: (0.8 + 0.3 * h) * (main ? 1 : 0.8), alpha: Math.min(0.9, 0.38 + 0.14 * h) * (main ? 1 : 0.6) };
    }).filter((l) => l.f);
    const u = units();
    const row = (s, tint) => `<span class="s${tint}"><i aria-hidden="true"></i>${fmtHeight(s.h, u)} · ${Math.round(s.t)} s · ${compass(s.dir)} ${Math.round(s.dir)}°</span>`;
    setLegend(`<b>Swell now</b>${parts.map(([s, tint]) => row(s, tint)).join('')}`);
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = (nx - 1) * CS, h = (ny - 1) * CS;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    L.DomUtil.setPosition(cv, lp);
    cv.style.visibility = '';
    render(performance.now());
    kick();
  }
  const schedule = (ms = 250) => { clearTimeout(timer); if (on) timer = setTimeout(compute, ms); };

  const handlers = {
    movestart: () => { moving = true; seq++; clearTimeout(timer); stop(); }, // the still frame pans with the pane
    zoomstart: () => { cv.style.visibility = 'hidden'; },
    moveend: () => { moving = false; schedule(); },
    resize: () => schedule(),
  };
  map.on(handlers);
  const io = window.IntersectionObserver ? new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; redraw(); }) : null;
  io?.observe(box);
  const onVis = () => kick();
  document.addEventListener('visibilitychange', onVis);
  rm.addEventListener?.('change', redraw);
  readColors();

  return {
    setVisible(v) {
      on = !!v;
      if (on) compute();
      else { seq++; clearTimeout(timer); clear(); }
    },
    setEco(v) { eco = !!v; stop(); redraw(); },
    setTheme() { readColors(); redraw(); },
    refresh() { if (on) compute(); },
    remove() {
      on = false; seq++; clearTimeout(timer); stop();
      map.off(handlers); io?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      rm.removeEventListener?.('change', redraw);
      cv.remove(); legend.remove();
    },
  };
}
