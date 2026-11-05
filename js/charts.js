// Glassy SVG charts. Hand-written SVG, no libraries.
// All colours come from CSS custom properties via classes in css/charts.css.
// Charts render at the container's pixel width (viewBox = pixel box, width 100%)
// so hairlines and text stay crisp; a ResizeObserver re-renders on width change.
import { fmtHeight, fmtSpeed, compass, fmtTime, fmtDay } from './report.js';

const M_TO_FT = 3.28084;
const M_TO_MI = 1 / 1609.344;
let uidSeq = 0;
const uid = (p) => `gc-${p}-${++uidSeq}`;

// ---------- small helpers ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const hl = (v) => Math.round(v) + 0.5; // pixel-snap a 1px hairline
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function niceStep(range, target) {
  const raw = Math.max(range, 1e-9) / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const tickLabel = (v) => {
  const s = String(+v.toFixed(2));
  return v < 0 ? '−' + s.slice(1) : s;
};
// Trailing unit of a formatted value ("1.2 m" -> "m", "12 kt" -> "kt").
const unitOf = (s) => String(s).replace(/^[\s\d.,+\-−]+/, '').trim();
const numOf = (s) => (String(s).match(/\d+(?:\.\d+)?/) || [''])[0];
const heightIsFt = (units) => (units && units.height) === 'ft';
const toHU = (m, units) => (heightIsFt(units) ? m * M_TO_FT : m);

function fmtRange(a, b, units) {
  const sa = fmtHeight(a, units), sb = fmtHeight(b, units);
  if (sa === sb) return sb;
  const ua = unitOf(sa), ub = unitOf(sb);
  if (ua && ua === ub && sa.endsWith(ua)) return sa.slice(0, -ua.length).trim() + '–' + sb;
  return sa + '–' + sb;
}
function fmtSigned(m, units) {
  return (m < -0.005 ? '−' : '') + fmtHeight(Math.abs(m), units);
}

function svgOpen(w, h, label, cls, extra = '') {
  const id = uid('t');
  return `<svg xmlns="http://www.w3.org/2000/svg" class="gc-svg ${cls}" viewBox="0 0 ${w} ${h}" width="100%" ` +
    `preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="${id}" aria-label="${esc(label)}" ${extra}>` +
    `<title id="${id}">${esc(label)}</title>`;
}

// Render on mount and whenever the container width changes.
function mount(el, draw) {
  if (el._gcRO) { el._gcRO.disconnect(); el._gcRO = null; }
  let lastW = -1;
  const run = () => {
    const w = Math.round(el.clientWidth || 0);
    if (w === lastW) return;
    lastW = w;
    draw(w > 0 ? w : 640);
  };
  run();
  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run); });
    ro.observe(el);
    el._gcRO = ro;
  }
}

