// =============================================================================
// web-fast/rng_r.js - R's default random number generator in JavaScript (2026-11-08): set.seed(seed) with
// the Mersenne-Twister (R's RNG.c: the initial scrambling and seeding, MT_genrand() and fixup()) and runif(n).
// The R-free explorer needs it in one place only: hcu_predict(type = "draws") draws each completed record's
// death group with with_seed(seed, runif(n)); with this the page gives exactly R's draws.
// =============================================================================
const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER = 0x80000000;
const LOWER = 0x7fffffff;
const I2_32M1 = 2.328306437080797e-10;   // 1 / (2^32 - 1)

// set.seed(seed): returns runif(n), the uniforms R would give after set.seed(seed) (seed a whole number)
export function rRunif(seed, n) {
  let s = seed >>> 0;
  for (let j = 0; j < 50; j++) s = (Math.imul(69069, s) + 1) >>> 0;   // initial scrambling
  const mt = new Uint32Array(N);
  // R stores 625 seeds: the first is the position (mti), then the 624 words
  s = (Math.imul(69069, s) + 1) >>> 0;                                  // dummy[0], replaced by 624
  for (let j = 0; j < N; j++) { s = (Math.imul(69069, s) + 1) >>> 0; mt[j] = s; }
  let mti = N;
  const mag01 = [0, MATRIX_A];
  const genrand = () => {
    let y;
    if (mti >= N) {
      let kk;
      for (kk = 0; kk < N - M; kk++) {
        y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ mag01[y & 1];
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 1];
      }
      y = (mt[N - 1] & UPPER) | (mt[0] & LOWER);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ mag01[y & 1];
      mti = 0;
    }
    y = mt[mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return (y >>> 0) * 2.3283064365386963e-10;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = genrand();
    out[i] = x <= 0 ? 0.5 * I2_32M1 : (1 - x <= 0 ? 1 - 0.5 * I2_32M1 : x);   // R's fixup(): in (0, 1)
  }
  return out;
}
