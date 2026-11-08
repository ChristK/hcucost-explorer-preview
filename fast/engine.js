// =============================================================================
// web-fast/engine.js - the R-free calculation engine of the web explorer (2026-11-08).
//
// A JavaScript port of what the webR page does in R, on the package's C++ core compiled to WebAssembly
// (hcucore.mjs, from core/hcucore.cpp) and the models exported by export_models.R:
//   meta(period)      = hcuweb_meta()    (web/hcucost_web.R)
//   predict(request)  = hcuweb_predict() = hcu_predict(method = "expected") with the page's budgets
//   spread(request)   = hcuweb_spread()  = hcu_predict(type = "draws") summarised
// The port follows R/predict.R step by step - the model of each record (known_groups()), the fill-in
// (fill_in_core()), the completed records and their placeholders, the death-group weights or draws, the
// random-number keys, the expected values or simulated years, and the averaging and standard errors - so
// that, with the same seed, it gives hcu_predict()'s numbers (checked by test/run_check.sh).
// Works in a browser, a web worker or Node.js: the caller supplies how to read files.
// =============================================================================
import createHcuCore from './hcucore.mjs';
import { rRunif } from './rng_r.js';

const SETS = ['ASRDN', 'A', 'AS', 'ASR', 'AR', 'AN'];
const SMOK = ['never', 'ex', 'current'];
const NA = null;
const isNA = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
const INT_NA = -2147483648;   // R's NA_integer_ (the core's NA_COUNT)

// ---- small numerical helpers, as R computes them ---------------------------------------------------------
function haltonPoints(m, K) {   // hcucost:::halton_points(): column-major m x K
  const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
  const H = new Float64Array(m * K);
  for (let k = 0; k < K; k++) {
    const b = primes[k];
    for (let i = 1; i <= m; i++) {
      let r = 0;
      let f = 1 / b;
      let j = i;
      while (j > 0) { r += f * (j % b); j = Math.floor(j / b); f /= b; }
      H[(i - 1) + m * k] = r;
    }
  }
  return H;
}
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
function variance(x) {   // stats::var(): n - 1 denominator
  if (x.length < 2) return NaN;
  const m = mean(x);
  return x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1);
}
function quantile7(x, probs) {   // stats::quantile(type = 7)
  const s = Float64Array.from(x).sort();
  const n = s.length;
  return probs.map((p) => {
    const index = 1 + (n - 1) * p;
    const lo = Math.floor(index);
    const hi = Math.ceil(index);
    const qs = s[lo - 1];
    if (index > lo && s[hi - 1] !== qs) { const h = index - lo; return (1 - h) * qs + h * s[hi - 1]; }
    return qs;
  });
}

