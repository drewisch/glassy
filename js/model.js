// Surf model: nearshore (CDIP MOP) or offshore (Open-Meteo) partitions -> breaking height at
// the site, wind quality, rating.
import { shoaling } from './nearshore.js';

const G = 9.81;
const NB = 180; // 2° direction bins

export const RATINGS = [
  { key: 'flat', label: 'Flat', color: '--r0' },
  { key: 'very-poor', label: 'Very poor', color: '--r1' },
  { key: 'poor', label: 'Poor', color: '--r2' },
  { key: 'poor-fair', label: 'Poor to fair', color: '--r3' },
  { key: 'fair', label: 'Fair', color: '--r4' },
  { key: 'good', label: 'Good', color: '--r5' },
  { key: 'epic', label: 'Epic', color: '--r6' },
];

const DEFAULT_PERIODS = [6, 8, 10, 12, 14, 16, 18, 20, 22];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrap360 = (d) => ((d % 360) + 360) % 360;
/** Smallest absolute angle between two compass directions, 0..180. */
export const angDiff = (a, b) => {
  const d = Math.abs(wrap360(a) - wrap360(b));
  return d > 180 ? 360 - d : d;
};

/** Piecewise-linear interpolation through [[x,y],...] sorted by x. */
function lerpTable(tab, x) {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1];
      const [x1, y1] = tab[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return tab[tab.length - 1][1];
}

/** Bilinear lookup in a [period][dir-bin] table (direction wraps). */
function lookup2(table, periods, t, dir) {
  const np = periods.length;
  const tc = clamp(t, periods[0], periods[np - 1]);
  let p0 = 0;
  while (p0 < np - 2 && tc > periods[p0 + 1]) p0++;
  const p1 = Math.min(p0 + 1, np - 1);
  const fp = p1 === p0 ? 0 : (tc - periods[p0]) / (periods[p1] - periods[p0]);
  const x = wrap360(dir) / 2;
  const i0 = Math.floor(x) % NB;
  const i1 = (i0 + 1) % NB;
  const fd = x - Math.floor(x);
  const row = (p) => table[p * NB + i0] * (1 - fd) + table[p * NB + i1] * fd;
  return row(p0) * (1 - fp) + row(p1) * fp;
}

/** Directional spreading exponent (cos^2s(Δθ/2)) as a function of period. */
const spreadS = (t) => clamp(4 + (t - 6) * 1.6, 4, 30);

// Reference openness convolved with spreading, per period; cached per refOpen array.
const convCache = new WeakMap();
function convolvedRef(refOpen, periods) {
  let c = convCache.get(refOpen);
  if (c && c.periods === periods) return c.table;
  const table = new Float32Array(periods.length * NB);
  periods.forEach((T, p) => {
    const s = spreadS(T);
    const w = new Float32Array(NB);
    let ws = 0;
    for (let k = 0; k < NB; k++) {
      const dth = (k * 2 * Math.PI) / 180; // offset k*2°
      const v = Math.pow(Math.abs(Math.cos(dth / 2)), 2 * s);
      w[k] = v;
      ws += v;
    }
    for (let i = 0; i < NB; i++) {
      let acc = 0;
      for (let k = 0; k < NB; k++) {
        if (w[k] < 1e-5) continue;
        acc += w[k] * refOpen[(i + k) % NB];
      }
      table[p * NB + i] = acc / ws;
    }
  });
  convCache.set(refOpen, { periods, table });
  return table;
}

/** Komar–Gaughan breaker height from deep-water height h0 (m) and period t (s). */
export function komarGaughan(h0, t) {
  if (!(h0 > 0) || !(t > 0)) return 0;
  return 0.39 * Math.pow(G, 0.2) * Math.pow(t * h0 * h0, 0.4);
}

