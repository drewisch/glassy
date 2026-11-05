// Open-Meteo (marine + weather + geocoding) and Nominatim access.
import { fetchCounted } from './net.js';

const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const WEATHER = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

const MARINE_VARS = [
  'wave_height',
  'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
  'secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction',
  'wind_wave_height', 'wind_wave_period', 'wind_wave_direction',
  'sea_level_height_msl', 'sea_surface_temperature',
].join(',');
const WEATHER_VARS = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,weather_code';

const TTL = 30 * 60 * 1000;
const cache = new Map(); // key -> {t, p: Promise}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with a couple of retries on network errors, 429 and 5xx. */
async function getJSON(url, { retries = 2, headers } = {}) {
  let lastErr;
  for (let a = 0; a <= retries; a++) {
    if (a) await sleep(500 * a * a);
    try {
      const res = await fetchCounted(url, headers ? { headers } : undefined);
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (res.ok && body && !body.error) return body;
      const reason = (body && body.reason) || `HTTP ${res.status}`;
      lastErr = new Error(reason);
      lastErr.status = res.status;
      if (!(res.status === 429 || res.status >= 500)) break; // client error: don't retry
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Request failed');
}

const num = (v) => (v == null || !Number.isFinite(+v) ? null : +v);
const part = (h, t, d) => ({ h: num(h) ?? 0, t: num(t) ?? 0, dir: num(d) ?? 0 });

function cached(key, make) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.t < TTL) return hit.p;
  const p = make();
  cache.set(key, { t: now, p });
  p.catch(() => { if (cache.get(key)?.p === p) cache.delete(key); });
  // keep the cache small
  if (cache.size > 40) {
    for (const [k, v] of cache) if (now - v.t >= TTL) cache.delete(k);
  }
  return p;
}

/** Hourly 8-day forecast for a point. See docs/CONTRACTS.md `Forecast`. */
export function getForecast(lat, lon) {
  const la = (+lat).toFixed(3);
  const lo = (+lon).toFixed(3);
  return cached(`fc:${la},${lo}`, () => loadForecast(la, lo));
}

async function loadForecast(la, lo) {
  const common = `latitude=${la}&longitude=${lo}&forecast_days=8&timezone=auto`;
  // The marine model is optional: in California the swell comes from CDIP MOP and only the
  // water temperature is taken from here, so a failed marine call shouldn't sink the page.
  const [m, w] = await Promise.all([
    getJSON(`${MARINE}?${common}&cell_selection=sea&hourly=${MARINE_VARS}`).catch((err) => { console.warn('marine', err); return null; }),
    getJSON(`${WEATHER}?${common}&hourly=${WEATHER_VARS}&daily=sunrise,sunset&wind_speed_unit=ms`),
  ]);
  const mh = m?.hourly || {};
  const wh = w.hourly || {};
  const time = mh.time || wh.time || [];
  const wIdx = new Map((wh.time || []).map((t, i) => [t, i]));

  const swell = [], swell2 = [], windWave = [], waveHeight = [], tide = [], sst = [];
  const wind = [], airTemp = [], weatherCode = [];
  for (let i = 0; i < time.length; i++) {
    swell.push(part(mh.swell_wave_height?.[i], mh.swell_wave_period?.[i], mh.swell_wave_direction?.[i]));
    swell2.push(part(mh.secondary_swell_wave_height?.[i], mh.secondary_swell_wave_period?.[i], mh.secondary_swell_wave_direction?.[i]));
    windWave.push(part(mh.wind_wave_height?.[i], mh.wind_wave_period?.[i], mh.wind_wave_direction?.[i]));
    waveHeight.push(num(mh.wave_height?.[i]) ?? 0);
    tide.push(num(mh.sea_level_height_msl?.[i]));
    sst.push(num(mh.sea_surface_temperature?.[i]));
    const j = wIdx.get(time[i]);
    if (j == null) {
      wind.push({ speed: 0, gust: 0, dir: 0 });
      airTemp.push(null);
      weatherCode.push(null);
    } else {
      wind.push({
        speed: num(wh.wind_speed_10m?.[j]) ?? 0,
        gust: num(wh.wind_gusts_10m?.[j]) ?? 0,
        dir: num(wh.wind_direction_10m?.[j]) ?? 0,
      });
      airTemp.push(num(wh.temperature_2m?.[j]));
      weatherCode.push(num(wh.weather_code?.[j]));
    }
  }
  const d = w.daily || {};
  const daily = (d.time || []).map((date, i) => ({ date, sunrise: d.sunrise?.[i] || null, sunset: d.sunset?.[i] || null }));

  return {
    ref: m ? { lat: m.latitude, lon: m.longitude } : null,
    marine: !!m,
    timezone: m?.timezone || w.timezone,
    utcOffsetSeconds: m?.utc_offset_seconds ?? w.utc_offset_seconds ?? 0,
    time, swell, swell2, windWave, waveHeight, tide, sst, wind, airTemp, weatherCode, daily,
  };
}

