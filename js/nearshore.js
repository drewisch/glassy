// Nearshore data for California:
//  - Scripps CDIP MOP alongshore forecasts: spectral wave forecasts at 10 m depth every ~100 m
//    of coastline, already refracted and island-sheltered by backward ray tracing over
//    high-resolution bathymetry (O'Reilly & Guza). https://cdip.ucsd.edu/MOP_v1.1/
//  - NOAA CO-OPS harmonic tide predictions (MLLW).
// Both are public and CORS-enabled, so the browser talks to them directly.
import { fetchCounted } from './net.js';
import { haversineKm } from './spots.js';

const MOP = 'https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore/';
const NOAA = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const DATA = new URL('../data/', import.meta.url);
const MAX_MOP_KM = 3;      // a MOP point must be this close to the spot
const MAX_TIDE_KM = 80;    // nearest harmonic tide station
const G = 9.81;

const memo = new Map();
const once = (k, f) => { if (!memo.has(k)) memo.set(k, f().catch((e) => { memo.delete(k); throw e; })); return memo.get(k); };
const getJSON = (url) => fetchCounted(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
const getText = (url) => fetchCounted(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });

const loadIndex = () => once('mop-index', () => getJSON(new URL('mop-index.json', DATA)));
const loadStations = () => once('tide-stations', () => getJSON(new URL('tide-stations.json', DATA)));

/** Quick bounding test so non-California points never download the index. */
export const inCalifornia = (lat, lon) => lat > 32.4 && lat < 42.1 && lon > -124.6 && lon < -117.0;

/** Nearest MOP point, or null if none within MAX_MOP_KM. */
export async function findMop(lat, lon) {
  if (!inCalifornia(lat, lon)) return null;
  const idx = await loadIndex();
  let best = null, bd = Infinity;
  for (const [region, rows] of Object.entries(idx.regions)) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (Math.abs(r[0] - lat) > 0.05) continue;
      const d = haversineKm({ lat, lon }, { lat: r[0], lon: r[1] });
      if (d < bd) { bd = d; best = { region, i, lat: r[0], lon: r[1], normal: r[2], depth: r[3], label: r[4], distKm: d }; }
    }
  }
  return best && bd <= MAX_MOP_KM ? best : null;
}

// --- OPeNDAP ASCII --------------------------------------------------------------------
/** Parse an OPeNDAP .ascii response into {name: number[]} (flattened, row-major). */
function parseDapAscii(txt) {
  const body = txt.split(/^-{5,}\s*$/m).pop();
  const out = {};
  let cur = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^([A-Za-z_]\w*)((?:\[\d+\])+)$/);
    if (head) { cur = out[head[1]] = []; continue; }
    if (!cur) continue;
    for (const v of line.replace(/^(\[\d+\])+,\s*/, '').split(',')) {
      const x = parseFloat(v);
      cur.push(Number.isFinite(x) ? x : NaN);
    }
  }
  return out;
}

const dims = (region) => once(`dds-${region}`, async () => {
  const dds = await getText(`${MOP}${region}_alongshore_forecast.nc.dds`);
  return {
    nt: +dds.match(/waveTime\[waveTime = (\d+)\]/)[1],
    nf: +dds.match(/waveFrequency\[waveFrequency = (\d+)\]/)[1],
  };
});

// --- Spectral partitioning ----------------------------------------------------------------
const circMean = (dirs, w) => {
  let s = 0, c = 0;
  dirs.forEach((d, k) => { if (Number.isFinite(d) && w[k] > 0) { s += w[k] * Math.sin(d * Math.PI / 180); c += w[k] * Math.cos(d * Math.PI / 180); } });
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360;
};
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Split a 1-D frequency spectrum into swell systems (watershed on E(f)), merging weak or
 * poorly separated neighbours. Returns up to 3 parts {h, t, dir, kind}, largest first.
 */