// ---- the engine ------------------------------------------------------------------------------------------
// files: { json(path) -> object, bytes(path) -> ArrayBuffer } relative to the folder holding models/;
// wasmUrl: where hcucore.wasm is (browser; Node finds it next to hcucore.mjs)
export async function createEngine(files, wasmUrl) {
  const core = await createHcuCore(wasmUrl ? { locateFile: (f) => (f.endsWith('.wasm') ? wasmUrl : f) } : {});
  const periods = {};

  async function index(p) {
    if (!['CY', 'FY'].includes(p)) throw new Error('period must be CY or FY');
    if (!periods[p]) periods[p] = { index: await files.json(`models/${p}/index.json`), loaded: {} };
    return periods[p];
  }
  // a model's structure with its numbers ({"@": offset, "n": length} -> Float64Array views of the .bin)
  async function ensureModel(p, set) {
    const P = await index(p);
    if (!P.loaded[set]) {
      P.loaded[set] = (async () => {
        const [struct, buf] = await Promise.all([files.json(`models/${p}/${set}.json`), files.bytes(`models/${p}/${set}.bin`)]);
        const decode = (v) => {
          if (Array.isArray(v)) return v.map(decode);
          if (v && typeof v === 'object') {
            if ('@' in v && 'n' in v) return new Float64Array(buf, v['@'] * 8, v.n);
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
          }
          return v;
        };
        core.load_model(`${p}/${set}`, decode(struct));
        return true;
      })();
    }
    return P.loaded[set];
  }
  // the models a set of records needs (for a page that loads only what it uses)
  async function ensureFor(p, sets) { await Promise.all([...new Set(sets)].map((s) => ensureModel(p, s))); }

  async function meta(p) {
    const ix = (await index(p)).index;
    return { period: p, package_version: ix.package_version, model_version: ix.model_version, reference_year: ix.reference_year,
             price_year: ix.price_year, status: ix.status, age_range: ix.age_range, dimd: ix.dimd, ethnicity: ix.ethnicity,
             sha: ix.sha, diseases: ix.diseases };
  }

  // hcu_predict() for one period with all six models; method "expected" (type "mean") or type "draws"
  // (simulated years); options: n_draws, n_points, n_shifts, burn_in, thin, seed, key
  async function predictCore(p, newdata, { type = 'mean', n_draws = 20, n_points = 16384, n_shifts = 8, burn_in = 10, thin = 2,
                                         seed = 1, key = null } = {}) {
    const ix = (await index(p)).index;
    const dz = ix.diseases.map((d) => d.name);
    const D = dz.length;
    const ks = ix.components;
    const counts0 = ix.counts;
    const K = ks.length;
    // records in hcu_predict()'s layout: unknown = NA
    const x = newdata.map((r, i) => {
      if (isNA(r.age) || isNA(r.sex)) throw new Error('age and sex must be known');
      if (!['men', 'women'].includes(r.sex)) throw new Error('sex must be "men" or "women"');
      const rec = { row: i + 1, age: Number(r.age), sex: r.sex };
      for (const v of ['dimd', 'ethnicity', 'sha', 'smok']) rec[v] = isNA(r[v]) ? NA : String(r[v]);
      rec.bmi = isNA(r.bmi) ? NA : Number(r.bmi);
      rec.prvl = dz.map((d) => (isNA(r[`${d}_prvl`]) ? NA : Math.trunc(Number(r[`${d}_prvl`]))));
      for (const v of ['ncond', 'died', 'dies_next']) rec[v] = isNA(r[v]) ? NA : Math.trunc(Number(r[v]));
      for (const [v, lev] of [['dimd', ix.dimd], ['ethnicity', ix.ethnicity], ['sha', ix.sha]]) {
        if (rec[v] !== NA && !lev.includes(rec[v])) throw new Error(`${v}: values not in the model: ${rec[v]}`);
      }
      if (rec.smok !== NA && !SMOK.includes(rec.smok)) throw new Error('smok must be never, ex or current');
      if ((rec.died === NA) !== (rec.dies_next === NA)) throw new Error('give both died and dies_next, or neither');
      return rec;
    });
    const rkey = key ? key.map(Number) : x.map((r) => r.row);
    // ---- the model of each record (known_groups())
    for (const r of x) {
      const dKnown = r.prvl.filter((v) => v !== NA && v !== -1).length;
      const dMinus = r.prvl.filter((v) => v === -1).length;
      const sK = (r.dimd !== NA) + (r.ethnicity !== NA) + (r.sha !== NA);
      const rK = (r.bmi !== NA) + (r.smok !== NA);
      const hasD = dKnown === D;
      const hasN = hasD || r.ncond !== NA;
      const k = `A${sK === 3 ? 'S' : ''}${rK === 2 ? 'R' : ''}${hasD ? 'D' : ''}${hasN ? 'N' : ''}`;
      const partial = (sK > 0 && sK < 3) || rK === 1 || (!hasD && (dKnown > 0 || dMinus > 0));
      r.use = !partial && SETS.includes(k) ? k : 'ASRDN';
      if ((k === 'ASRDN' || k === 'ASRD') && !partial) r.use = 'ASRDN';
      r.filled = r.use === 'ASRDN' && k !== 'ASRDN' && k !== 'ASRD';
    }
    await ensureFor(p, x.map((r) => r.use));

    // ---- completed records (row, draw): filled-in draws first, then the exact records
    const comp = [];
    const filled = x.filter((r) => r.filled);
    if (filled.length) {
      // fill_in_core(): the consistency check, then the core's sampler
      for (const r of filled) {
        const kp = r.prvl.filter((v) => v !== NA && (v > 0 || v === -1)).length;
        const nu = r.prvl.filter((v) => v === NA).length;
        if (r.ncond !== NA && (r.ncond < kp || r.ncond > kp + nu)) throw new Error('ncond is inconsistent with the known diseases for some records');
      }
      const code = (v, lev) => (v === NA ? 0 : lev.indexOf(v) + 1);
      const recs = {
        age: Float64Array.from(filled, (r) => r.age), sex: Int32Array.from(filled, (r) => (r.sex === 'men' ? 1 : 2)),
        dimd: Int32Array.from(filled, (r) => code(r.dimd, ix.dimd)), eth: Int32Array.from(filled, (r) => code(r.ethnicity, ix.ethnicity)),
        sha: Int32Array.from(filled, (r) => code(r.sha, ix.sha)), smok: Int32Array.from(filled, (r) => code(r.smok, SMOK)),
        bmi: Float64Array.from(filled, (r) => (r.bmi === NA ? NaN : r.bmi)),
        prvl: dz.map((_, j) => Int32Array.from(filled, (r) => (r.prvl[j] === NA ? INT_NA : r.prvl[j]))),
        K: Int32Array.from(filled, (r) => (r.ncond === NA ? -1 : r.ncond)),
        g: Int32Array.from(filled, (r) => (r.died === NA || r.dies_next === NA ? -1 : r.died === 1 ? 2 : r.dies_next === 1 ? 1 : 0)),
      };
      const f = core.fill_in(`${p}/ASRDN`, recs, n_draws, burn_in, thin, seed,
                             Float64Array.from(filled, (r) => rkey[r.row - 1]));
      const nf = filled.length;
      for (let k = 0; k < n_draws; k++) {          // R: draws stacked draw by draw
        for (let i = 0; i < nf; i++) {
          const r = filled[i];
          const at = i * n_draws + k;                // the core's record-major output
          const prvl = dz.map((_, j) => f.prvl[j][at]);
          comp.push({ row: r.row, draw: k + 1, model: 'ASRDN', age: r.age, sex: r.sex, dimd: ix.dimd[f.dimd[at] - 1],
                      ethnicity: ix.ethnicity[f.eth[at] - 1], sha: ix.sha[f.sha[at] - 1], bmi: f.bmi[at],
                      smok: SMOK[f.smok[at] - 1], prvl, died: r.died, dies_next: r.dies_next,
                      ncond: prvl.filter((v) => v > 0).length });
        }
      }
    }
    const exact = x.filter((r) => !r.filled);
    const reps = type === 'draws' ? n_draws : 1;
    for (let dr = 1; dr <= reps; dr++) {
      for (const r of exact) {
        comp.push({ row: r.row, draw: dr, model: r.use, age: r.age, sex: r.sex, dimd: r.dimd, ethnicity: r.ethnicity, sha: r.sha,
                    bmi: r.bmi, smok: r.smok, prvl: r.prvl.slice(), died: r.died, dies_next: r.dies_next, ncond: r.ncond });
      }
    }
    // placeholders for predictors a reduced model does not use; AN: ncond conditions on the first diseases
    for (const c of comp) {
      if (c.dimd === NA) c.dimd = ix.dimd[0];
      if (c.ethnicity === NA) c.ethnicity = ix.ethnicity[0];
      if (c.sha === NA) c.sha = ix.sha[0];
      if (c.bmi === NA) c.bmi = 25;
      if (c.smok === NA) c.smok = 'never';
      c.prvl = c.prvl.map((v, j) => {
        let w = v;
        if (c.model === 'AN') w = (j + 1 <= c.ncond ? 1 : 0);
        return w === NA || w < 0 ? 0 : w;
      });
    }
    comp.forEach((c, i) => { c.cid = i + 1; c.ckey = key ? rkey[c.row - 1] * (n_draws + 1) + c.draw : c.cid; });

    // core inputs of a list of completed records
    const rowsOf = (cs) => ({
      age: Float64Array.from(cs, (c) => c.age), sex: Int32Array.from(cs, (c) => (c.sex === 'men' ? 1 : 2)),
      dimd: Int32Array.from(cs, (c) => ix.dimd.indexOf(c.dimd) + 1), eth: Int32Array.from(cs, (c) => ix.ethnicity.indexOf(c.ethnicity) + 1),
      sha: Int32Array.from(cs, (c) => ix.sha.indexOf(c.sha) + 1), smok: Int32Array.from(cs, (c) => SMOK.indexOf(c.smok) + 1),
      bmi: Float64Array.from(cs, (c) => c.bmi), prvl: dz.map((_, j) => Int32Array.from(cs, (c) => c.prvl[j])),
      died: Int32Array.from(cs, (c) => c.died ?? 0), dies_next: Int32Array.from(cs, (c) => c.dies_next ?? 0),
    });

    // ---- death groups: known (weight 1), or all three weighted by the model's death model / one drawn
    const dk = comp.filter((c) => c.died !== NA).map((c) => ({ ...c, w: 1 }));
    const du = comp.filter((c) => c.died === NA);
    let duRows = [];
    if (du.length) {
      const pg = new Float64Array(du.length * 3);
      for (const s of [...new Set(du.map((c) => c.model))]) {
        const idx = du.map((c, i) => (c.model === s ? i : -1)).filter((i) => i >= 0);
        const pr = core.death_probs(`${p}/${s}`, rowsOf(idx.map((i) => du[i])));
        idx.forEach((i, j) => { for (let g = 0; g < 3; g++) pg[i * 3 + g] = pr[j * 3 + g]; });
      }
      if (type === 'mean') {
        for (let g = 0; g < 3; g++) du.forEach((c, i) => duRows.push({ ...c, died: g === 2 ? 1 : 0, dies_next: g === 1 ? 1 : 0, w: pg[i * 3 + g] }));
      } else {
        const u = rRunif(seed, du.length);
        duRows = du.map((c, i) => {
          const gg = (u[i] > pg[i * 3]) + (u[i] > pg[i * 3] + pg[i * 3 + 1]);
          return { ...c, died: gg === 2 ? 1 : 0, dies_next: gg === 1 ? 1 : 0, w: 1 };
        });
      }
    }
    const all = dk.concat(duRows);
    const models = [...new Set(all.map((c) => c.model))];
    const persistence = Object.fromEntries(SETS.map((s) => [s, ix.models[s].persistence]));

    if (type === 'draws') {   // one simulated year per completed record and drawn death group
      const out = [];
      for (const s of models) {
        const cs = all.filter((c) => c.model === s);
        const pid = key ? Float64Array.from(cs, (c) => c.ckey) : Float64Array.from(cs, (_, i) => i + 1);
        const sim = core.simulate(`${p}/${s}`, rowsOf(cs), pid, ix.ref_year, seed, persistence[s]);
        cs.forEach((c, i) => {
          const o = { row: c.row, draw: c.draw, model: s };
          let tot = 0;
          for (let k = 0; k < K; k++) {
            o[counts0[k]] = sim.counts[i + cs.length * k];
            o[`${ks[k]}_costs`] = sim.costs[i + cs.length * k];
            tot += sim.costs[i + cs.length * k];
          }
          o.healthcare_use_costs = tot;
          out.push(o);
        });
      }
      return out.sort((a, b) => a.row - b.row || a.draw - b.draw);
    }

    // ---- expected values (expected_core()) of each completed record and death group
    const vals = [...counts0, ...ks.map((k) => `${k}_costs`), 'healthcare_use_costs'];
    const perDraw = new Map();   // "row|draw" -> { row, draw, model, sums..., shifts }
    for (const s of models) {
      const cs = all.filter((c) => c.model === s);
      const m = ix.models[s];
      const m01 = Math.ceil(n_points / n_shifts);
      const m2 = Math.max(16, Math.ceil((3 * m01) / m.prop_x.length));
      const mAll = Math.max(m01, m2);
      const res = core.expected(`${p}/${s}`, rowsOf(cs), Float64Array.from(cs, (c) => c.ckey), haltonPoints(mAll, K), m01, m2,
                                Float64Array.from(m.prop_x), Float64Array.from(m.prop_w), seed, n_shifts, persistence[s]);
      const n = cs.length;
      cs.forEach((c, i) => {
        const id = `${c.row}|${c.draw}`;
        if (!perDraw.has(id)) perDraw.set(id, { row: c.row, draw: c.draw, model: s, v: new Float64Array(vals.length), sh: new Float64Array(n_shifts) });
        const pd = perDraw.get(id);
        let tot = 0;
        for (let k = 0; k < K; k++) {
          pd.v[k] += c.w * res.counts[i + n * k];
          pd.v[K + k] += c.w * res.costs[i + n * k];
          tot += res.costs[i + n * k];
        }
        pd.v[2 * K] += c.w * tot;
        for (let t = 0; t < n_shifts; t++) pd.sh[t] += c.w * res.shift_total[i + n * t];
      });
    }
    const out = [];
    for (const r of x) {
      const pds = [...perDraw.values()].filter((d) => d.row === r.row).sort((a, b) => a.draw - b.draw);
      const o = { row: r.row, model: r.use, filled: r.filled };
      vals.forEach((v, j) => { o[v] = mean(pds.map((d) => d.v[j])); });
      o.n_completed = pds.length;
      const totals = pds.map((d) => d.v[2 * K]);
      o.se_healthcare_use_costs = pds.length > 1 ? Math.sqrt(variance(totals) / pds.length)
        : Math.sqrt(mean(pds.map((d) => variance(Array.from(d.sh)) / n_shifts)));
      out.push(o);
    }
    return out;
  }

  // hcuweb_predict(): budgets `points` and `draws`; the profile at several ages shares its random numbers
  async function predict(req) {
    const t0 = performance.now();
    const rec = Object.fromEntries(Object.entries(req.record).filter(([, v]) => !isNA(v)));
    let nd = [rec];
    let key = null;
    if (req.ages && req.ages.length) {
      nd = req.ages.map((a) => ({ ...rec, age: Number(a) }));
      key = nd.map(() => 1);
    }
    // whether the profile is filled in (all rows share the known predictors): a one-point run in R; the
    // routing alone here
    const probe = await predictRoute(req.period, rec);
    const sizes = probe.filled ? { n_draws: req.draws, n_points: Math.max(256, Math.ceil(req.points / req.draws)) }
                               : { n_draws: 1, n_points: req.points };
    const results = await predictCore(req.period, nd, { n_draws: sizes.n_draws, n_points: sizes.n_points, seed: req.seed, key });
    return { elapsed: (performance.now() - t0) / 1000, method: 'expected', ...sizes, results };
  }
  // the routing of one record (model, filled), without computing
  async function predictRoute(p, rec) {
    const ix = (await index(p)).index;
    const dz = ix.diseases.map((d) => d.name);
    const prvl = dz.map((d) => (isNA(rec[`${d}_prvl`]) ? NA : Number(rec[`${d}_prvl`])));
    const dKnown = prvl.filter((v) => v !== NA && v !== -1).length;
    const dMinus = prvl.filter((v) => v === -1).length;
    const sK = !isNA(rec.dimd) + !isNA(rec.ethnicity) + !isNA(rec.sha);
    const rK = !isNA(rec.bmi) + !isNA(rec.smok);
    const hasD = dKnown === dz.length;
    const k = `A${sK === 3 ? 'S' : ''}${rK === 2 ? 'R' : ''}${hasD ? 'D' : ''}${hasD || !isNA(rec.ncond) ? 'N' : ''}`;
    const partial = (sK > 0 && sK < 3) || rK === 1 || (!hasD && (dKnown > 0 || dMinus > 0));
    let use = !partial && SETS.includes(k) ? k : 'ASRDN';
    if ((k === 'ASRDN' || k === 'ASRD') && !partial) use = 'ASRDN';
    return { model: use, filled: use === 'ASRDN' && k !== 'ASRDN' && k !== 'ASRD' };
  }

  // hcuweb_spread(): n simulated people like the profile, summarised
  async function spread(req) {
    const t0 = performance.now();
    const rec = Object.fromEntries(Object.entries(req.record).filter(([, v]) => !isNA(v)));
    const d = await predictCore(req.period, [rec], { type: 'draws', n_draws: req.n, seed: req.seed });
    const tot = d.map((r) => r.healthcare_use_costs);
    const [p10, p25, median, p75, p90] = quantile7(tot, [0.1, 0.25, 0.5, 0.75, 0.9]);
    const share = (f) => d.filter(f).length / d.length;
    return { n: d.length, p10, p25, median, p75, p90, mean: mean(tot), p_zero: share((r) => r.healthcare_use_costs === 0),
             p_admission: share((r) => r.apc_spells > 0), p_ae: share((r) => r.ae_attendances > 0),
             p_over_10k: share((r) => r.healthcare_use_costs > 10000), elapsed: (performance.now() - t0) / 1000 };
  }

  return { meta, predict, spread, predictCore, predictRoute, ensureModel };
}