/** Place search -> [{name, admin, country, lat, lon}] (max 6). */
export async function geocode(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const j = await getJSON(`${GEOCODE}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`, { retries: 1 });
  return (j.results || []).map((r) => ({
    name: r.name,
    admin: r.admin1 || r.admin2 || '',
    country: r.country || r.country_code || '',
    lat: r.latitude,
    lon: r.longitude,
  }));
}

/** Reverse geocode via Nominatim (zoom 12). Never throws. */
export async function reverseGeocode(lat, lon) {
  try {
    const j = await getJSON(
      `${NOMINATIM}?format=jsonv2&lat=${(+lat).toFixed(5)}&lon=${(+lon).toFixed(5)}&zoom=12&accept-language=en`,
      { retries: 0 },
    );
    const a = j.address || {};
    const name = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality
      || a.county || j.name || a.state || 'Dropped pin';
    return { name, region: a.state || a.region || a.county || '', country: a.country || '' };
  } catch (e) {
    return { name: 'Dropped pin', region: '', country: '' };
  }
}

/**
 * Current primary + secondary swell at the sea cell nearest a point ->
 * {primary: {h,t,dir}|null, secondary: {h,t,dir}|null}. Cached 30 min per 0.25° cell.
 */
export async function currentSwellAt(lat, lon) {
  const q = (v) => (Math.round(v * 4) / 4).toFixed(2);
  const la = q(+lat), lo = q(((((+lon + 180) % 360) + 360) % 360) - 180);
  const vars = ['', 'secondary_'].map((p) => `${p}swell_wave_height,${p}swell_wave_period,${p}swell_wave_direction`).join(',');
  const j = await cached(`cs:${la},${lo}`, () => getJSON(`${MARINE}?latitude=${la}&longitude=${lo}&cell_selection=sea&current=${vars}`, { retries: 1 }));
  const c = j.current || {};
  const get = (p) => {
    const h = num(c[`${p}swell_wave_height`]);
    return h > 0 ? { h, t: num(c[`${p}swell_wave_period`]) ?? 0, dir: num(c[`${p}swell_wave_direction`]) ?? 0 } : null;
  };
  return { primary: get(''), secondary: get('secondary_') };
}

/** Current primary swell for many points in one multi-location request -> [{h,t,dir}|null]. */
export async function currentSwellMany(points) {
  const out = new Array(points.length).fill(null);
  for (let s = 0; s < points.length; s += 60) {
    const chunk = points.slice(s, s + 60);
    if (!chunk.length) continue;
    const lats = chunk.map((p) => (+p.lat).toFixed(3)).join(',');
    const lons = chunk.map((p) => (+p.lon).toFixed(3)).join(',');
    const url = `${MARINE}?latitude=${lats}&longitude=${lons}&cell_selection=sea`
      + '&current=swell_wave_height,swell_wave_period,swell_wave_direction';
    const key = `cur:${lats}|${lons}`;
    let j;
    try {
      j = await cached(key, () => getJSON(url, { retries: 1 }));
    } catch (e) {
      continue;
    }
    const arr = Array.isArray(j) ? j : [j];
    arr.forEach((r, k) => {
      const c = r && r.current;
      const idx = s + (r && Number.isInteger(r.location_id) ? r.location_id : k);
      if (!c || idx >= out.length) return;
      const h = num(c.swell_wave_height);
      if (h == null) return;
      out[idx] = { h, t: num(c.swell_wave_period) ?? 0, dir: num(c.swell_wave_direction) ?? 0 };
    });
  }
  return out;
}