export function partitionSpectrum(freq, bw, E, dir) {
  const n = freq.length;
  const e = E.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const owner = new Int32Array(n).fill(-1);
  const climb = (i) => {
    while (true) {
      let j = i;
      if (i > 0 && e[i - 1] > e[j]) j = i - 1;
      if (i < n - 1 && e[i + 1] > e[j]) j = i + 1;
      if (j === i) return i;
      i = j;
    }
  };
  for (let i = 0; i < n; i++) owner[i] = climb(i);
  // groups in frequency order
  let groups = [];
  for (let i = 0; i < n; i++) {
    const g = groups[groups.length - 1];
    if (g && g.peak === owner[i]) g.bins.push(i); else groups.push({ peak: owner[i], bins: [i] });
  }
  const m0 = (g) => g.bins.reduce((s, i) => s + e[i] * bw[i], 0);
  const gdir = (g) => circMean(g.bins.map((i) => dir[i]), g.bins.map((i) => e[i] * bw[i]));
  const total = groups.reduce((s, g) => s + m0(g), 0);
  if (!(total > 0)) return [];
  // merge: weak systems (<6% energy) or neighbours without a real valley and similar direction
  let merged = true;
  while (merged && groups.length > 1) {
    merged = false;
    for (let k = 0; k < groups.length - 1; k++) {
      const a = groups[k], b = groups[k + 1];
      const valley = Math.min(...[a.bins[a.bins.length - 1], b.bins[0]].map((i) => e[i]));
      const smallPeak = Math.min(e[a.peak], e[b.peak]);
      const weak = Math.min(m0(a), m0(b)) < 0.06 * total;
      const shallow = valley > 0.65 * smallPeak && angDiff(gdir(a), gdir(b)) < 35;
      if (weak || shallow) {
        groups.splice(k, 2, { peak: e[a.peak] >= e[b.peak] ? a.peak : b.peak, bins: [...a.bins, ...b.bins] });
        merged = true;
        break;
      }
    }
  }
  const parts = groups.map((g) => ({ h: 4 * Math.sqrt(m0(g)), t: 1 / freq[g.peak], dir: gdir(g) }))
    .sort((a, b) => b.h - a.h).slice(0, 3);
  // kinds: short-period sea is windWave; the rest are swell / swell2 by size
  let swells = 0;
  for (const p of parts) p.kind = p.t < 8 ? 'windWave' : (swells++ === 0 ? 'swell' : 'swell2');
  return parts;
}

/** MOP forecast for one point: 3-hourly bulk params and partitions (≈10 days incl. ~3 days hindcast). */
export function getMopForecast(pt) {
  return once(`mop-${pt.region}-${pt.i}`, async () => {
    const { nt, nf } = await dims(pt.region);
    const T = `%5B0:1:${nt - 1}%5D`, F = `%5B0:1:${nf - 1}%5D`, S = `%5B${pt.i}%5D`;
    const q = ['waveTime', 'waveFrequency', 'waveBandwidth',
      `waveHs${T}${S}`, `waveTp${T}${S}`, `waveDp${T}${S}`,
      `waveEnergyDensity${T}${F}${S}`, `waveMeanDirection${T}${F}${S}`].join(',');
    const d = parseDapAscii(await getText(`${MOP}${pt.region}_alongshore_forecast.nc.ascii?${q}`));
    const steps = d.waveTime.map((t, k) => ({
      t: t * 1000,
      hs: d.waveHs[k], tp: d.waveTp[k], dp: d.waveDp[k],
      parts: partitionSpectrum(d.waveFrequency, d.waveBandwidth,
        d.waveEnergyDensity.slice(k * nf, (k + 1) * nf), d.waveMeanDirection.slice(k * nf, (k + 1) * nf)),
    })).filter((s) => Number.isFinite(s.hs) && s.hs >= 0);
    return { point: pt, steps };
  });
}