/** Wind relative to a break facing `normal`. Returns {kind, score 0..1}. */
export function classifyWind(speed, dir, normal) {
  speed = speed || 0;
  if (speed < 2) return { kind: 'glassy', score: 1 };
  const a = angDiff(dir, normal + 180); // 0 = blowing from land straight out to sea
  let kind, base;
  if (a < 30) { kind = 'offshore'; base = 1; }
  else if (a < 70) { kind = 'cross-off'; base = 0.82; }
  else if (a < 110) { kind = 'cross'; base = 0.45; }
  else if (a < 150) { kind = 'cross-on'; base = 0.2; }
  else { kind = 'onshore'; base = 0; }
  const f = clamp((speed - 2) / 8, 0, 1); // 0 at 2 m/s, 1 at 10 m/s
  let score = 1 - (1 - base) * f;
  // very strong offshore makes paddling in hard and blows tops off
  if (base >= 0.8 && speed > 11) score -= clamp((speed - 11) / 10, 0, 0.35);
  if (base < 0.8 && speed > 12) score -= clamp((speed - 12) / 12, 0, 0.2);
  return { kind, score: clamp(score, 0, 1) };
}

// Face height (max, m) -> 0..1 size quality
const HEIGHT_Q = [[0.25, 0.05], [0.45, 0.2], [0.7, 0.38], [0.95, 0.55], [1.3, 0.72], [1.8, 0.86], [2.5, 0.97], [3.5, 1]];
// Dominant period (s) -> 0..1 quality
const PERIOD_Q = [[5, 0.1], [7, 0.3], [9, 0.5], [11, 0.7], [13, 0.88], [15, 1]];
const THRESH = [0.12, 0.25, 0.4, 0.58, 0.82]; // q cut points for ratings 1..5 -> 6

/** Rating 0..6 and continuous quality q from face max (m), dominant period, wind score. */
export function rateSurf(max, period, windScore) {
  if (!(max >= 0.25)) return { rating: 0, q: 0 };
  const hq = lerpTable(HEIGHT_Q, max);
  const pq = lerpTable(PERIOD_Q, period || 0);
  let q = hq * (0.55 + 0.45 * pq) * (0.35 + 0.65 * windScore);
  // huge surf is only "epic" for a few; keep it there but don't let mush rank high
  let rating = 1;
  for (const t of THRESH) if (q >= t) rating++;
  return { rating: Math.min(rating, 6), q };
}

const toMin = (iso) => (iso ? Date.parse(iso + 'Z') / 60000 : NaN);

/**
 * Compute hourly surf at the site.
 * @returns Hourly[] (see CONTRACTS.md) + extra fields: q (0..1 quality), daylight (bool), period (dominant s)
 */
