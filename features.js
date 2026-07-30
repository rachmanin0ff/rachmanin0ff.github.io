// Shared loaders + tonal geometry for the Prelude visualisation.
//
// Two sources, kept distinct:
//   features.json  — measured from the recording (envelope, attacks, spectrum bands)
//   score.json     — the note text: a Duo-Art piano-roll transcription of Op. 3 No. 2,
//                    DTW-aligned to this recording and snapped to its detected attacks.
// Everything pitch-related now comes from the score, so nothing phantom can appear.

export const PC_NAMES = ['C', 'C\u266F', 'D', 'D\u266F', 'E', 'F', 'F\u266F', 'G', 'G\u266F', 'A', 'A\u266F', 'B'];
export const TONIC = 1; // C#
export const DIATONIC = [1, 3, 4, 6, 8, 9, 11]; // C# D# E F# G# A B

export function fifthsIndex(pc) { return ((pc - TONIC) * 7 % 12 + 12) % 12; }
export function tonalDistance(pc) { const i = fifthsIndex(pc); return Math.min(i, 12 - i); }
export function isDiatonic(pc) { return DIATONIC.indexOf(pc) >= 0; }

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
// colour = tonal distance from C#: warm bronze at home, through rose and violet,
// to ice at the tritone. Never passes through green.
export function pcRGB(pc, boost = 0) {
  const t = Math.pow(tonalDistance(pc) / 6, 1.8);
  const c = hsl(32 - 176 * t, 0.72 - 0.08 * t, 0.655 - 0.05 * t);
  const e = 1 + boost;
  return [Math.min(1, c[0] * e), Math.min(1, c[1] * e), Math.min(1, c[2] * e)];
}
export function pcCSS(pc, a = 1) {
  const c = pcRGB(pc);
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

export const PALETTE = {
  bg: '#07080B', ink: '#EAE5DB', dim: '#7E7A6E',
  bronze: '#E6A35A', bronzeHot: '#FFE0AE', ice: '#7AA4DD', iceHot: '#C6DCF6',
};

export const SECTIONS = [
  { t: 0.30, end: 103.3, roman: 'I', name: 'Lento', sub: 'the bell' },
  { t: 103.3, end: 136.2, roman: 'II', name: 'Agitato', sub: 'the rising' },
  { t: 136.2, end: 170.9, roman: 'III', name: 'Culmination', sub: 'the golden section' },
  { t: 170.9, end: 195.5, roman: 'IV', name: 'Tempo I', sub: 'the great chords' },
  { t: 195.5, end: 245.12, roman: 'V', name: 'Coda', sub: 'dissolution' },
];

export const MARKS = {
  soundStart: 0.30, soundEnd: 245.12, span: 244.82,
  phiLow: 93.82, phiHigh: 151.60,
  peak: 144.60, loudestAttack: 150.06, quietest: 100.6,
  thickest: 140.25,
};

export const MIDI_LO = 25, MIDI_HI = 95;

/* ---------------------------------------------------------------- audio */
let _f = null;
export function loadFeatures() {
  if (_f) return _f;
  _f = fetch('data/features.json').then(r => r.json()).then(raw => {
    const dec = (s) => {
      const b = atob(s); const u = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
      return u;
    };
    const F = {
      duration: raw.duration, fps: raw.fps, n: raw.nFrames,
      rms: dec(raw.rms), flux: dec(raw.flux),
      bands: raw.bands.map(dec), onsets: raw.onsets, bandEdges: raw.bandEdges,
    };
    const n = F.n, K = Math.round(F.fps * 0.6), sm = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += F.rms[i];
      if (i >= K) acc -= F.rms[i - K];
      sm[i] = acc / Math.min(i + 1, K) / 255;
    }
    F.env = sm;
    F.frameAt = (t) => Math.max(0, Math.min(n - 1, Math.round(t * F.fps)));
    return F;
  });
  return _f;
}