// Catmull-Rom spline through points -> SVG cubic path (no leading M).
function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${r1(pts[0][0])},${r1(pts[0][1])}` : '';
  let d = `M${r1(pts[0][0])},${r1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${r1(c1x)},${r1(c1y)} ${r1(c2x)},${r1(c2y)} ${r1(p2[0])},${r1(p2[1])}`;
  }
  return d;
}

// Local wall-clock ms for an Open-Meteo local ISO string (treated as UTC, see contract).
const isoMs = (iso) => Date.parse(iso + (iso.length <= 16 ? ':00Z' : 'Z'));
const msIso = (ms) => new Date(ms).toISOString().slice(0, 16);

// ======================================================================
// forecastChart
// ======================================================================
export function forecastChart(el, hourly, { units, onSelect } = {}) {
  hourly = hourly || [];
  const N = hourly.length;
  el.classList.add('gc', 'gc-forecast');
  el.innerHTML = '';
  const readout = document.createElement('div');
  readout.className = 'gc-readout';
  readout.setAttribute('aria-live', 'polite');
  const scroller = document.createElement('div');
  scroller.className = 'gc-scroll';
  el.append(readout, scroller);

  if (!N) {
    readout.textContent = 'No forecast data';
    return { select() {} };
  }

  const hUnit = unitOf(fmtHeight(1, units)) || (heightIsFt(units) ? 'ft' : 'm');
  const sUnit = unitOf(fmtSpeed(5, units));
  const nBars = Math.ceil(N / 3);

  // Representative hour per 3-hour block: the one with the largest max.
  const rep = [];
  for (let k = 0; k < nBars; k++) {
    let best = k * 3;
    for (let j = k * 3; j < Math.min(N, k * 3 + 3); j++) if ((hourly[j].max || 0) > (hourly[best].max || 0)) best = j;
    rep.push(best);
  }
  const maxU = Math.max(0.5, ...hourly.map((h) => toHU(h.max || 0, units)));
  const step = niceStep(maxU, 4);
  const yTop = Math.ceil(maxU / step) * step;

  // Day boundaries.
  const days = [];
  for (let i = 0; i < N; i++) {
    const d = String(hourly[i].time).slice(0, 10);
    if (!days.length || days[days.length - 1].date !== d) days.push({ date: d, i0: i, i1: i });
    else days[days.length - 1].i1 = i;
  }

  let sel = -1;
  let geo = null; // layout of current render
  let svg = null, cur = null;

  const L = { padL: 38, padR: 8, dayY: 15, top: 30, bot: 168, windY: 186, spdY: 207, H: 216 };

  function draw(cw) {
    const W = Math.max(900, cw);
    const plotW = W - L.padL - L.padR;
    const hw = plotW / N;
    const xh = (i) => L.padL + i * hw;
    const y = (u) => L.bot - (u / yTop) * (L.bot - L.top);
    geo = { W, hw, xh, y };

    let s = svgOpen(W, L.H, summary(), 'gc-fc', `tabindex="0" style="min-width:900px"`);

    // day bands, separators, labels
    days.forEach((d, n) => {
      const x0 = xh(d.i0), x1 = xh(d.i1 + 1);
      if (n % 2 === 1) s += `<rect class="gc-dayband" x="${r1(x0)}" y="${L.top}" width="${r1(x1 - x0)}" height="${L.bot - L.top}"/>`;
      if (n > 0) s += `<line class="gc-daysep" x1="${hl(x0)}" x2="${hl(x0)}" y1="4" y2="${L.H - 2}"/>`;
      const span = x1 - x0;
      if (span > 34) {
        const lab = span > 60 ? fmtDay(hourly[d.i0].time) : fmtDay(hourly[d.i0].time).split(/\s+/)[0];
        s += `<text class="gc-day" x="${r1(x0 + 6)}" y="${L.dayY}">${esc(lab)}</text>`;
      }
      // 6-hourly minor ticks on the baseline
      for (let i = d.i0; i <= d.i1; i++) {
        const hr = +String(hourly[i].time).slice(11, 13);
        if (hr % 6 === 0 && hr !== 0) s += `<line class="gc-tick" x1="${hl(xh(i))}" x2="${hl(xh(i))}" y1="${L.bot}" y2="${L.bot + (hr === 12 ? 4 : 2.5)}"/>`;
      }
    });

    // gridlines + labels
    for (let u = 0; u <= yTop + 1e-9; u += step) {
      const yy = hl(y(u));
      s += `<line class="gc-grid${u === 0 ? ' gc-base' : ''}" x1="${L.padL}" x2="${W - L.padR}" y1="${yy}" y2="${yy}"/>`;
      if (u > 0) s += `<text class="gc-axis" x="${L.padL - 6}" y="${yy + 3.5}" text-anchor="end">${tickLabel(u)}</text>`;
    }
    s += `<text class="gc-axis gc-unit" x="${L.padL - 6}" y="${L.top - 6}" text-anchor="end">${esc(hUnit)}</text>`;

    // bars
    const gap = Math.max(1, Math.min(2.5, hw * 0.35));
    s += '<g class="gc-bars">';
    for (let k = 0; k < nBars; k++) {
      const h = hourly[rep[k]];
      const x = xh(k * 3) + gap, bw = Math.max(1, Math.min(N, k * 3 + 3) - k * 3) * hw - gap * 2;
      const ymin = y(toHU(h.min || 0, units)), ymax = y(toHU(h.max || 0, units));
      const rc = `r${clamp(h.rating | 0, 0, 6)}`;
      if (L.bot - ymax < 1.2) {
        s += `<rect class="gc-bar ${rc}" x="${r1(x)}" y="${L.bot - 1.2}" width="${r1(bw)}" height="1.2"/>`;
        continue;
      }
      s += `<rect class="gc-cap ${rc}" x="${r1(x)}" y="${r1(ymax)}" width="${r1(bw)}" height="${r1(ymin - ymax)}"/>`;
      s += `<rect class="gc-bar ${rc}" x="${r1(x)}" y="${r1(ymin)}" width="${r1(bw)}" height="${r1(L.bot - ymin)}"/>`;
      s += `<line class="gc-captop ${rc}" x1="${r1(x)}" x2="${r1(x + bw)}" y1="${r1(ymax) + 0.5}" y2="${r1(ymax) + 0.5}"/>`;
    }
    s += '</g>';

    // wind row
    s += `<text class="gc-axis" x="${L.padL - 6}" y="${L.windY + 3.5}" text-anchor="end">wind</text>`;
    s += `<text class="gc-axis gc-unit" x="${L.padL - 6}" y="${L.spdY}" text-anchor="end">${esc(sUnit)}</text>`;
    const showSpd = 3 * hw >= 12;
    for (let k = 0; k < nBars; k++) {
      const j = Math.min(N - 1, k * 3 + 1);
      const w = hourly[j].wind;
      if (!w || !fin(w.speed)) continue;
      const cx = xh(k * 3) + 1.5 * hw;
      const kind = esc(w.kind || 'cross');
      const sc = r1(0.75 + clamp(w.speed / 14, 0, 1) * 0.55);
      if (w.kind === 'glassy' || w.speed < 0.5) {
        s += `<circle class="gc-wind wk-glassy" cx="${r1(cx)}" cy="${L.windY}" r="2.6"/>`;
      } else {
        s += `<path class="gc-wind wk-${kind}" transform="translate(${r1(cx)} ${L.windY}) rotate(${Math.round((w.dir || 0) + 180)}) scale(${sc})" d="M0,-7L3.6,0.5L0.9,-0.6L0.9,7L-0.9,7L-0.9,-0.6L-3.6,0.5Z"/>`;
      }
      if (showSpd) s += `<text class="gc-spd" x="${r1(cx)}" y="${L.spdY}" text-anchor="middle">${esc(numOf(fmtSpeed(w.speed, units)))}</text>`;
    }

    // selection layer
    s += `<g class="gc-cursor" style="display:none"><rect class="gc-selblock" y="${L.top - 2}" height="${L.spdY + 5 - L.top + 2}"/>` +
      `<line class="gc-cursorline" y1="${L.top - 2}" y2="${L.bot}"/><circle class="gc-cursordot" r="3"/></g>`;
    s += `<rect class="gc-hit" x="${L.padL}" y="0" width="${plotW}" height="${L.H}"/>`;
    s += '</svg>';

    const prevScroll = scroller.scrollLeft;
    scroller.innerHTML = s;
    scroller.scrollLeft = prevScroll;
    svg = scroller.firstChild;
    cur = svg.querySelector('.gc-cursor');
    bind();
    paint(false);
  }

  function summary() {
    const top = rep.reduce((a, j) => ((hourly[j].max || 0) > (hourly[a].max || 0) ? j : a), rep[0]);
    const h = hourly[top];
    return `Surf forecast, ${days.length} days, 3-hourly bars coloured by rating. Biggest: ${fmtRange(h.min || 0, h.max || 0, units)} ` +
      `${h.ratingLabel ? '(' + h.ratingLabel + ') ' : ''}on ${fmtDay(h.time)} ${fmtTime(h.time)}. Use arrow keys to step through hours.`;
  }

  function readoutText(i) {
    const h = hourly[i];
    let t = `${fmtDay(h.time)} ${fmtTime(h.time)} · ${fmtRange(h.min || 0, h.max || 0, units)}`;
    if (h.ratingLabel) t += ` · ${h.ratingLabel}`;
    if (h.wind && fin(h.wind.speed)) {
      t += ` · wind ${fmtSpeed(h.wind.speed, units)}`;
      if (h.wind.kind !== 'glassy') t += ` ${compass(h.wind.dir || 0)}`;
      if (h.wind.kind) t += ` ${h.wind.kind}`;
    }
    return t;
  }

  function paint(scroll) {
    if (!cur) return;
    if (sel < 0) { cur.style.display = 'none'; readout.textContent = ' '; return; }
    const { hw, xh, y } = geo;
    const k = Math.floor(sel / 3);
    const cx = hl(xh(sel) + hw / 2);
    cur.style.display = '';
    const blk = cur.querySelector('.gc-selblock');
    blk.setAttribute('x', r1(xh(k * 3)));
    blk.setAttribute('width', r1(Math.min(3, N - k * 3) * hw));
    const ln = cur.querySelector('.gc-cursorline');
    ln.setAttribute('x1', cx); ln.setAttribute('x2', cx);
    const dot = cur.querySelector('.gc-cursordot');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', r1(y(toHU(hourly[sel].max || 0, units))));
    readout.textContent = readoutText(sel);
    if (scroll && scroller.scrollWidth > scroller.clientWidth) {
      const scale = svg.getBoundingClientRect().width / geo.W;
      const px = cx * scale, pad = 48;
      if (px < scroller.scrollLeft + pad) scroller.scrollLeft = px - pad;
      else if (px > scroller.scrollLeft + scroller.clientWidth - pad) scroller.scrollLeft = px - scroller.clientWidth + pad;
    }
  }

  function setSel(i, notify, scroll) {
    i = clamp(i | 0, 0, N - 1);
    const changed = i !== sel;
    sel = i;
    paint(scroll);
    if (changed && notify && typeof onSelect === 'function') onSelect(i);
  }

  function hourAt(evt) {
    const rect = svg.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * (geo.W / rect.width);
    return Math.floor((x - L.padL) / geo.hw);
  }

  function bind() {
    const hit = svg.querySelector('.gc-hit');
    hit.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') setSel(hourAt(e), true, false); });
    hit.addEventListener('pointerdown', (e) => setSel(hourAt(e), true, false));
    svg.addEventListener('keydown', (e) => {
      const base = sel < 0 ? 0 : sel;
      let n = null;
      if (e.key === 'ArrowRight') n = base + (e.shiftKey ? 1 : 3);
      else if (e.key === 'ArrowLeft') n = base - (e.shiftKey ? 1 : 3);
      else if (e.key === 'PageDown' || e.key === 'ArrowDown') n = base + 24;
      else if (e.key === 'PageUp' || e.key === 'ArrowUp') n = base - 24;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = N - 1;
      if (n === null) return;
      e.preventDefault();
      setSel(n, true, true);
    });
  }

  mount(el, draw);
  return {
    select(i) { if (fin(i)) setSel(i, false, true); },
  };
}

// ======================================================================
// tideChart
// ======================================================================
export function tideChart(el, forecast, i0, i1, units, selected) {
  el.classList.add('gc', 'gc-tide');
  const time = (forecast && forecast.time) || [];
  const tide = (forecast && forecast.tide) || [];
  i0 = clamp(i0 | 0, 0, Math.max(0, time.length - 1));
  i1 = clamp(i1 == null ? time.length - 1 : i1 | 0, i0, Math.max(0, time.length - 1));
  let sel = fin(selected) ? selected : null;
  const H = 150, padL = 40, padR = 12, top = 30, bot = 124;

  const vals = tide.filter(fin);
  if (!vals.length || i1 <= i0) {
    el.innerHTML = `<div class="gc-empty">No tide data for this spot</div>`;
    return { select() {} };
  }

  // Global range keeps the scale steady from day to day.
  const gMin = Math.min(...vals), gMax = Math.max(...vals);
  const span = Math.max(0.2, gMax - gMin);
  const lo = gMin - span * 0.5, hiV = gMax + span * 0.32;

  // Extremes (refined with a parabola through neighbours).
  const ext = [];
  for (let k = Math.max(1, i0 - 1); k <= Math.min(tide.length - 2, i1 + 1); k++) {
    const a = tide[k - 1], b = tide[k], c = tide[k + 1];
    if (![a, b, c].every(fin)) continue;
    const isHi = b >= a && b > c, isLo = b <= a && b < c;
    if (!isHi && !isLo) continue;
    const den = a - 2 * b + c;
    const off = den ? clamp((a - c) / (2 * den), -0.5, 0.5) : 0;
    const t = k + off;
    if (t < i0 || t > i1) continue;
    ext.push({ t, h: b - ((a - c) * off) / 4, kind: isHi ? 'high' : 'low' });
  }

  let svg = null, geo = null;

  function draw(cw) {
    const W = Math.max(260, cw);
    const x = (t) => padL + ((t - i0) / (i1 - i0)) * (W - padL - padR);
    const y = (v) => bot - ((v - lo) / (hiV - lo)) * (bot - top);
    geo = { x, y, W };
    const dayLab = fmtDay(time[i0]);
    const label = `Tide, ${dayLab}: ` + (ext.length
      ? ext.map((e) => `${e.kind} ${fmtSigned(e.h, units)} at ${fmtTime(msIso(isoMs(time[i0]) + (e.t - i0) * 3600e3))}`).join(', ')
      : 'no turning points in range');
    let s = svgOpen(W, H, label, 'gc-tidesvg');

    // night shading from sunrise/sunset
    const t0ms = isoMs(time[i0]);
    const tOf = (iso) => i0 + (isoMs(iso) - t0ms) / 3600e3;
    for (const d of (forecast.daily || [])) {
      if (!d || !d.sunrise || !d.sunset) continue;
      const sr = tOf(d.sunrise), ss = tOf(d.sunset);
      const dayStart = tOf(d.date + 'T00:00'), dayEnd = dayStart + 24;
      for (const [a, b] of [[dayStart, sr], [ss, dayEnd]]) {
        const A = clamp(a, i0, i1), B = clamp(b, i0, i1);
        if (B - A > 0.01) s += `<rect class="gc-night" x="${r1(x(A))}" y="${top - 8}" width="${r1(x(B) - x(A))}" height="${bot - top + 8}"/>`;
      }
    }

    // gridlines in user units
    const uLo = toHU(lo, units), uHi = toHU(hiV, units);
    const st = niceStep(uHi - uLo, 3);
    for (let u = Math.ceil(uLo / st) * st; u <= uHi + 1e-9; u += st) {
      const yy = hl(y(heightIsFt(units) ? u / M_TO_FT : u));
      const zero = Math.abs(u) < st * 1e-6;
      s += `<line class="gc-grid${zero ? ' gc-msl' : ''}" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
      s += `<text class="gc-axis" x="${padL - 6}" y="${yy + 3.5}" text-anchor="end">${tickLabel(zero ? 0 : u)}</text>`;
    }
    s += `<text class="gc-axis gc-unit" x="${padL - 6}" y="${top - 14}" text-anchor="end">${esc(unitOf(fmtHeight(1, units)))}</text>`;

    // curve, split at gaps
    const segs = [];
    let curSeg = [];
    for (let k = i0; k <= i1; k++) {
      if (fin(tide[k])) curSeg.push([x(k), y(tide[k])]);
      else if (curSeg.length) { segs.push(curSeg); curSeg = []; }
    }
    if (curSeg.length) segs.push(curSeg);
    for (const sg of segs) {
      const p = smoothPath(sg);
      s += `<path class="gc-waterfill" d="${p}L${r1(sg[sg.length - 1][0])},${bot}L${r1(sg[0][0])},${bot}Z"/>`;
      s += `<path class="gc-tideline" d="${p}"/>`;
    }
    s += `<line class="gc-grid gc-base" x1="${padL}" x2="${W - padR}" y1="${hl(bot)}" y2="${hl(bot)}"/>`;

    // time ticks
    const every = W < 420 ? 6 : 3;
    for (let k = i0; k <= i1; k++) {
      const hr = +String(time[k]).slice(11, 13);
      if (hr % every) continue;
      const xx = hl(x(k));
      s += `<line class="gc-tick" x1="${xx}" x2="${xx}" y1="${bot}" y2="${bot + 3}"/>`;
      const anchor = k === i0 ? 'start' : k === i1 ? 'end' : 'middle';
      s += `<text class="gc-axis" x="${xx}" y="${bot + 15}" text-anchor="${anchor}">${esc(fmtTime(time[k]))}</text>`;
    }

    // highs / lows
    for (const e of ext) {
      const ex = x(e.t), ey = y(e.h);
      const anchor = ex < padL + 30 ? 'start' : ex > W - padR - 30 ? 'end' : 'middle';
      const tIso = msIso(isoMs(time[i0]) + (e.t - i0) * 3600e3);
      const hiK = e.kind === 'high';
      const ly = hiK ? ey - 16 : ey + 14;
      s += `<circle class="gc-ext" cx="${r1(ex)}" cy="${r1(ey)}" r="2.5"/>`;
      s += `<text class="gc-extlab" x="${r1(ex)}" y="${r1(ly)}" text-anchor="${anchor}">` +
        `<tspan class="gc-extk">${hiK ? 'H' : 'L'}</tspan> ${esc(fmtSigned(e.h, units))}</text>` +
        `<text class="gc-axis" x="${r1(ex)}" y="${r1(ly + 11)}" text-anchor="${anchor}">${esc(fmtTime(tIso))}</text>`;
    }

    // now marker (spot-local wall clock)
    const nowT = i0 + (Date.now() + (forecast.utcOffsetSeconds || 0) * 1000 - t0ms) / 3600e3;
    if (nowT >= i0 && nowT <= i1) {
      const nx = hl(x(nowT));
      s += `<line class="gc-now" x1="${nx}" x2="${nx}" y1="${top - 12}" y2="${bot}"/>` +
        `<text class="gc-nowlab" x="${nx + 4}" y="${top - 4}">now</text>`;
    }

    s += `<g class="gc-sel" style="display:none"><line class="gc-selline" y1="${top - 8}" y2="${bot}"/><circle class="gc-seldot" r="3.5"/></g>`;
    s += '</svg>';
    el.innerHTML = s;
    svg = el.firstChild;
    paintSel();
  }

  function paintSel() {
    const g = svg && svg.querySelector('.gc-sel');
    if (!g) return;
    if (sel == null || sel < i0 || sel > i1 || !fin(tide[Math.round(sel)])) { g.style.display = 'none'; return; }
    const k = Math.floor(sel), f = sel - k;
    const v = fin(tide[k + 1]) && f ? tide[k] + (tide[k + 1] - tide[k]) * f : tide[Math.round(sel)];
    const xx = hl(geo.x(sel));
    g.style.display = '';
    const ln = g.querySelector('line');
    ln.setAttribute('x1', xx); ln.setAttribute('x2', xx);
    const c = g.querySelector('circle');
    c.setAttribute('cx', xx); c.setAttribute('cy', r1(geo.y(v)));
  }

  mount(el, draw);
  return { select(i) { sel = fin(i) ? i : null; paintSel(); } };
}