export function computeSurf(site, forecast, refOpen) {
  const periods = site.periods && site.periods.length ? site.periods : DEFAULT_PERIODS;
  const kd2 = site.kd2;
  const ref = refOpen && refOpen.length === NB ? convolvedRef(refOpen, periods) : null;
  const normal = site.normal ?? 0;

  // daylight lookup by date
  const sun = new Map();
  for (const d of forecast.daily || []) sun.set(d.date, { rise: toMin(d.sunrise), set: toMin(d.sunset) });

  const kdFor = (t, dir) => {
    let k = kd2 ? lookup2(kd2, periods, t, dir) : 1;
    if (ref) k /= Math.max(lookup2(ref, periods, t, dir), 0.2);
    return clamp(k, 0, 1.3);
  };

  const out = [];
  const n = forecast.time.length;
  for (let i = 0; i < n; i++) {
    const time = forecast.time[i];
    const parts = [];
    let sum2 = 0;
    let pw = 0, pwt = 0;
    const ns = forecast.nearshore?.[i];
    if (ns) {
      // Nearshore (CDIP MOP, ~10 m depth): refraction and island sheltering are already in the
      // data. Un-shoal to an equivalent deep-water height, add the last bit of refraction from
      // 10 m to the break (Snell → near-normal incidence), then break it with Komar–Gaughan.
      for (const p of ns.parts) {
        const rel = Math.min(angDiff(p.dir, normal), 89);
        const kr = Math.sqrt(Math.max(Math.cos((rel * Math.PI) / 180), 0));
        const h0 = (p.h / shoaling(ns.depth, p.t)) * kr;
        const hb = komarGaughan(h0, p.t);
        sum2 += hb * hb; pw += hb * hb; pwt += hb * hb * p.t;
        parts.push({ kind: p.kind, h: p.h, t: p.t, dir: p.dir, kd: null, h0, hb, depth: ns.depth });
      }
    }
    for (const kind of ns ? [] : ['swell', 'swell2', 'windWave']) {
      const src = forecast[kind]?.[i] || { h: 0, t: 0, dir: 0 };
      const h = src.h || 0, t = src.t || 0, dir = src.dir || 0;
      let k2 = 0, h0 = 0, hb = 0;
      if (h > 0 && t > 0) {
        k2 = kdFor(t, dir);
        h0 = h * Math.sqrt(k2);
        hb = komarGaughan(h0, t);
      }
      sum2 += hb * hb;
      pw += hb * hb;
      pwt += hb * hb * t;
      parts.push({ kind, h, t, dir, kd: Math.sqrt(k2), h0, hb });
    }
    const hb = Math.sqrt(sum2);
    const min = 0.55 * hb, max = 0.85 * hb;
    const period = pw > 0 ? pwt / pw : 0;
    const w = forecast.wind?.[i] || { speed: 0, gust: 0, dir: 0 };
    const wc = classifyWind(w.speed, w.dir, normal);
    const { rating, q } = rateSurf(max, period, wc.score);
    const s = sun.get(time.slice(0, 10));
    const tm = toMin(time);
    // an hour counts as daylight if most of it is between sunrise and sunset
    const daylight = s ? tm + 30 >= s.rise && tm + 30 <= s.set : (+time.slice(11, 13) >= 6 && +time.slice(11, 13) <= 18);
    out.push({
      time, hb, min, max, rating, ratingLabel: RATINGS[rating].label, parts,
      wind: { speed: w.speed, gust: w.gust, dir: w.dir, kind: wc.kind, score: wc.score },
      tide: forecast.tide?.[i] ?? null,
      sst: forecast.sst?.[i] ?? null,
      airTemp: forecast.airTemp?.[i] ?? null,
      weatherCode: forecast.weatherCode?.[i] ?? null,
      q, daylight, period,
    });
  }
  return out;
}

const addHour = (iso, h = 1) => new Date(Date.parse(iso + 'Z') + h * 3600000).toISOString().slice(0, 16);

/**
 * Best surf window per day (daylight hours only).
 * `n` = minimum window length in hours. Returns one entry per day that has daylight:
 * [{date, start, end, rating}] — start = first hour (iso), end = exclusive end (iso, last hour + 1 h).
 * rating = minimum rating within the window (null-free); windows on flat days still returned with rating 0.
 */
export function bestWindows(hourly, n = 3) {
  const days = new Map();
  hourly.forEach((h, i) => {
    if (!h.daylight) return;
    const d = h.time.slice(0, 10);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(i);
  });
  const res = [];
  for (const [date, idx] of days) {
    const len = Math.min(n, idx.length);
    let best = -1, bestStart = 0;
    for (let s = 0; s + len <= idx.length; s++) {
      let acc = 0;
      for (let k = 0; k < len; k++) acc += hourly[idx[s + k]].q;
      // tiny preference for earlier windows (dawn patrol) to break ties deterministically
      const score = acc / len - s * 1e-6;
      if (score > best) { best = score; bestStart = s; }
    }
    let a = bestStart, b = bestStart + len - 1;
    let rating = Infinity;
    for (let k = a; k <= b; k++) rating = Math.min(rating, hourly[idx[k]].rating);
    // extend while neighbours keep the same rating and quality stays close
    const qMean = best;
    while (a > 0 && hourly[idx[a - 1]].rating >= rating && hourly[idx[a - 1]].q >= qMean * 0.9) a--;
    while (b < idx.length - 1 && hourly[idx[b + 1]].rating >= rating && hourly[idx[b + 1]].q >= qMean * 0.9) b++;
    res.push({
      date,
      start: hourly[idx[a]].time,
      end: addHour(hourly[idx[b]].time),
      rating: rating === Infinity ? 0 : rating,
    });
  }
  return res;
}
