// Glassy — geo worker (module worker). Protocol (docs/CONTRACTS.md):
//   in : {id, type: 'analyze'|'refExposure'|'scene', lat, lon}
//   out: {id, ok: true, result} | {id, ok: false, error}   (typed arrays transferred)
//   out: {type: 'bytes', n}  (terrain bytes downloaded, forwarded to net.addBytes)
import {
  createTileSource, browserFetchTile, locate, analyzeSite, referenceExposure, sceneData,
} from './terrain.js';

const src = createTileSource(browserFetchTile((n) => self.postMessage({ type: 'bytes', n })));

// cache of locate() results (grids + coast/surf), keyed by rounded input point
const locCache = new Map();
function getLoc(lat, lon) {
  const k = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  let p = locCache.get(k);
  if (!p) {
    p = locate(src, lat, lon).catch((e) => { locCache.delete(k); throw e; });
    locCache.set(k, p);
    if (locCache.size > 6) locCache.delete(locCache.keys().next().value);
  }
  return p;
}

self.onmessage = async (ev) => {
  const { id, type, lat, lon } = ev.data || {};
  if (id === undefined) return;
  try {
    let result, transfer = [];
    if (type === 'analyze') {
      result = await analyzeSite(src, lat, lon, await getLoc(lat, lon));
      transfer = [result.kd2.buffer, result.window.buffer];
    } else if (type === 'refExposure') {
      result = await referenceExposure(src, lat, lon);
      transfer = [result.buffer];
    } else if (type === 'scene') {
      result = await sceneData(src, lat, lon, await getLoc(lat, lon));
      transfer = [result.elev.buffer];
    } else {
      throw new Error(`Unknown request type: ${type}`);
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