// ======================================================================
// swellPolar
// ======================================================================
const KIND_LABEL = { swell: 'primary', swell2: 'secondary', windWave: 'wind sea' };

export function swellPolar(el, site, parts) {
  el.classList.add('gc', 'gc-polar');
  parts = (parts || []).filter((p) => p && fin(p.h) && p.h > 0.05);
  const S = 300, C = 150, R = 104;
  const pt = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return [C + r * Math.sin(a), C - r * Math.cos(a)];
  };
  const P = (deg, r) => pt(deg, r).map(r1).join(',');
  const hatchId = uid('hatch');
  const normal = fin(site && site.normal) ? site.normal : null;

  const label = 'Swell exposure rose' +
    (normal != null ? `; break faces ${compass(normal)} (${Math.round(normal)}°)` : '') +
    (parts.length ? '; ' + parts.map((p) => `${KIND_LABEL[p.kind] || p.kind} ${fmtHeight(p.h, { height: 'm' })} ${Math.round(p.t)} s from ${compass(p.dir)}`).join(', ') : '') +
    (site && site.blocked && site.blocked.length ? `; ${site.blocked.length} blocked sector${site.blocked.length > 1 ? 's' : ''}` : '');

  let s = svgOpen(S, S + 22, label, 'gc-polarsvg');
  s += `<defs><pattern id="${hatchId}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line class="gc-hatchline" x1="0" y1="0" x2="0" y2="5"/></pattern></defs>`;

  // blocked sectors (hatched wedges)
  for (const b of (site && site.blocked) || []) {
    let from = ((b.from % 360) + 360) % 360, to = ((b.to % 360) + 360) % 360;
    let sweep = (to - from + 360) % 360;
    if (sweep === 0 && b.to !== b.from) sweep = 360;
    if (sweep < 0.5) continue;
    if (sweep >= 359.5) {
      s += `<circle class="gc-blocked" cx="${C}" cy="${C}" r="${R}" fill="url(#${hatchId})"/>`;
      continue;
    }
    const large = sweep > 180 ? 1 : 0;
    s += `<path class="gc-blocked" fill="url(#${hatchId})" d="M${C},${C}L${P(from, R)}A${R},${R} 0 ${large} 1 ${P(from + sweep, R)}Z"/>`;
    s += `<path class="gc-blockedrim" d="M${P(from, R)}A${R},${R} 0 ${large} 1 ${P(from + sweep, R)}"/>`;
  }

  // rings and spokes
  for (const f of [1 / 3, 2 / 3]) s += `<circle class="gc-ring" cx="${C}" cy="${C}" r="${r1(R * f)}"/>`;
  for (let d = 0; d < 360; d += 45) s += `<line class="gc-spoke" x1="${C}" y1="${C}" x2="${pt(d, R)[0].toFixed(1)}" y2="${pt(d, R)[1].toFixed(1)}"/>`;

  // window area
  const win = site && site.window;
  if (win && win.length) {
    let d = '';
    const n = win.length, stepD = 360 / n;
    for (let i = 0; i < n; i++) d += (i ? 'L' : 'M') + P(i * stepD, R * clamp(win[i] || 0, 0, 1));
    s += `<path class="gc-window" d="${d}Z"/>`;
  }
  s += `<circle class="gc-ring gc-rim" cx="${C}" cy="${C}" r="${R}"/>`;

  // compass ticks and labels
  for (let d = 0; d < 360; d += 10) {
    const len = d % 90 === 0 ? 7 : d % 30 === 0 ? 5 : 2.5;
    const [x1, y1] = pt(d, R), [x2, y2] = pt(d, R + len);
    s += `<line class="gc-tick" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`;
  }
  for (const [d, t] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const [x, y] = pt(d, R + 16);
    s += `<text class="gc-cardinal" x="${r1(x)}" y="${r1(y + 4)}" text-anchor="middle">${t}</text>`;
  }

  // shore normal
  if (normal != null) {
    const [nx, ny] = pt(normal, R);
    s += `<line class="gc-normal" x1="${C}" y1="${C}" x2="${r1(nx)}" y2="${r1(ny)}"/>`;
    const [bx, by] = pt(normal + 180, R * 0.62);
    s += `<line class="gc-normal gc-normalback" x1="${C}" y1="${C}" x2="${r1(bx)}" y2="${r1(by)}"/>`;
    // label on the landward half, where arrows and window rarely are; kept upright
    const [lx, ly] = pt(normal + 180, R * 0.36);
    const rot = ((normal % 180) + 180) % 180 - 90;
    s += `<text class="gc-normallab" text-anchor="middle" transform="translate(${r1(lx)} ${r1(ly)}) rotate(${r1(rot)})" dy="-4">faces ${esc(compass(normal))}</text>`;
  }
  s += `<circle class="gc-centre" cx="${C}" cy="${C}" r="2"/>`;

  // partition arrows: tail on the rim at the from-direction, head toward the centre
  const hScale = Math.max(1.5, ...parts.map((p) => p.h));
  const order = [...parts].sort((a, b) => a.h - b.h);
  for (const p of order) {
    const L = clamp((p.h / hScale) * R * 0.9, 16, R * 0.92);
    const kind = esc(p.kind || 'swell');
    const sw = p.kind === 'swell' ? 2.6 : p.kind === 'swell2' ? 2 : 1.6;
    const [tx, ty] = pt(p.dir, R + 2), [hx, hy] = pt(p.dir, R + 2 - L);
    const head = 5 + sw * 1.4;
    const [bx, by] = pt(p.dir, R + 2 - L + head);
    const a = ((p.dir + 90) * Math.PI) / 180;
    const wx = Math.sin(a) * head * 0.55, wy = -Math.cos(a) * head * 0.55;
    s += `<g class="gc-part gk-${kind}">` +
      `<line x1="${r1(tx)}" y1="${r1(ty)}" x2="${r1(bx)}" y2="${r1(by)}" stroke-width="${sw}"/>` +
      `<path d="M${r1(hx)},${r1(hy)}L${r1(bx + wx)},${r1(by + wy)}L${r1(bx - wx)},${r1(by - wy)}Z"/>`;
    const [lx, ly] = pt(p.dir, R + 31);
    s += `<text class="gc-period" x="${r1(lx)}" y="${r1(ly + 3.5)}" text-anchor="middle">${Math.round(p.t)}s</text></g>`;
  }

  // legend
  const kinds = ['swell', 'swell2', 'windWave'].filter((k) => parts.some((p) => p.kind === k));
  const lw = (k) => 24 + KIND_LABEL[k].length * 6.2 + 10;
  let lx = C - kinds.reduce((a, k) => a + lw(k), 0) / 2;
  for (const k of kinds) {
    s += `<g class="gc-part gk-${k}"><line x1="${lx}" y1="${S + 10}" x2="${lx + 14}" y2="${S + 10}" stroke-width="2"/></g>` +
      `<text class="gc-axis" x="${lx + 18}" y="${S + 13.5}">${KIND_LABEL[k]}</text>`;
    lx += lw(k);
  }
  if (!parts.length) s += `<text class="gc-axis" x="${C}" y="${S + 13}" text-anchor="middle">no significant swell</text>`;
  s += '</svg>';
  if (el._gcRO) { el._gcRO.disconnect(); el._gcRO = null; }
  el.innerHTML = s;
}

