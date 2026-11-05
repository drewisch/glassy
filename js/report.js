// Deterministic surf-report prose generated from model output (no LLM).
import { classifyWind, angDiff, bestWindows, RATINGS } from './model.js';

/* ---------------------------------------------------------------- format helpers */

const FT = 3.28084;
const DIRS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const hu = (u) => (u && u.height) || 'ft';
const su = (u) => (u && u.speed) || 'kt';
const tu = (u) => (u && u.temp) || 'c';

/** 16-point compass name for a direction in degrees. */
export function compass(deg) {
  if (deg == null || !Number.isFinite(+deg)) return '–';
  return DIRS16[Math.round((((+deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Height (m) in the user's unit: "4 ft" / "1.2 m". */
export function fmtHeight(m, units) {
  if (m == null || !Number.isFinite(m)) return '–';
  if (hu(units) === 'm') return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
  const f = m * FT;
  return f > 0 && f < 1 ? '<1 ft' : `${Math.round(f)} ft`;
}

/** Height range: "3–4 ft" / "0.9–1.3 m". */
export function fmtRange(a, b, units) {
  if (hu(units) === 'm') {
    const x = a.toFixed(1), y = b.toFixed(1);
    return x === y ? `${x} m` : `${x}–${y} m`;
  }
  let x = Math.round(a * FT), y = Math.round(b * FT);
  if (y < 1) return '<1 ft';
  if (x < 1) return y === 1 ? '1 ft' : `1–${y} ft`;
  if (y <= x) y = x + 1;
  return `${x}–${y} ft`;
}

/** Speed (m/s) in the user's unit. */
export function fmtSpeed(ms, units) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  switch (su(units)) {
    case 'kmh': return `${Math.round(ms * 3.6)} km/h`;
    case 'mph': return `${Math.round(ms * 2.23694)} mph`;
    case 'ms': return `${Math.round(ms)} m/s`;
    default: return `${Math.round(ms * 1.94384)} kt`;
  }
}

/** Temperature (°C) in the user's unit. */
export function fmtTemp(c, units) {
  if (c == null || !Number.isFinite(c)) return '–';
  return tu(units) === 'f' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

/** Local ISO "YYYY-MM-DDTHH:MM" -> "6am" / "6:42pm". */
export function fmtTime(iso) {
  if (!iso) return '–';
  const h = +iso.slice(11, 13), m = +iso.slice(14, 16);
  const ap = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

/** Local ISO date/time -> "Thu 5 Nov". */
export function fmtDay(iso) {
  if (!iso) return '–';
  const d = new Date(iso.slice(0, 10) + 'T00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Tide height (m, relative to MSL) with sign: "+1.4 ft" / "-0.32 m". */
export function fmtTide(m, units) {
  if (m == null || !Number.isFinite(m)) return '–';
  const v = hu(units) === 'm' ? m.toFixed(2) : (m * FT).toFixed(1);
  const s = +v > 0 ? '+' : '';
  return `${s}${v} ${hu(units) === 'm' ? 'm' : 'ft'}`;
}

/* ---------------------------------------------------------------- small utilities */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const pick = (arr, seed) => arr[(seed >>> 0) % arr.length];
const an = (w) => (/^(8|1[18](?!\d)|[aeiou])/i.test(String(w)) ? 'An' : 'A');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const isoMs = (iso) => Date.parse(iso + 'Z');
const msIso = (ms) => new Date(ms).toISOString().slice(0, 16);
const hourOf = (iso) => +iso.slice(11, 13);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function joinList(xs) {
  if (xs.length <= 1) return xs.join('');
  return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
}

/* ---------------------------------------------------------------- domain vocab */

const BODY = [
  [0.25, 'ankle high'], [0.45, 'knee high'], [0.65, 'thigh high'], [0.85, 'waist high'],
  [1.0, 'stomach high'], [1.2, 'chest high'], [1.45, 'shoulder high'], [1.85, 'head high'],
  [2.4, 'overhead'], [3.4, 'well overhead'], [Infinity, 'double overhead+'],
];
/** Body-relative term for a wave face height (m). */
export function bodyTerm(m) {
  for (const [lim, t] of BODY) if (m < lim) return t;
  return BODY[BODY.length - 1][1];
}
/** "waist to chest high", "head high to overhead", "knee high". */
export function bodyRange(min, max) {
  if (max < 0.15) return 'flat';
  const a = bodyTerm(min), b = bodyTerm(max);
  if (a === b) return a;
  if (a.endsWith(' high') && b.endsWith(' high')) return `${a.slice(0, -5)} to ${b}`;
  return `${a} to ${b}`;
}

function swellType(t, kind) {
  if (kind === 'windWave') return t >= 7 ? 'wind swell' : 'local wind chop';
  if (t >= 15) return 'long-period groundswell';
  if (t >= 12) return 'groundswell';
  if (t >= 9) return 'mid-period swell';
  if (t >= 7) return 'short-period windswell';
  return 'weak windswell';
}

const WIND_KIND = {
  offshore: 'offshore', 'cross-off': 'cross-offshore', cross: 'cross-shore',
  'cross-on': 'cross-onshore', onshore: 'onshore', glassy: 'glassy',
};
function windStrength(ms) {
  if (ms < 4) return 'light';
  if (ms < 7) return 'moderate';
  if (ms < 10) return 'fresh';
  if (ms < 14) return 'strong';
  return 'very strong';
}
function surfaceWord(w) {
  if (!w) return 'unknown';
  switch (w.kind) {
    case 'glassy': return 'glassy';
    case 'offshore': case 'cross-off': return w.speed > 11 ? 'clean but wind-blown' : 'clean';
    case 'cross': return w.speed < 4 ? 'mostly clean' : 'textured';
    case 'cross-on': return w.speed < 4 ? 'slightly textured' : 'bumpy';
    default: return w.speed < 4 ? 'a little lumpy' : w.speed < 8 ? 'choppy' : 'blown out';
  }
}

function wetsuit(c) {
  if (c >= 24) return 'boardshorts or a bikini will do';
  if (c >= 21) return 'a springsuit or neoprene top is plenty';
  if (c >= 17) return 'a 3/2 fullsuit is the call';
  if (c >= 14) return 'wear a 4/3 fullsuit';
  if (c >= 11) return 'a 5/4 with booties is needed';
  return 'it’s 5/4 hooded, booties and gloves territory';
}

/* ---------------------------------------------------------------- analysis */

/** Vector-averaged wind over hourly entries -> {speed, gust, dir, kind, score}. */
function avgWind(hs, normal) {
  if (!hs.length) return null;
  let u = 0, v = 0;
  for (const h of hs) {
    const r = (h.wind.dir * Math.PI) / 180;
    u += Math.sin(r) * h.wind.speed;
    v += Math.cos(r) * h.wind.speed;
  }
  const speed = mean(hs.map((h) => h.wind.speed));
  const gust = Math.max(...hs.map((h) => h.wind.gust || 0));
  const dir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const c = classifyWind(speed, dir, normal);
  return { speed, gust, dir, ...c };
}

function windPhrase(w, units, withSpeed = true) {
  if (!w) return 'unknown winds';
  if (w.kind === 'glassy') return w.speed < 1 ? 'calm and glassy' : 'near-calm and glassy';
  const s = `${windStrength(w.speed)} ${WIND_KIND[w.kind]} ${compass(w.dir)}`;
  if (!withSpeed) return s;
  const g = w.gust > 8 && w.gust > w.speed * 1.5 ? `, gusting ${fmtSpeed(w.gust, units)}` : '';
  return `${s} (${fmtSpeed(w.speed, units)}${g})`;
}

/** Local maxima/minima of the hourly tide, refined by parabolic interpolation. */
export function findTides(time, tide) {
  const out = [];
  for (let i = 1; i < tide.length - 1; i++) {
    const a = tide[i - 1], b = tide[i], c = tide[i + 1];
    if (a == null || b == null || c == null) continue;
    const high = b >= a && b > c, low = b <= a && b < c;
    if (!high && !low) continue;
    const A = (a - 2 * b + c) / 2, B = (c - a) / 2;
    let off = 0, h = b;
    if (Math.abs(A) > 1e-9) {
      off = Math.max(-1, Math.min(1, -B / (2 * A)));
      h = b + B * off + A * off * off;
    }
    const t = msIso(isoMs(time[i]) + Math.round(off * 60) * 60000);
    out.push({ time: t, h, kind: high ? 'high' : 'low' });
  }
  return out;
}

/** Index of the hourly entry for "now" at the spot. */
function nowIndex(time, offsetSec, nowMs) {
  const key = msIso(nowMs + offsetSec * 1000).slice(0, 13) + ':00';
  const i = time.indexOf(key);
  if (i >= 0) return i;
  return key < time[0] ? 0 : time.length - 1;
}

function dayIndex(hourly) {
  const days = new Map();
  hourly.forEach((h, i) => {
    const d = h.time.slice(0, 10);
    if (!days.has(d)) days.set(d, { all: [], light: [] });
    const e = days.get(d);
    e.all.push(i);
    if (h.daylight) e.light.push(i);
  });
  for (const e of days.values()) {
    if (!e.light.length) e.light = e.all.filter((i) => hourOf(hourly[i].time) >= 6 && hourOf(hourly[i].time) <= 18);
  }
  return days;
}

/** Summary of one day's daylight hours. */
function dayStats(hourly, idx, normal) {
  const hs = idx.map((i) => hourly[i]);
  const morning = hs.filter((h) => hourOf(h.time) < 11);
  const midday = hs.filter((h) => hourOf(h.time) >= 11 && hourOf(h.time) < 14);
  const afternoon = hs.filter((h) => hourOf(h.time) >= 14);
  let peak = hs[0];
  for (const h of hs) if (h.max > peak.max) peak = h;
  let best = hs[0];
  for (const h of hs) if (h.q > best.q) best = h;
  const seg = (a) => (a.length ? { min: mean(a.map((h) => h.min)), max: mean(a.map((h) => h.max)), wind: avgWind(a, normal) } : null);
  return {
    hs, peak, best,
    maxRating: Math.max(...hs.map((h) => h.rating)),
    meanMax: mean(hs.map((h) => h.max)),
    morning: seg(morning), midday: seg(midday), afternoon: seg(afternoon),
  };
}

function dominantPart(h) {
  let p = null;
  for (const x of h.parts) if (!p || x.hb > p.hb) p = x;
  return p && p.hb > 0 ? p : null;
}

function inRange(dir, r) {
  const d = ((dir % 360) + 360) % 360;
  return r.from <= r.to ? d >= r.from && d <= r.to : d >= r.from || d <= r.to;
}
function rangeDist(dir, r) {
  if (inRange(dir, r)) return 0;
  return Math.min(angDiff(dir, r.from), angDiff(dir, r.to));
}

/* ---------------------------------------------------------------- paragraphs */

function surfParagraph(ctx) {
  const { st, units, seed, when, nowH, spotName } = ctx;
  const ref = nowH && nowH.daylight && when === 'today' ? nowH : st.best;
  const body = bodyRange(ref.min, ref.max);
  const rng = fmtRange(ref.min, ref.max, units);
  const label = RATINGS[ref.rating].label.toLowerCase();
  if (st.peak.max < 0.25) {
    return pick([
      `${spotName} is essentially flat ${when}, with barely ${fmtRange(st.peak.min, st.peak.max, units)} at best. Longboards, foamies or a swim are the only options.`,
      `Not much to ride ${when}: the swell barely registers here, peaking around ${fmtRange(st.peak.min, st.peak.max, units)}. A good day for a paddle workout or a swim.`,
    ], seed);
  }
  let first;
  if (ref === nowH) {
    first = pick([
      `Right now ${spotName} is ${body} (${rng}) and rating ${label}.`,
      `Currently ${body} at ${spotName}, with sets of ${rng}; conditions rate ${label}.`,
      `${spotName} is showing ${body} waves right now (${rng}), ${label} overall.`,
    ], seed);
  } else {
    const at = hourOf(ref.time) < 11 ? 'in the morning' : hourOf(ref.time) < 14 ? 'around midday' : 'in the afternoon';
    first = pick([
      `Expect ${body} surf (${rng}) at ${spotName} ${when === 'today' ? '' : when + ' '}${at}, rating ${label} at its best.`,
      `${spotName} should run ${body} (${rng}) ${when}, peaking ${label} ${at}.`,
      `${spotName} looks ${body} ${when} (${rng}), with the best of it ${at} rated ${label}.`,
    ], seed);
  }
  // trend through the day
  const m = st.morning, a = st.afternoon;
  let trend = '';
  if (m && a && m.max > 0.2) {
    const r = a.max / m.max;
    if (r > 1.2) trend = pick([`It builds through the day to ${bodyRange(a.min, a.max)} by the afternoon.`, `Size picks up later, reaching ${bodyRange(a.min, a.max)} in the afternoon.`], seed >>> 3);
    else if (r < 0.8) trend = pick([`It eases through the day, down to ${bodyRange(a.min, a.max)} by the afternoon.`, `Expect it to back off later, to ${bodyRange(a.min, a.max)} in the afternoon.`], seed >>> 3);
    else trend = pick(['Size holds fairly steady through the day.', 'Wave height stays much the same from dawn to dusk.', 'No big change in size through the day.'], seed >>> 3);
  }
  return `${first} ${trend}`.trim();
}

function swellParagraph(ctx) {
  const { ref, site, units, seed } = ctx;
  const parts = ref.parts.filter((p) => p.h > 0.05 && p.t > 0).sort((a, b) => b.hb - a.hb || b.h - a.h);
  if (!parts.length) return 'There is no meaningful swell in the water.';
  const d = parts[0];
  const type = swellType(d.t, d.kind);
  const dirTxt = `${compass(d.dir)} (${Math.round(d.dir)}°)`;
  const s = [];
  s.push(pick([
    `The main energy is a ${fmtHeight(d.h, units)} ${Math.round(d.t)}-second ${type} from the ${dirTxt}`,
    `${an(Math.round(d.t))} ${Math.round(d.t)} s ${type} from the ${dirTxt} is doing most of the work, ${fmtHeight(d.h, units)} offshore`,
    `The dominant swell is ${type} from the ${dirTxt}: ${fmtHeight(d.h, units)} at ${Math.round(d.t)} s`,
  ], seed));
  const normal = site && Number.isFinite(site.normal) ? site.normal : null;
  let rel = '';
  if (normal != null) {
    const diff = angDiff(d.dir, normal);
    const faces = compass(normal);
    if (diff < 15) rel = `, lining up almost straight into the ${faces}-facing break`;
    else if (diff < 35) rel = `, arriving at a slight angle to the ${faces}-facing shore`;
    else if (diff < 60) rel = `, hitting the ${faces}-facing shore at a fairly steep angle, so it has to wrap to get in`;
    else if (diff < 90) rel = `, running almost parallel to this ${faces}-facing coast, so only a fraction gets in`;
    else rel = `, heading away from this ${faces}-facing break, so it will barely register`;
  }
  const k2 = d.kd * d.kd;
  const pct = Math.round(Math.min(k2, 1) * 100);
  let fit;
  if (k2 >= 0.85) fit = pick(['The break is wide open to this direction.', 'This direction sits right in the break’s swell window.'], seed >>> 2);
  else if (k2 >= 0.5) fit = `Refraction over the nearshore bathymetry lets most of it through (about ${pct}% of the energy).`;
  else if (k2 >= 0.2) fit = `Refraction and shelter cut it to roughly ${pct}% of its offshore energy by the time it reaches the lineup.`;
  else fit = `Very little of it (under ${Math.max(pct, 1)}% of the energy) makes it into the lineup.`;
  s[0] += rel + '.';
  s.push(fit);

  const blocked = (site && site.blocked) || [];
  const hit = blocked.find((r) => inRange(d.dir, r));
  const near = !hit && blocked.find((r) => rangeDist(d.dir, r) <= 10);
  if (hit) {
    s.push(pick([
      `Islands and headlands block swell from ${Math.round(hit.from)}–${Math.round(hit.to)}° here, and this one sits in that shadow, so expect long waits between sets.`,
      `It is coming straight out of the island shadow (${Math.round(hit.from)}–${Math.round(hit.to)}°), which knocks it down and makes it inconsistent.`,
    ], seed >>> 4));
  } else if (near) {
    s.push(`It sits on the edge of an island shadow (${Math.round(near.from)}–${Math.round(near.to)}°), so some sets will be noticeably smaller than others.`);
  }

  const second = parts[1];
  if (second && second.hb >= 0.35 * d.hb && second.h > 0.2) {
    const t2 = swellType(second.t, second.kind);
    const crossed = angDiff(second.dir, d.dir) > 40;
    s.push(pick([
      `${an(Math.round(second.t))} ${Math.round(second.t)} s ${t2} from the ${compass(second.dir)} ${crossed ? 'crosses it, making for peaky, shifty conditions' : 'fills in between the sets'}.`,
      `There is also ${t2} from the ${compass(second.dir)} (${fmtHeight(second.h, units)} @ ${Math.round(second.t)} s)${crossed ? ', adding cross-up and A-frame peaks' : ' adding a little extra size'}.`,
    ], seed >>> 5));
  }
  return s.join(' ');
}

function windParagraph(ctx) {
  const { st, hourly, idx, units, seed, site } = ctx;
  const m = st.morning, mid = st.midday, a = st.afternoon;
  const segs = [m, mid, a].filter(Boolean);
  if (!segs.length) return '';
  const good = (w) => w && w.score >= 0.7;
  const bad = (w) => w && w.score < 0.5;
  const first = m || mid || a;
  const last = a || mid || m;

  // first hour after the morning where the wind turns bad
  let turn = null;
  const normal = site?.normal ?? 0;
  if (good(first.wind)) {
    for (const i of idx) {
      const h = hourly[i];
      if (h.wind.score < 0.5 && h.wind.speed >= 3) { turn = h; break; }
    }
  }
  const seaBreeze = last.wind && (last.wind.kind === 'onshore' || last.wind.kind === 'cross-on');
  if (good(first.wind) && good(last.wind)) {
    return pick([
      `Winds stay favourable all day: ${windPhrase(first.wind, units)} early, ${windPhrase(last.wind, units)} later on.`,
      `A clean day on the wind front, ${windPhrase(first.wind, units)} at dawn and still ${windPhrase(last.wind, units)} in the afternoon.`,
    ], seed);
  }
  if (good(first.wind) && turn) {
    const tw = classifyWind(turn.wind.speed, turn.wind.dir, normal);
    return pick([
      `Get in early: it's ${windPhrase(first.wind, units)} at first light before the ${seaBreeze ? 'sea breeze' : 'wind'} turns ${WIND_KIND[tw.kind]} around ${fmtTime(turn.time)}, reaching ${windPhrase(last.wind, units)} in the afternoon.`,
      `Morning is the time to go, with ${windPhrase(first.wind, units)} winds. From about ${fmtTime(turn.time)} it swings ${WIND_KIND[tw.kind]}, and by the afternoon it's ${windPhrase(last.wind, units)}.`,
    ], seed);
  }
  if (bad(first.wind) && good(last.wind)) {
    return `Wind is a problem early (${windPhrase(first.wind, units)}) but it cleans up later, easing to ${windPhrase(last.wind, units)} in the afternoon.`;
  }
  if (bad(first.wind) && bad(last.wind)) {
    return pick([
      `Wind is the spoiler: ${windPhrase(first.wind, units)} in the morning and ${windPhrase(last.wind, units)} in the afternoon.`,
      `No escaping the wind, which runs ${windPhrase(first.wind, units)} early and ${windPhrase(last.wind, units)} later.`,
    ], seed);
  }
  const bits = [];
  if (m) bits.push(`${windPhrase(m.wind, units)} in the morning`);
  if (mid) bits.push(`${windPhrase(mid.wind, units, false)} around midday`);
  if (a) bits.push(`${windPhrase(a.wind, units)} in the afternoon`);
  return `Wind: ${joinList(bits)}.`;
}

function tideParagraph(ctx) {
  const { dayTides, win, hourly, timeIdx, units, rating } = ctx;
  const s = [];
  if (dayTides.length) {
    s.push('Tides: ' + dayTides.map((t) => `${t.kind} ${fmtTide(t.h, units)} at ${fmtTime(t.time)}`).join(', ') + '.');
  }
  if (win && rating > 0) {
    const i0 = timeIdx.get(win.start), i1 = timeIdx.get(win.end) ?? (i0 != null ? i0 + 1 : null);
    let tideTxt = '';
    if (i0 != null && i1 != null && hourly[i0]?.tide != null && hourly[Math.min(i1, hourly.length - 1)]?.tide != null) {
      const dt = hourly[Math.min(i1, hourly.length - 1)].tide - hourly[i0].tide;
      tideTxt = Math.abs(dt) < 0.08 ? ' around slack tide' : dt > 0 ? ' on a rising tide' : ' on a dropping tide';
    }
    s.push(`Best window: ${fmtTime(win.start)}–${fmtTime(win.end)}${tideTxt} (${RATINGS[win.rating].label.toLowerCase()}).`);
  }
  return s.join(' ');
}

function waterParagraph(ctx) {
  const { st, units, seed } = ctx;
  const ssts = st.hs.map((h) => h.sst).filter((x) => x != null);
  const airs = st.hs.map((h) => h.airTemp).filter((x) => x != null);
  if (!ssts.length) return '';
  const sst = mean(ssts);
  const air = airs.length ? Math.max(...airs) : null;
  const airTxt = air != null ? pick([`, air up to ${fmtTemp(air, units)}`, ` with the air reaching ${fmtTemp(air, units)}`], seed) : '';
  return `Water is around ${fmtTemp(sst, units)}${airTxt}; ${wetsuit(sst)}.`;
}

function headline(ctx) {
  const { st, win, when } = ctx;
  if (st.peak.max < 0.25) return when === 'tomorrow' ? 'Flat tomorrow' : 'Flat';
  const ref = st.best;
  const body = cap(bodyRange(ref.min, ref.max));
  // conditions across the window
  const surface = surfaceWord(ref.wind);
  let timing = '';
  if (win) {
    const h0 = hourOf(win.start), h1 = hourOf(win.end);
    const dayLen = st.hs.length;
    const winLen = (isoMs(win.end) - isoMs(win.start)) / 3600000;
    if (winLen >= dayLen - 2) timing = 'all day';
    else if (h1 <= 11) timing = 'early';
    else if (h0 >= 14) timing = 'late';
    else if (h0 >= 10 && h1 <= 15) timing = 'around midday';
    else if (h0 < 10) timing = 'this morning';
    if (timing === 'this morning' && when !== 'today') timing = 'in the morning';
  }
  const pre = when === 'tomorrow' ? 'Tomorrow: ' : '';
  return `${pre}${body} and ${surface}${timing ? ' ' + timing : ''}`;
}

/* ---------------------------------------------------------------- outlook */

function dayWindSummary(st, seed) {
  const m = st.morning?.wind || st.midday?.wind;
  const a = st.afternoon?.wind || st.midday?.wind;
  if (!m || !a) return '';
  const g = (w) => w.score >= 0.7, b = (w) => w.score < 0.5;
  if (g(m) && g(a)) return pick(['clean all day', 'light winds all day', 'favourable winds throughout'], seed);
  if (g(m) && b(a)) return pick([`clean early, ${WIND_KIND[a.kind]} by afternoon`, `best early before ${windStrength(a.speed)} ${WIND_KIND[a.kind]} winds`, `glassy-to-clean dawn, wind-affected later`], seed);
  if (b(m) && g(a)) return pick(['windy early, cleaning up late', `${WIND_KIND[m.kind]} in the morning, cleaner later`], seed);
  if (b(m) && b(a)) return pick([`${windStrength(a.speed)} ${WIND_KIND[a.kind]} winds most of the day`, 'wind-affected throughout', `${WIND_KIND[m.kind]} all day`], seed);
  return pick([`${surfaceWord(m)} early, ${surfaceWord(a)} later`, `${surfaceWord(m)} in the morning and ${surfaceWord(a)} in the afternoon`], seed);
}

function outlookSentence(date, st, prev, units, seed) {
  if (st.peak.max < 0.25) {
    return pick(['Flat or close to it.', 'Not enough swell to ride.', 'Little more than shorebreak.'], seed);
  }
  const ref = st.best;
  const body = bodyRange(ref.min, ref.max);
  const rng = fmtRange(ref.min, ref.max, units);
  const d = dominantPart(ref);
  const sw = d ? `${Math.round(d.t)} s ${compass(d.dir)} ${swellType(d.t, d.kind).replace('long-period ', '')}` : 'mixed swell';
  const wind = dayWindSummary(st, seed >>> 2);
  const label = RATINGS[st.maxRating].label.toLowerCase();
  let trend = '';
  if (prev && prev.peak.max > 0.2) {
    const r = st.peak.max / prev.peak.max;
    if (r > 1.25) trend = pick(['Building: ', 'Swell on the rise: ', 'Bigger: '], seed >>> 4);
    else if (r < 0.8) trend = pick(['Dropping: ', 'Easing: ', 'Smaller: '], seed >>> 4);
  }
  const t = pick([
    `${cap(body)} (${rng}) on a ${sw}, ${wind}; ${label} at best.`,
    `${cap(label)} at best, ${body} (${rng}) from a ${sw}, ${wind}.`,
    `${an(sw)} ${sw} brings ${body} sets (${rng}), ${wind}, ${label}.`,
  ], seed);
  return trend ? trend + t[0].toLowerCase() + t.slice(1) : t;
}

/* ---------------------------------------------------------------- main */

/**
 * @param {{spot, site, hourly, forecast, units, now?}} args  now: optional epoch ms (defaults to Date.now())
 * @returns {{headline, paragraphs: string[], outlook: [{date, text}], tides: [{time, h, kind}]}}
 */
export function buildReport({ spot, site, hourly, forecast, units, now }) {
  units = units || { height: 'ft', speed: 'kt', temp: 'c' };
  const spotName = (spot && spot.name) || 'This spot';
  const tides = findTides(forecast.time, forecast.tide || []);
  if (!hourly || !hourly.length) return { headline: 'No forecast data', paragraphs: [], outlook: [], tides };

  const timeIdx = new Map(hourly.map((h, i) => [h.time, i]));
  // bestWindows' end is exclusive (last hour + 1h); map it too
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const ni = nowIndex(forecast.time, forecast.utcOffsetSeconds || 0, nowMs);
  const nowH = hourly[ni];
  const days = dayIndex(hourly);
  const dates = [...days.keys()];
  const normal = site?.normal ?? 0;

  // focus day: today, or tomorrow once today's light is (nearly) gone
  let focus = nowH.time.slice(0, 10);
  let when = 'today';
  const todayLight = days.get(focus)?.light || [];
  const lastLight = todayLight.length ? hourly[todayLight[todayLight.length - 1]].time : null;
  if (lastLight && nowH.time >= lastLight && dates.indexOf(focus) < dates.length - 1) {
    focus = dates[dates.indexOf(focus) + 1];
    when = 'tomorrow';
  }
  const fIdx = days.get(focus).light;
  // for "today" consider only the remaining daylight
  const restIdx = when === 'today' ? fIdx.filter((i) => i >= ni) : fIdx;
  const idx = restIdx.length >= 2 ? restIdx : fIdx;
  const st = dayStats(hourly, idx, normal);

  const wins = bestWindows(when === 'today' ? hourly.map((h, i) => (i < ni ? { ...h, daylight: false } : h)) : hourly, 3);
  const win = wins.find((w) => w.date === focus) || null;
  const winRating = win ? win.rating : 0;

  const seed = hash(`${spotName}|${focus}`);
  const refHour = nowH.daylight && when === 'today' ? nowH : (win ? hourly[timeIdx.get(win.start)] : st.best);
  const dayTides = tides.filter((t) => t.time.slice(0, 10) === focus);
  const ctx = {
    st, units, seed, when, nowH, spotName, site, hourly, idx, ref: refHour,
    dayTides, win, timeIdx, rating: winRating,
  };

  const paragraphs = [
    surfParagraph(ctx),
    st.peak.max >= 0.25 ? swellParagraph(ctx) : '',
    windParagraph(ctx),
    tideParagraph(ctx),
    waterParagraph(ctx),
  ].filter(Boolean);

  const outlook = [];
  const fi = dates.indexOf(focus);
  let prev = st;
  for (let k = fi + 1; k < dates.length && outlook.length < 7; k++) {
    const date = dates[k];
    const dst = dayStats(hourly, days.get(date).light, normal);
    outlook.push({ date, text: outlookSentence(date, dst, prev, units, hash(`${spotName}|${date}`)) });
    prev = dst;
  }

  return { headline: headline(ctx), paragraphs, outlook, tides };
}