/* ---------------------------------------------------------------- score */
let _s = null;
export function loadScore() {
  if (_s) return _s;
  _s = fetch('data/score.json').then(r => r.json()).then(raw => {
    const notes = raw.notes.map(([m, t0, t1, v, trk]) => ({ m, t0, t1, v, trk, pc: ((m % 12) + 12) % 12 }));
    notes.sort((a, b) => a.t0 - b.t0);
    // attack clusters: notes struck together
    const attacks = [];
    for (const n of notes) {
      const c = attacks[attacks.length - 1];
      if (c && n.t0 - c.t < 0.055) { c.notes.push(n); c.vel = Math.max(c.vel, n.v); }
      else attacks.push({ t: n.t0, notes: [n], vel: n.v });
    }
    attacks.forEach((c, i) => { c.i = i; });
    const S = { source: raw.source, duration: raw.duration, notes, attacks };

    // notes sounding at time t, with a piano-like weight
    S.soundingAt = (t, out) => {
      out.length = 0;
      // sustain rarely exceeds 9 s; scan a bounded window
      let lo = 0, hi = notes.length - 1, first = notes.length;
      const tMin = t - 12;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (notes[mid].t0 >= tMin) { first = mid; hi = mid - 1; } else lo = mid + 1; }
      // A piano string keeps ringing under the pedal long after the key lifts,
      // and low strings ring longest. Model that decay rather than the roll's
      // key-release, which is what the ear actually follows.
      for (let i = first; i < notes.length; i++) {
        const n = notes[i];
        if (n.t0 > t) break;
        const age = t - n.t0;
        const tau = 0.95 + (n.m - 25) / 70 * 0.80;
        const atk = Math.min(1, age / 0.028);
        let w = (n.v / 127) * atk * Math.exp(-age * tau);
        if (t > n.t1) w *= 0.55;             // key lifted: damped, not silenced
        if (w > 0.03) out.push({ n, w });
      }
      return out;
    };
    S.pcEnergyAt = (t, arr, buf) => {
      for (let p = 0; p < 12; p++) arr[p] = 0;
      const list = S.soundingAt(t, buf);
      let mx = 0;
      for (const o of list) { arr[o.n.pc] += o.w; if (arr[o.n.pc] > mx) mx = arr[o.n.pc]; }
      return list;
    };
    // duration-weighted pitch-class profile
    const prof = new Array(12).fill(0);
    for (const n of notes) prof[n.pc] += n.t1 - n.t0;
    const pmax = Math.max(...prof), ptot = prof.reduce((a, b) => a + b, 0);
    S.profile = prof;
    S.profileN = prof.map(v => v / pmax);
    S.profileShare = prof.map(v => v / ptot);
    S.diatonicShare = DIATONIC.reduce((s, p) => s + prof[p], 0) / ptot;
    return S;
  });
  return _s;
}

/* chord label from a real pitch-class set + bass */
const CHORD_TYPES = [
  { iv: [0, 4, 7], tag: '' }, { iv: [0, 3, 7], tag: 'm' },
  { iv: [0, 3, 6], tag: '\u00b0' }, { iv: [0, 4, 8], tag: '+' },
  { iv: [0, 4, 7, 10], tag: '7' }, { iv: [0, 3, 7, 10], tag: 'm7' },
  { iv: [0, 4, 7, 11], tag: 'maj7' }, { iv: [0, 3, 6, 9], tag: '\u00b07' },
  { iv: [0, 3, 6, 10], tag: '\u00f87' }, { iv: [0, 5, 7], tag: 'sus4' },
  { iv: [0, 2, 7], tag: 'sus2' },
];
export function chordLabel(pcSet, bassPc) {
  const set = [...new Set(pcSet)].sort((a, b) => a - b);
  if (!set.length) return '\u2014';
  if (set.length === 1) return PC_NAMES[set[0]] + ' unison';
  if (set.length === 2) {
    const iv = ((set[1] - set[0]) + 12) % 12;
    const names = { 1: 'semitone', 2: 'tone', 3: 'minor 3rd', 4: 'major 3rd', 5: '4th', 6: 'tritone', 7: '5th' };
    return PC_NAMES[bassPc] + ' + ' + (names[Math.min(iv, 12 - iv)] || 'interval');
  }
  let best = null, bestScore = -1e9;
  for (let root = 0; root < 12; root++) {
    for (const ct of CHORD_TYPES) {
      const mem = ct.iv.map(i => (root + i) % 12);
      let hit = 0; for (const p of set) if (mem.indexOf(p) >= 0) hit++;
      const miss = set.length - hit, absent = ct.iv.length - hit;
      let sc = hit * 1.0 - miss * 0.85 - absent * 0.55;
      if (root === bassPc) sc += 0.5;
      if (sc > bestScore) { bestScore = sc; best = { root, ct }; }
    }
  }
  const lab = PC_NAMES[best.root] + best.ct.tag;
  return best.root === bassPc ? lab : lab + '/' + PC_NAMES[bassPc];
}
