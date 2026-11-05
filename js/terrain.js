// Glassy — terrain: terrarium tile math/decoding, elevation grids and the
// coastal wave-exposure analysis (coast snap, shore normal, spectral backward
// ray tracing). Pure computation; runs inside the geo worker but has no
// browser dependencies except the default decoder, so it can be tested in Node
// by injecting a `fetchTile(z, x, y) -> Float32Array(65536)` function.

export const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export const NEAR_Z = 12;
export const FAR_Z = 8;
export const PERIODS = [6, 8, 10, 12, 14, 16, 18, 20, 22];
const G = 9.81;
const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;
const EQ_CIRC = 40075016.686;
const NB = 180;           // 2° direction bins
const LAUNCH = 88;        // launch half-angle (deg)
const LAUNCH_STEP = 2;    // launch spacing (deg)
const MAX_DIST = 300e3;

// ---------------------------------------------------------------- tile math
export const lon2px = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
export const lat2py = (lat, z) => {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
};
export const px2lon = (px, z) => (px / (256 * 2 ** z)) * 360 - 180;
export const py2lat = (py, z) => {
  const n = Math.PI - (2 * Math.PI * py) / (256 * 2 ** z);
  return Math.atan(Math.sinh(n)) / DEG;
};
export const metresPerPixel = (lat, z) => (EQ_CIRC * Math.cos(lat * DEG)) / (256 * 2 ** z);

/** RGBA (or RGB with stride 3) bytes -> Float32Array metres. */
export function decodeTerrarium(bytes, stride = 4) {
  const n = (bytes.length / stride) | 0;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += stride) {
    out[i] = bytes[j] * 256 + bytes[j + 1] + bytes[j + 2] / 256 - 32768;
  }
  return out;
}

/** Browser/worker decoder: PNG Blob -> Float32Array(65536). */
export async function decodePngBlob(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close && bmp.close();
  return decodeTerrarium(img.data, 4);
}

