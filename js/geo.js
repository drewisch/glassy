// Glassy — main-thread wrapper around the geo worker.
import { addBytes } from './net.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./geo.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'bytes') { try { addBytes(m.n); } catch { /* ignore */ } return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || 'Terrain analysis failed'));
  };
  worker.onerror = (ev) => {
    const err = new Error((ev && ev.message) || 'Terrain worker failed');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  };
  return worker;
}

function call(type, lat, lon) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, type, lat: +lat, lon: +lon });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

/** Promise<Site> */
export function analyzeSite(lat, lon) { return call('analyze', lat, lon); }
/** Promise<Float32Array(180)> openness per 2° from-direction bin */
export function referenceExposure(lat, lon) { return call('refExposure', lat, lon); }
/** Promise<SceneData> */
export function sceneData(lat, lon) { return call('scene', lat, lon); }