// --- Tides -----------------------------------------------------------------------------
export async function nearestTideStation(lat, lon) {
  const st = await loadStations();
  let best = null, bd = Infinity;
  for (const [id, name, la, lo] of st) {
    const d = haversineKm({ lat, lon }, { lat: la, lon: lo });
    if (d < bd) { bd = d; best = { id, name, lat: la, lon: lo, distKm: d }; }
  }
  return bd <= MAX_TIDE_KM ? best : null;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/** Hourly NOAA tide predictions (MLLW, metres) covering [startMs, startMs + hours]. Map epochMs -> m. */
export function noaaTides(station, startMs, hours) {
  const day0 = Math.floor(startMs / 86400000) * 86400000;
  return once(`tide-${station.id}-${day0}-${hours}`, async () => {
    const url = `${NOAA}?product=predictions&application=glassy&station=${station.id}&begin_date=${ymd(day0)}` +
      `&range=${hours + 48}&datum=MLLW&units=metric&time_zone=gmt&interval=h&format=json`;
    const j = await getJSON(url);
    if (!j.predictions) throw new Error(j.error?.message || 'No tide predictions');
    const m = new Map();
    for (const p of j.predictions) m.set(Date.parse(p.t.replace(' ', 'T') + ':00Z'), +p.v);
    return m;
  });
}

// --- Merge into the Open-Meteo forecast -------------------------------------------------
const cgRatio = (h, t) => {
  // Cg(h)/Cg0 via explicit dispersion (Guo 2002)
  const w = (2 * Math.PI) / t, x = w * Math.sqrt(h / G);
  const kh = x * x * Math.pow(1 - Math.exp(-Math.pow(x, 2.4908)), -1 / 2.4908);
  const n = 0.5 * (1 + (2 * kh) / Math.sinh(2 * kh));
  const c = Math.sqrt((G / (kh / h)) * Math.tanh(kh));
  return (n * c) / ((G * t) / (4 * Math.PI));
};
/** Shoaling coefficient Ks = sqrt(Cg0 / Cg(h)). */
export const shoaling = (h, t) => 1 / Math.sqrt(cgRatio(h, t));

/**
 * Attach nearshore data to an Open-Meteo forecast (mutates and returns it):
 *  forecast.nearshore[i] = {depth, parts:[{kind,h,t,dir}]}  (hourly, aligned with forecast.time)
 *  forecast.tide          <- NOAA harmonic predictions (MLLW) when a station is near
 *  forecast.sources        = {mop, tideStation}
 * Returns null if the point has no MOP coverage (caller falls back to the offshore model).
 */
export async function attachNearshore(forecast, lat, lon) {
  const pt = await findMop(lat, lon);
  if (!pt) return null;
  const off = (forecast.utcOffsetSeconds || 0) * 1000;
  const epoch = forecast.time.map((iso) => Date.parse(iso + 'Z') - off);
  const [mop, tides] = await Promise.all([
    getMopForecast(pt),
    nearestTideStation(lat, lon).then((st) => st && noaaTides(st, epoch[0], forecast.time.length).then((m) => ({ st, m })))
      .catch(() => null),
  ]);
  const steps = mop.steps;
  const lastT = steps.length ? steps[steps.length - 1].t : -Infinity;
  forecast.nearshore = epoch.map((t) => {
    if (!steps.length || t > lastT + 3 * 3600e3 || t < steps[0].t) return null;
    // nearest 3-hourly step; scale its partitions to the linearly interpolated bulk height
    let k = 0;
    while (k < steps.length - 1 && steps[k + 1].t <= t) k++;
    const a = steps[k], b = steps[Math.min(k + 1, steps.length - 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const near = f < 0.5 ? a : b;
    const hs = a.hs + (b.hs - a.hs) * f;
    const scale = near.hs > 0 ? hs / near.hs : 0;
    return { depth: pt.depth, parts: near.parts.map((p) => ({ ...p, h: p.h * scale })) };
  });
  if (tides) {
    forecast.tide = epoch.map((t) => tides.m.get(t) ?? null);
    forecast.tideDatum = 'MLLW';
  }
  // keep only the hours MOP covers (its horizon is ~1 day shorter than Open-Meteo's)
  const n = forecast.time.length, last = forecast.nearshore.findLastIndex((x) => x);
  if (last < 0) return null;
  for (const [k, v] of Object.entries(forecast)) if (Array.isArray(v) && v.length === n && k !== 'daily') forecast[k] = v.slice(0, last + 1);
  forecast.sources = { mop: pt, tideStation: tides?.st || null };
  return forecast;
}
