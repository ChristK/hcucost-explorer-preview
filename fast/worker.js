// =============================================================================
// web-fast/worker.js - a background worker of the R-free explorer (2026-11-08): holds one calculation
// engine (engine.js on the WebAssembly core) and answers the page's requests, so the page itself never
// waits for a calculation. Messages: {id, fn: "meta" | "predict" | "spread", req} -> {id, result} or
// {id, error}. The page runs several workers at once (app.js, WorkerPool).
// =============================================================================
import { createEngine } from './engine.js';

const base = new URL('./', self.location.href);
const files = {
  json: async (p) => { const r = await fetch(new URL(p, base)); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); },
  bytes: async (p) => { const r = await fetch(new URL(p, base)); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.arrayBuffer(); },
};
const ready = createEngine(files, new URL('hcucore.wasm', base).href);

self.onmessage = async (ev) => {
  const { id, fn, req } = ev.data;
  try {
    const engine = await ready;
    const result = fn === 'meta' ? await engine.meta(req) : fn === 'spread' ? await engine.spread(req) : await engine.predict(req);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message ? e.message : e) });
  }
};