// ======================================================================
// depthProfile
// ======================================================================
export function depthProfile(el, site, units) {
  el.classList.add('gc', 'gc-depth');
  const prof = ((site && site.profile) || []).filter((p) => p && fin(p.d) && fin(p.z)).sort((a, b) => a.d - b.d);
  if (prof.length < 2) {
    el.innerHTML = `<div class="gc-empty">No depth profile</div>`;
    return;
  }
  const ft = heightIsFt(units);
  const zU = (z) => (ft ? z * M_TO_FT : z);
  const zUnit = unitOf(fmtHeight(1, units)) || (ft ? 'ft' : 'm');
  const dMin = prof[0].d, dMax = prof[prof.length - 1].d;
  const zs = prof.map((p) => p.z);
  const zMinRaw = Math.min(-2, ...zs);
  const zMaxRaw = Math.max(2, ...zs);
  // Keep the water readable: let tall land clip off the top.
  const zTop = Math.min(zMaxRaw, Math.max(6, -zMinRaw * 0.9));
  const zSpan = zTop - zMinRaw;
  const zLo = zMinRaw - zSpan * 0.04, zHi = zTop + zSpan * 0.1;

  // surf point distance from coast along the profile
  let surfD = null, surfZ = null;
  if (site.surf && site.coast && fin(site.surf.lat)) {
    const dy = (site.surf.lat - site.coast.lat) * 111320;
    const dx = (site.surf.lon - site.coast.lon) * 111320 * Math.cos((site.coast.lat * Math.PI) / 180);
    surfD = Math.hypot(dx, dy);
    surfZ = fin(site.surf.depth) ? -Math.abs(site.surf.depth) : null;
  }
  if (surfD == null && site.surf && fin(site.surf.depth)) {
    const hit = prof.find((p) => p.d > 0 && p.z <= -Math.abs(site.surf.depth));
    if (hit) { surfD = hit.d; surfZ = -Math.abs(site.surf.depth); }
  }
  if (surfD != null && surfZ == null) {
    const near = prof.reduce((a, p) => (Math.abs(p.d - surfD) < Math.abs(a.d - surfD) ? p : a), prof[0]);
    surfZ = near.z;
  }

  const gradId = uid('wg'), clipId = uid('clip');
  const H = 180, padL = 44, padR = 14, top = 14, bot = 150;

  function draw(cw) {
    const W = Math.max(280, cw);
    const x = (d) => padL + ((d - dMin) / (dMax - dMin)) * (W - padL - padR);
    const y = (z) => top + ((zHi - z) / (zHi - zLo)) * (bot - top);
    const exag = ((bot - top) / (zHi - zLo)) / ((W - padL - padR) / (dMax - dMin));

    const label = `Depth profile along the shore normal, ${Math.round(dMin)} to ${Math.round(dMax)} m from the coast; ` +
      `deepest ${fmtHeight(-zMinRaw, units)}` +
      (surfD != null ? `; surf point ${Math.round(surfD)} m offshore at ${fmtHeight(Math.abs(surfZ), units)} depth` : '');
    let s = svgOpen(W, H, label, 'gc-depthsvg');
    s += `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" style="stop-color:var(--water-1)"/><stop offset="0.5" style="stop-color:var(--water-2)"/>` +
      `<stop offset="1" style="stop-color:var(--water-3)"/></linearGradient>` +
      `<clipPath id="${clipId}"><rect x="${padL}" y="${top}" width="${W - padL - padR}" height="${bot - top}"/></clipPath></defs>`;

    // depth gridlines in user units
    const uLo = zU(zLo), uHi = zU(zHi);
    const st = niceStep(uHi - uLo, 4);
    const grid = [];
    for (let u = Math.ceil(uLo / st) * st; u <= uHi + 1e-9; u += st) grid.push(u);

    s += `<g clip-path="url(#${clipId})">`;
    s += `<rect class="gc-waterbody" x="${padL}" y="${r1(y(0))}" width="${W - padL - padR}" height="${r1(bot - y(0))}" fill="url(#${gradId})"/>`;
    let g = `M${r1(x(dMin))},${bot + 2}`;
    for (const p of prof) g += `L${r1(x(p.d))},${r1(y(p.z))}`;
    g += `L${r1(x(dMax))},${bot + 2}Z`;
    s += `<path class="gc-land" d="${g}"/>`;
    let ln = '';
    prof.forEach((p, i) => { ln += (i ? 'L' : 'M') + r1(x(p.d)) + ',' + r1(y(p.z)); });
    s += `<path class="gc-ground" d="${ln}"/>`;
    for (const u of grid) {
      if (Math.abs(u) < st * 1e-6) continue;
      const yy = hl(y(ft ? u / M_TO_FT : u));
      s += `<line class="gc-grid gc-gridover" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
    }
    s += '</g>';
    for (const u of grid) {
      const yy = hl(y(ft ? u / M_TO_FT : u));
      s += `<text class="gc-axis" x="${padL - 6}" y="${yy + 3.5}" text-anchor="end">${tickLabel(Math.abs(u) < st * 1e-6 ? 0 : u)}</text>`;
    }
    s += `<text class="gc-axis gc-unit" x="${padL - 6}" y="${top - 3}" text-anchor="end">${esc(zUnit)}</text>`;

    // sea level
    const y0 = hl(y(0));
    s += `<line class="gc-sealevel" x1="${padL}" x2="${W - padR}" y1="${y0}" y2="${y0}"/>`;
    s += `<text class="gc-axis gc-sealab" x="${W - padR - 2}" y="${y0 - 4}" text-anchor="end">sea level</text>`;

    // coast
    if (dMin < 0 && dMax > 0) {
      const cx = hl(x(0));
      s += `<line class="gc-coast" x1="${cx}" x2="${cx}" y1="${y0 - 6}" y2="${y0 + 6}"/>`;
    }

    // surf point
    if (surfD != null && surfD >= dMin && surfD <= dMax) {
      const sx = hl(x(surfD)), sy = r1(y(surfZ));
      s += `<line class="gc-surfline" x1="${sx}" x2="${sx}" y1="${y0}" y2="${sy}"/>`;
      s += `<circle class="gc-surfpt" cx="${sx}" cy="${sy}" r="3.5"/>`;
      const right = sx < W - padR - 120;
      s += `<text class="gc-surflab" x="${right ? sx - 2 : sx + 2}" y="${y0 - 5}" text-anchor="${right ? 'start' : 'end'}">` +
        `surf point · ${esc(fmtHeight(Math.abs(surfZ), units))}</text>`;
    }

    // distance axis
    s += `<line class="gc-grid gc-base" x1="${padL}" x2="${W - padR}" y1="${hl(bot)}" y2="${hl(bot)}"/>`;
    const metricKm = !ft && dMax - dMin > 1500;
    const conv = (m) => (ft ? m * M_TO_MI : metricKm ? m / 1000 : m);
    const dUnit = ft ? 'mi' : metricKm ? 'km' : 'm';
    const dLo = conv(dMin), dHi = conv(dMax);
    const dst = niceStep(dHi - dLo, Math.max(3, Math.min(8, Math.floor((W - padL - padR) / 70))));
    for (let u = Math.ceil(dLo / dst) * dst; u <= dHi + 1e-9; u += dst) {
      const m = ft ? u / M_TO_MI : metricKm ? u * 1000 : u;
      const xx = hl(x(m));
      s += `<line class="gc-tick" x1="${xx}" x2="${xx}" y1="${bot}" y2="${bot + 3}"/>`;
      s += `<text class="gc-axis" x="${xx}" y="${bot + 14}" text-anchor="middle">${tickLabel(Math.abs(u) < dst * 1e-6 ? 0 : u)}</text>`;
    }
    s += `<text class="gc-axis gc-unit" x="${W - padR}" y="${bot + 27}" text-anchor="end">${dUnit} from coast → offshore</text>`;
    s += `<text class="gc-axis gc-exag" x="${padL}" y="${bot + 27}">vertical ×${Math.round(exag)}</text>`;
    s += '</svg>';
    el.innerHTML = s;
  }

  mount(el, draw);
}