/** Default worker tile fetcher. onBytes(n) is called with downloaded byte counts. */
export function browserFetchTile(onBytes) {
  return async (z, x, y) => {
    const r = await fetch(TILE_URL(z, x, y));
    if (!r.ok) throw new Error(`Terrain tile ${z}/${x}/${y}: HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (onBytes) onBytes(buf.byteLength);
    return decodePngBlob(new Blob([buf], { type: 'image/png' }));
  };
}

/** Tile cache wrapper around an injectable fetchTile(z,x,y) -> Float32Array(256*256). */
export function createTileSource(fetchTile) {
  const cache = new Map();
  return {
    tile(z, x, y) {
      const n = 2 ** z;
      x = ((x % n) + n) % n;
      if (y < 0 || y >= n) return Promise.resolve(null);
      const k = `${z}/${x}/${y}`;
      let p = cache.get(k);
      if (!p) {
        p = fetchTile(z, x, y).catch((e) => { cache.delete(k); throw e; });
        cache.set(k, p);
      }
      return p;
    },
  };
}

// ---------------------------------------------------------------- local frame
/** Local equirectangular metre frame (x east, y north) around lat0/lon0. */
export class Frame {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.my = R_EARTH * DEG;                       // metres per degree lat
    this.mx = R_EARTH * DEG * Math.cos(lat0 * DEG); // metres per degree lon
  }
  toLL(x, y) { return [this.lat0 + y / this.my, this.lon0 + x / this.mx]; }
  toXY(lat, lon) { return [(lon - this.lon0) * this.mx, (lat - this.lat0) * this.my]; }
}

// ---------------------------------------------------------------- grid
/** 3x3 (nt x nt) mosaic of tiles at zoom z with bilinear sampling. */
export class Grid {
  constructor(z, tx0, ty0, nt, data) {
    this.z = z; this.tx0 = tx0; this.ty0 = ty0; this.nt = nt;
    this.w = this.h = nt * 256;
    this.data = data;
    this.scale = 256 * 2 ** z;
    this.ox = tx0 * 256; this.oy = ty0 * 256;
  }
  // grid pixel coords (pixel centres at integer + 0.5)
  gx(lon) { return ((lon + 180) / 360) * this.scale - this.ox; }
  gy(lat) {
    const s = Math.sin(lat * DEG);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * this.scale - this.oy;
  }
  lonAt(gx) { return ((gx + this.ox) / this.scale) * 360 - 180; }
  latAt(gy) { return py2lat(gy + this.oy, this.z); }
  mpp(lat) { return metresPerPixel(lat, this.z); }
  /** fractional pixel sample (fx,fy measured so that pixel i centre is at i). NaN outside. */
  samplePx(fx, fy) {
    const w = this.w;
    if (!(fx >= 0 && fy >= 0 && fx <= w - 1 && fy <= this.h - 1)) return NaN;
    let ix = fx | 0, iy = fy | 0;
    if (ix >= w - 1) ix = w - 2;
    if (iy >= this.h - 1) iy = this.h - 2;
    const ax = fx - ix, ay = fy - iy, d = this.data, i = iy * w + ix;
    const a = d[i] + (d[i + 1] - d[i]) * ax;
    const b = d[i + w] + (d[i + w + 1] - d[i + w]) * ax;
    return a + (b - a) * ay;
  }
  sample(lat, lon) { return this.samplePx(this.gx(lon) - 0.5, this.gy(lat) - 0.5); }
  /** true if lat/lon lies at least `margin` pixels inside the grid */
  inside(lat, lon, margin = 1) {
    const x = this.gx(lon), y = this.gy(lat);
    return x >= margin && y >= margin && x <= this.w - margin && y <= this.h - margin;
  }
  at(ix, iy) { return this.data[iy * this.w + ix]; }
  pxLL(ix, iy) { return [this.latAt(iy + 0.5), this.lonAt(ix + 0.5)]; }
  /** Box-blurred copy; values above `clampMax` are clamped first (e.g. 0 = land as zero depth). */
  blurred(radius, passes = 2, clampMax = Infinity) {
    const w = this.w, h = this.h;
    let src = Float32Array.from(this.data);
    if (clampMax !== Infinity) for (let i = 0; i < src.length; i++) if (src[i] > clampMax) src[i] = clampMax;
    let tmp = new Float32Array(w * h);
    const r = Math.max(1, radius | 0), n = 2 * r + 1;
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {           // horizontal
        const row = y * w;
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
        for (let x = 0; x < w; x++) {
          tmp[row + x] = acc / n;
          acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {           // vertical
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
        for (let y = 0; y < h; y++) {
          src[y * w + x] = acc / n;
          acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
      }
    }
    return new Grid(this.z, this.tx0, this.ty0, this.nt, src);
  }
}

/** Build an nt x nt tile grid at zoom z centred on the tile containing lat/lon. */
export async function buildGrid(src, z, lat, lon, nt = 3) {
  const tx = Math.floor(lon2px(lon, z) / 256), ty = Math.floor(lat2py(lat, z) / 256);
  const h = (nt - 1) >> 1;
  const tx0 = tx - h, ty0 = ty - h;
  const jobs = [];
  for (let j = 0; j < nt; j++) for (let i = 0; i < nt; i++) jobs.push(src.tile(z, tx0 + i, ty0 + j));
  const tiles = await Promise.all(jobs);
  const W = nt * 256, data = new Float32Array(W * W);
  tiles.forEach((t, k) => {
    const i = k % nt, j = (k / nt) | 0;
    for (let r = 0; r < 256; r++) {
      const o = (j * 256 + r) * W + i * 256;
      if (t) data.set(t.subarray(r * 256, r * 256 + 256), o);
      else data.fill(NaN, o, o + 256);
    }
  });
  return new Grid(z, tx0, ty0, nt, data);
}

export const MID_Z = 10;
/**
 * Merged near field on the z12 lattice. Terrarium z11+ usually has no bathymetry
 * (sea written as exactly 0 m), so: keep z12 where |e| > 0.5 (land detail, or real
 * bathymetry e.g. Hawaii); where z12 is ~0 use bilinear z10, and if that is also ~0
 * use z8. A ~0 cell whose coarser value is not negative (coastal smearing of coarse
 * tiles) becomes very shallow water (-0.5 m) unless the coarse value is clearly land.
 * Returns {grid, srcZoom: Uint8Array} (zoom that supplied each cell).
 */
export async function buildMergedNear(src, lat, lon, far) {
  const [n12, n10, f8] = await Promise.all([
    buildGrid(src, NEAR_Z, lat, lon), buildGrid(src, MID_Z, lat, lon),
    far ? Promise.resolve(far) : buildGrid(src, FAR_Z, lat, lon),
  ]);
  const W = n12.w, H = n12.h, d12 = n12.data;
  const data = new Float32Array(W * H), zs = new Uint8Array(W * H);
  const gx10 = new Float64Array(W), gx8 = new Float64Array(W);
  for (let ix = 0; ix < W; ix++) {
    const lon_ = n12.lonAt(ix + 0.5);
    gx10[ix] = n10.gx(lon_) - 0.5; gx8[ix] = f8.gx(lon_) - 0.5;
  }
  for (let iy = 0; iy < H; iy++) {
    const lat_ = n12.latAt(iy + 0.5);
    const gy10 = n10.gy(lat_) - 0.5, gy8 = f8.gy(lat_) - 0.5;
    for (let ix = 0; ix < W; ix++) {
      const i = iy * W + ix, e = d12[i];
      if (e > 3) { data[i] = e; zs[i] = NEAR_Z; continue; }            // clear land
      let c = n10.samplePx(gx10[ix], gy10), z = MID_Z;
      if (!(c >= 0.5 || c <= -0.5)) { c = f8.samplePx(gx8[ix], gy8); z = FAR_Z; }
      // z12 "flat zero" ocean wobbles by about ±2 m near coasts: inside that band
      // trust coarse bathymetry when it says deeper water.
      const ambiguous = e >= -3 && c < -0.5 && c < e;
      // real z12 bathymetry, unless it is a spike far deeper than the coarse level
      if (!ambiguous && e < -0.5 && !(e < 3 * Math.min(c, 0) - 20)) { data[i] = e; zs[i] = NEAR_Z; continue; }
      if (c < -0.5) data[i] = c;
      else if (c > 10 || e > 0.5) { data[i] = e > 0 ? e : 0; z = NEAR_Z; }
      else data[i] = -0.5;
      zs[i] = z;
    }
  }
  despike(data, W, H, 50);
  return { grid: new Grid(NEAR_Z, n12.tx0, n12.ty0, n12.nt, data), srcZoom: zs, far: f8 };
}

/** Replace pixels sticking out >thr beyond all 8 neighbours by the 3x3 median (2 passes). */
export function despike(d, W, H, thr = 50) {
  const nb = new Float32Array(9);
  for (let pass = 0; pass < 2; pass++) {
    let fixed = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, v = d[i];
        let mn = Infinity, mx = -Infinity, k = 0;
        for (let dy = -W; dy <= W; dy += W) {
          for (let dx = -1; dx <= 1; dx++) {
            const u = d[i + dy + dx];
            nb[k++] = u;
            if (dx || dy) { if (u < mn) mn = u; if (u > mx) mx = u; }
          }
        }
        if (v < mn - thr || v > mx + thr) {
          nb.sort();
          d[i] = nb[4];
          fixed++;
        }
      }
    }
    if (!fixed) break;
  }
}

// ---------------------------------------------------------------- physics
/** Guo (2002) explicit dispersion: phase speed c (m/s) for depth h, period T. */
export function phaseSpeed(h, T) {
  const w = (2 * Math.PI) / T;
  if (!(h > 0.05)) h = 0.05;
  const x = w * Math.sqrt(h / G);
  const kh = (x * x) / Math.pow(1 - Math.exp(-Math.pow(x, 2.4908)), 1 / 2.4908);
  return (w * h) / kh;
}
/** Ray curvature dθ/ds (math angle, rad/m); bends toward lower c. */
export const rayTurn = (th, c, cx, cy) => (Math.sin(th) * cx - Math.cos(th) * cy) / c;

/** Directional spreading exponent s(T): ~6 at 6 s rising to ~60 at 20 s+. */
export function spreadS(T) {
  const tab = [[6, 6], [8, 10], [10, 15], [12, 22], [14, 30], [16, 40], [18, 50], [20, 60]];
  if (T <= 6) return 6;
  if (T >= 20) return 60;
  for (let i = 1; i < tab.length; i++) {
    if (T <= tab[i][0]) {
      const [t0, s0] = tab[i - 1], [t1, s1] = tab[i];
      return s0 + ((s1 - s0) * (T - t0)) / (t1 - t0);
    }
  }
  return 60;
}
/** Normalised cos^(2s)(Δ/2) table over 0..180° at 0.5° resolution (∫ over 2π = 1, rad⁻¹). */
function spreadTable(s) {
  const n = 361, t = new Float32Array(n);
  let norm = 0;
  const M = 3600;
  for (let k = 0; k < M; k++) {
    const d = -Math.PI + ((k + 0.5) * 2 * Math.PI) / M;
    norm += Math.pow(Math.cos(d / 2), 2 * s);
  }
  norm *= (2 * Math.PI) / M;
  for (let i = 0; i < n; i++) t[i] = Math.pow(Math.cos((i * 0.5 * DEG) / 2), 2 * s) / norm;
  return t;
}
const spreadLookup = (tab, dDeg) => {
  let d = Math.abs(((dDeg % 360) + 540) % 360 - 180);
  return tab[Math.round(d * 2)];
};

const compassToMath = (c) => (90 - c) * DEG;
const mathToCompass = (m) => (((90 - m / DEG) % 360) + 360) % 360;

// ---------------------------------------------------------------- terrain context
/** Combined near/far sampling in a local metre frame. */
class Terrain {
  constructor(near, nearS, far, frame) {
    this.near = near; this.nearS = nearS; this.far = far; this.f = frame;
    const lat = frame.lat0;
    this.nearMpp = near ? near.mpp(lat) : Infinity;
    this.farMpp = far.mpp(lat);
  }
  _ll(x, y) { const f = this.f; return [f.lat0 + y / f.my, f.lon0 + x / f.mx]; }
  /** raw elevation; near grid when inside it, else far; NaN outside far */
  elev(x, y) {
    const [lat, lon] = this._ll(x, y);
    if (this.near) {
      const v = this.near.sample(lat, lon);
      if (v === v) return v;
    }
    return this.far.sample(lat, lon);
  }
  farElev(x, y) { const [lat, lon] = this._ll(x, y); return this.far.sample(lat, lon); }
  /** 0 = in smoothed near grid (with margin), 1 = far grid, -1 = outside */
  which(x, y) {
    const [lat, lon] = this._ll(x, y);
    if (this.nearS && this.nearS.inside(lat, lon, 8)) return 0;
    if (this.far.inside(lat, lon, 2)) return 1;
    return -1;
  }
}

// ---------------------------------------------------------------- locate
/** Coast snap, shore normal, surf point. Returns plain object (no typed arrays). */
export async function locate(src, lat, lon) {
  const far = await buildGrid(src, FAR_Z, lat, lon);
  const merged = await buildMergedNear(src, lat, lon, far);
  const near = merged.grid;
  const mpp = near.mpp(lat);

  // --- coast snap: nearest water pixel adjacent to land within 5 km
  const cx = Math.floor(near.gx(lon)), cy = Math.floor(near.gy(lat));
  const rad = Math.ceil(5000 / mpp);
  let best = -1, bd = Infinity;
  const W = near.w, H = near.h, d = near.data;
  for (let y = Math.max(1, cy - rad); y <= Math.min(H - 2, cy + rad); y++) {
    for (let x = Math.max(1, cx - rad); x <= Math.min(W - 2, cx + rad); x++) {
      const dd = (x - cx) ** 2 + (y - cy) ** 2;
      if (dd > rad * rad || dd >= bd) continue;
      const i = y * W + x;
      if (!(d[i] < 0)) continue;
      if (d[i - 1] >= 0 || d[i + 1] >= 0 || d[i - W] >= 0 || d[i + W] >= 0 ||
          d[i - W - 1] >= 0 || d[i - W + 1] >= 0 || d[i + W - 1] >= 0 || d[i + W + 1] >= 0) {
        bd = dd; best = i;
      }
    }
  }
  if (best < 0) throw new Error('No ocean found nearby');
  const bx = best % W, by = (best / W) | 0;
  const [clat, clon] = near.pxLL(bx, by);

  // --- seaward normal: negate sum of unit vectors to land pixels within 2 km
  const r2 = Math.ceil(2000 / mpp);
  let sx = 0, sy = 0;
  for (let y = Math.max(0, by - r2); y <= Math.min(H - 1, by + r2); y++) {
    for (let x = Math.max(0, bx - r2); x <= Math.min(W - 1, bx + r2); x++) {
      const dx = x - bx, dy = by - y; // east, north (pixels)
      const dd = dx * dx + dy * dy;
      if (dd === 0 || dd > r2 * r2) continue;
      if (d[y * W + x] >= 0) { const l = Math.sqrt(dd); sx += dx / l; sy += dy / l; }
    }
  }
  if (sx === 0 && sy === 0) sy = -1;
  const normal = (Math.atan2(-sx, -sy) / DEG + 360) % 360; // compass
  const nth = compassToMath(normal);
  const ux = Math.cos(nth), uy = Math.sin(nth);

  // --- surf point: march seaward until depth >= 8 m (max 3 km; fallback 1 km)
  const cf = new Frame(clat, clon);
  const terr = new Terrain(near, null, far, cf);
  let sd = -1, sDepth = 0;
  for (let s = 10; s <= 3000; s += 10) {
    const e = terr.elev(ux * s, uy * s);
    if (e === e && -e >= 8) { sd = s; sDepth = -e; break; }
  }
  const surfFallback = sd < 0;
  if (sd < 0) {
    sd = 1000;
    const e = terr.elev(ux * sd, uy * sd);
    sDepth = e === e ? Math.max(1, -e) : 1;
  }
  const [slat, slon] = cf.toLL(ux * sd, uy * sd);
  let bathyZoom = FAR_Z;
  {
    const ix = Math.floor(near.gx(slon)), iy = Math.floor(near.gy(slat));
    if (ix >= 0 && iy >= 0 && ix < W && iy < H) bathyZoom = merged.srcZoom[iy * W + ix];
  }

  // --- profile: 120 samples from -500 m to 4000 m along normal
  const profile = [];
  const NP = 120;
  for (let k = 0; k < NP; k++) {
    const s = -500 + (4500 * k) / (NP - 1);
    const e = terr.elev(ux * s, uy * s);
    profile.push({ d: Math.round(s * 10) / 10, z: e === e ? Math.round(e * 10) / 10 : null });
  }
  const slope = sDepth / Math.max(sd, 1);

  return {
    near, far,
    input: { lat, lon },
    coast: { lat: clat, lon: clon },
    surf: { lat: slat, lon: slon, depth: Math.round(sDepth * 10) / 10 },
    surfDist: sd,
    bathyZoom,
    surfFallback,
    snapDistM: Math.round(Math.sqrt(bd) * mpp),
    normal: Math.round(normal * 10) / 10,
    slope, profile,
  };
}

// ---------------------------------------------------------------- straight casts
/** Straight cast from local origin in compass direction; true if land is hit within maxD. */
function castBlocked(terr, compass, startD, maxD, useNear) {
  const th = compassToMath(compass), ux = Math.cos(th), uy = Math.sin(th);
  let s = startD;
  const nearStep = Math.min(100, terr.nearMpp * 2);
  const farStep = Math.max(200, terr.farMpp * 0.6);
  while (s <= maxD) {
    const x = ux * s, y = uy * s;
    const e = useNear ? terr.elev(x, y) : terr.farElev(x, y);
    if (e !== e) return false;            // left the far grid -> open
    if (e >= 0) return true;
    const inNear = useNear && terr.which(x, y) === 0;
    s += inNear ? nearStep : farStep;
  }
  return false;
}

/** Openness (0..1) per 2° from-direction bin around a deep-water point. */
export async function referenceExposure(src, lat, lon) {
  const far = await buildGrid(src, FAR_Z, lat, lon);
  const terr = new Terrain(null, null, far, new Frame(lat, lon));
  const raw = new Float32Array(NB);
  for (let i = 0; i < NB; i++) raw[i] = castBlocked(terr, i * 2, 1000, MAX_DIST, false) ? 0 : 1;
  const out = new Float32Array(NB);
  for (let i = 0; i < NB; i++) {
    out[i] = 0.25 * raw[(i + NB - 1) % NB] + 0.5 * raw[i] + 0.25 * raw[(i + 1) % NB];
  }
  return out;
}

// ---------------------------------------------------------------- ray tracing
/**
 * Trace one backward ray from the local origin (surf point).
 * Returns {open, dir (compass from-direction offshore), pts?}.
 */
function traceRay(terr, T, compass0, keepPts) {
  const L0 = (G * T * T) / (2 * Math.PI), hDeep = L0 / 2;
  let th = compassToMath(compass0);
  let x = 0, y = 0, s = 0;
  const pts = keepPts ? [[0, 0]] : null;
  const nS = terr.nearS, f = terr.f;
  const dN = terr.nearMpp, dF = terr.farMpp;
  let deep = false, open = false;
  let k = 0;
  const N = terr.near, F = terr.far, NW = N.w - 8, FW = F.w - 2;
  const cT = cTable(T, hDeep);
  for (;;) {
    let ds;
    const lat = f.lat0 + y / f.my, lon = f.lon0 + x / f.mx;
    // one projection per step; near raw & smoothed grids share the same lattice
    const gyN = N.gy(lat), gxN = N.gx(lon);
    const inNear = gxN >= 8 && gyN >= 8 && gxN <= NW && gyN <= NW;
    let gx, gy, G_;
    if (inNear) { gx = gxN - 0.5; gy = gyN - 0.5; G_ = N; }
    else {
      const fx = F.gx(lon), fy = F.gy(lat);
      if (!(fx >= 2 && fy >= 2 && fx <= FW && fy <= FW)) { open = true; break; }
      gx = fx - 0.5; gy = fy - 0.5; G_ = F;
    }
    const e = G_.samplePx(gx, gy);
    if (e !== e) { open = true; break; }
    if (!deep) {
      if (e > -1) break; // land / very shallow -> blocked
      const S = inNear ? nS : F, dd = inNear ? dN : dF;
      ds = inNear ? 25 : 250;
      const h0 = -S.samplePx(gx, gy);
      if (h0 > hDeep) { deep = true; continue; }
      const cx = (cT(-S.samplePx(gx + 1, gy)) - cT(-S.samplePx(gx - 1, gy))) / (2 * dd);
      const cy = (cT(-S.samplePx(gx, gy - 1)) - cT(-S.samplePx(gx, gy + 1))) / (2 * dd); // -gy = north
      if (cx === cx && cy === cy) th += rayTurn(th, cT(h0), cx, cy) * ds;
    } else {
      ds = inNear ? 50 : 300;
      if (e >= 0) break; // island / headland shadow
    }
    x += Math.cos(th) * ds; y += Math.sin(th) * ds; s += ds;
    if (pts && (++k % (deep ? 4 : 2) === 0)) pts.push([x, y]);
    if (s > MAX_DIST) { open = true; break; }
  }
  if (pts) pts.push([x, y]);
  return { open, dir: mathToCompass(th), pts };
}

/** Tabulated c(h) for period T, 0.1 m resolution up to hMax (deep value beyond). */
const cTables = new Map();
function cTable(T, hMax) {
  let fn = cTables.get(T);
  if (fn) return fn;
  const n = Math.ceil(hMax * 10) + 2, tab = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) tab[i] = phaseSpeed(i / 10, T);
  const cDeep = phaseSpeed(1e4, T);
  fn = (h) => {
    if (h !== h) return NaN;
    if (h <= 0.05) return tab[0];
    const u = h * 10;
    if (u >= n) return u > n * 4 ? cDeep : phaseSpeed(h, T);
    const i = u | 0, a = u - i;
    return tab[i] + (tab[i + 1] - tab[i]) * a;
  };
  cTables.set(T, fn);
  return fn;
}

function decimate(pts, max) {
  if (pts.length <= max) return pts;
  const out = [], step = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

/** Full site analysis (Site object per docs/CONTRACTS.md). */
export async function analyzeSite(src, lat, lon, loc) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  loc = loc || (await locate(src, lat, lon));
  const { near, far, surf, normal } = loc;
  // far grid around the surf point (usually same tiles as around the input)
  const farS = far.inside(surf.lat, surf.lon, 300) ? far : await buildGrid(src, FAR_Z, surf.lat, surf.lon);
  const frame = new Frame(surf.lat, surf.lon);
  const blurR = Math.max(1, Math.round(50 / near.mpp(surf.lat)));
  const nearS = loc.nearS || (loc.nearS = near.blurred(blurR, 2, 0));
  const terr = new Terrain(near, nearS, farS, frame);

  const nP = PERIODS.length;
  const kd2 = new Float32Array(nP * NB);
  const windowArr = new Float32Array(NB);
  const rays = [];
  const dTh = LAUNCH_STEP * DEG;
  const hS = Math.max(1, surf.depth);
  const angles = [];
  for (let a = -LAUNCH; a <= LAUNCH + 1e-9; a += LAUNCH_STEP) angles.push(a);

  for (let p = 0; p < nP; p++) {
    const T = PERIODS[p];
    const ratio = phaseSpeed(1e4, T) / phaseSpeed(hS, T); // C0/Cn
    const tab = spreadTable(spreadS(T));
    const keep = T === 14;
    const openDirs = [];
    angles.forEach((a, n) => {
      const r = traceRay(terr, T, normal + a, keep && n % 3 === 0);
      if (r.open) openDirs.push(r.dir);
      if (keep) {
        if (r.open) windowArr[Math.round(r.dir / 2) % NB] += 1;
        if (r.pts) {
          rays.push({
            period: T, open: r.open,
            pts: decimate(r.pts, 60).map(([px, py]) => {
              const [la, lo] = frame.toLL(px, py);
              return [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5];
            }),
          });
        }
      }
    });
    const base = p * NB, w = ratio * dTh;
    for (let i = 0; i < NB; i++) {
      let acc = 0;
      for (let j = 0; j < openDirs.length; j++) acc += spreadLookup(tab, openDirs[j] - i * 2);
      kd2[base + i] = acc * w;
    }
  }
  let wmax = 0;
  for (let i = 0; i < NB; i++) wmax = Math.max(wmax, windowArr[i]);
  if (wmax > 0) for (let i = 0; i < NB; i++) windowArr[i] /= wmax;

  // blocked offshore directions: straight casts from the surf point (seaward half only)
  const bl = new Uint8Array(NB);
  for (let i = 0; i < NB; i++) {
    const dir = i * 2;
    const rel = Math.abs(((dir - normal + 540) % 360) - 180);
    if (rel > 90) { bl[i] = 2; continue; } // landward half: not reported
    bl[i] = castBlocked(terr, dir, 100, MAX_DIST, true) ? 1 : 0;
  }
  const blocked = [];
  for (let i = 0; i < NB; i++) {
    if (bl[i] === 1 && bl[(i + NB - 1) % NB] !== 1) {
      let j = i;
      while (bl[(j + 1) % NB] === 1 && (j + 1) % NB !== i) j++;
      blocked.push({ from: (i * 2 - 1 + 360) % 360, to: ((j % NB) * 2 + 1) % 360 });
    }
  }

  const ms = Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0);
  return {
    input: loc.input,
    coast: loc.coast,
    surf: loc.surf,
    normal,
    slope: Math.round(loc.slope * 1e4) / 1e4,
    profile: loc.profile,
    periods: PERIODS.slice(),
    kd2,
    window: windowArr,
    rays,
    blocked,
    meta: { nearZoom: NEAR_Z, farZoom: FAR_Z, bathyZoom: loc.bathyZoom, snapDistM: loc.snapDistM, surfFallback: loc.surfFallback, ms },
  };
}

/** SceneData for the 3D diorama: 160x160, 6000 m square, north-up, centred on the surf point. */
export async function sceneData(src, lat, lon, loc) {
  loc = loc || (await locate(src, lat, lon));
  const n = 160, sizeM = 6000;
  const { near, far, surf } = loc;
  const terr = new Terrain(near, null, far, new Frame(surf.lat, surf.lon));
  const elev = new Float32Array(n * n);
  const step = sizeM / (n - 1), h = sizeM / 2;
  for (let r = 0; r < n; r++) {
    const y = h - r * step;
    for (let c = 0; c < n; c++) {
      const v = terr.elev(-h + c * step, y);
      elev[r * n + c] = v === v ? v : 0;
    }
  }
  return { n, sizeM, elev, normal: loc.normal, surf: { lat: surf.lat, lon: surf.lon } };
}
