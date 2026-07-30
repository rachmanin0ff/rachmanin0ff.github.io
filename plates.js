import { loadFeatures, loadScore, PC_NAMES, fifthsIndex, tonalDistance, isDiatonic, pcCSS, pcRGB, chordLabel, SECTIONS, MARKS, MIDI_LO, MIDI_HI } from './features.js';

const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const SERIF = '"Newsreader", Georgia, serif';

/* ---------- analyses, computed once from the aligned score ---------- */
let _A = null;
function analyses(F, S) {
  if (_A) return _A;
  const notes = S.notes, attacks = S.attacks, dur = S.duration;

  // duration-weighted pitch-class profile (already on S) + shares
  const profN = S.profileN, share = S.profileShare;

  // entropy over pitch-class sounding time
  const entFor = (win) => {
    const out = [];
    for (let s = 0; s < dur - win * 0.5; s += win) {
      const v = new Array(12).fill(0);
      for (const n of notes) { const a = Math.max(n.t0, s), b = Math.min(n.t1, s + win); if (b > a) v[n.pc] += b - a; }
      const tot = v.reduce((x, y) => x + y, 0);
      if (tot <= 0) { out.push({ t: s, H: null }); continue; }
      let H = 0; for (const x of v) { const q = x / tot; if (q > 0) H -= q * Math.log2(q); }
      out.push({ t: s, H });
    }
    return out;
  };
  const ent = entFor(4), ent10 = entFor(10).filter(e => e.H != null);
  // ignore the first and last windows: the opening bell octaves and the final
  // decay are unaccompanied, so their narrowness is an edge effect, not an event
  const inner = ent10.slice(1, -1);
  const Hmin = inner.reduce((a, b) => b.H < a.H ? b : a);

  // rhythm: real attack times
  const at = attacks.map(c => c.t);
  const dens = [], ioi = [], thick = [];
  for (let s = 0; s < dur; s += 2) dens.push({ t: s, v: at.filter(o => o >= s && o < s + 2).length / 2 });
  for (let s = 0; s < dur; s += 8) {
    const seg = attacks.filter(c => c.t >= s && c.t < s + 8);
    const d = [];
    for (let i = 1; i < seg.length; i++) d.push(seg[i].t - seg[i - 1].t);
    d.sort((a, b) => a - b);
    ioi.push({ t: s + 4, v: d.length > 1 ? d[d.length >> 1] : null });
    thick.push({ t: s + 4, v: seg.length ? seg.reduce((a, c) => a + c.notes.length, 0) / seg.length : null });
  }
  const secStats = SECTIONS.map(sec => {
    const cc = attacks.filter(c => c.t >= sec.t && c.t < sec.end);
    const nn = notes.filter(n => n.t0 >= sec.t && n.t0 < sec.end);
    const d = []; for (let i = 1; i < cc.length; i++) d.push(cc[i].t - cc[i - 1].t);
    d.sort((a, b) => a - b);
    return {
      ...sec, attacks: cc.length, notes: nn.length,
      thick: cc.length ? nn.length / cc.length : 0,
      ioi: d.length ? d[d.length >> 1] : 0,
      meanPitch: nn.length ? nn.reduce((a, n) => a + n.m, 0) / nn.length : 0,
    };
  });

  const Hmean = ent10.reduce((a, b) => a + b.H, 0) / ent10.length;

  // texture width: how many distinct pitch classes sound in each window, and
  // which windows collapse onto a single one
  const RH = 2.0, RN = Math.floor(dur * RH), cv = [], widths = [], unis = [];
  for (let k = 0; k < RN; k++) {
    const s = k / RH, e = s + 1 / RH, v = new Float32Array(12), set = new Set();
    for (const n of notes) {
      const a = Math.max(n.t0, s), b = Math.min(n.t1, e);
      if (b > a) { v[n.pc] += b - a; set.add(n.pc); }
    }
    let nn = 0; for (let p = 0; p < 12; p++) nn += v[p] * v[p];
    nn = Math.sqrt(nn) || 1;
    for (let p = 0; p < 12; p++) v[p] /= nn;
    cv.push(v);
    widths.push(set.size);
    if (set.size === 1) unis.push({ t: s, pc: [...set][0] });
  }

  // real chord path: one label per attack, held until the next
  const path = [];
  for (const c of attacks) {
    const pcs = [...new Set(c.notes.map(n => n.pc))];
    let bass = c.notes[0].pc, bm = 999;
    for (const n of c.notes) if (n.m < bm) { bm = n.m; bass = n.pc; }
    path.push({ t: c.t, label: chordLabel(pcs, bass), bass, pcs, size: c.notes.length });
  }
  const occ = new Map(), trans = new Map();
  path.forEach((p, i) => {
    occ.set(p.label, (occ.get(p.label) || 0) + 1);
    if (i && path[i - 1].label !== p.label) {
      const k = path[i - 1].label + '\u2192' + p.label;
      trans.set(k, (trans.get(k) || 0) + 1);
    }
  });
  const topChords = [...occ.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const topShare = topChords.reduce((s, c) => s + c[1], 0) / path.length;
  const topEdges = [...trans.entries()].sort((a, b) => b[1] - a[1]).slice(0, 26);

  // statements of the bell motif: A -> G# -> C# in the lowest sounding voice
  const lows = attacks.map(c => {
    let m = 999, pc = 1;
    for (const n of c.notes) if (n.m < m) { m = n.m; pc = n.pc; }
    return { t: c.t, pc, m };
  });
  const motifs = [];
  for (let i = 0; i < lows.length; i++) {
    if (lows[i].pc !== 9) continue;                  // A
    let j = -1;
    for (let k = i + 1; k <= Math.min(i + 4, lows.length - 1); k++) if (lows[k].pc === 8) { j = k; break; }
    if (j < 0) continue;
    let l = -1;
    for (let k = j + 1; k <= Math.min(j + 4, lows.length - 1); k++) if (lows[k].pc === 1) { l = k; break; }
    if (l < 0) continue;
    if (lows[l].t - lows[i].t > 16) continue;
    if (motifs.length && lows[i].t - motifs[motifs.length - 1] < 3) continue;
    motifs.push(lows[i].t);
  }

  // bass motion between consecutive attacks, by interval class
  const bassIv = new Array(12).fill(0);
  for (let i = 1; i < lows.length; i++) bassIv[((lows[i].pc - lows[i - 1].pc) + 12) % 12]++;
  const bassTot = bassIv.reduce((a, b) => a + b, 0) || 1;
  const bassGroups = {
    thirds: (bassIv[3] + bassIv[4] + bassIv[8] + bassIv[9]) / bassTot,
    fifths: (bassIv[5] + bassIv[7]) / bassTot,
    steps: (bassIv[1] + bassIv[2] + bassIv[10] + bassIv[11]) / bassTot,
    same: bassIv[0] / bassTot,
    tritone: bassIv[6] / bassTot,
  };
  const motifGaps = [];
  for (let i = 1; i < motifs.length; i++) motifGaps.push(motifs[i] - motifs[i - 1]);
  const medOf = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const half = Math.floor(motifGaps.length / 2);
  const motifStats = {
    n: motifs.length,
    medFirst: medOf(motifGaps.slice(0, half)),
    medSecond: medOf(motifGaps.slice(half)),
    last: motifs[motifs.length - 1] || 0,
    silence: dur - (motifs[motifs.length - 1] || 0),
  };

  _A = { profN, share, ent, ent10, Hmean, Hmin, dens, ioi, thick, secStats, cv, RH, RN, widths, unis, path, occ, trans, topChords, topShare, topEdges, at, motifs, motifGaps, motifStats, bassIv, bassTot, bassGroups };
  return _A;
}

class VizPlate extends HTMLElement {
  connectedCallback() {
    if (this._i) return; this._i = true;
    this.kind = this.getAttribute('kind') || 'phi';
    this.style.display = 'block'; this.style.position = 'relative';
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%' });
    this.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.live = true;
    this.seekable = ['transport', 'phi', 'entropy', 'rhythm', 'roll', 'recurrence', 'returns'].includes(this.kind);
    this.t = 0;
    Promise.all([loadFeatures(), loadScore(), document.fonts ? document.fonts.ready : Promise.resolve()]).then(([F, S]) => {
      this.F = F; this.S = S; this.A = analyses(F, S);
      // the observer must be retained: an unreachable ResizeObserver is collected
      // even while it still has a live observation, and stops firing
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
      this._onWinResize = () => this.resize();
      window.addEventListener('resize', this._onWinResize);
      window.addEventListener('orientationchange', this._onWinResize);
      this.resize();
      this.io = new IntersectionObserver(e => { this.vis = e[0].isIntersecting; }, { threshold: 0 });
      this.io.observe(this);
      if (this.seekable) this.bindSeek();
      const loop = () => {
        this._raf = requestAnimationFrame(loop);
        // relayout is driven from here as well as from the observer: ResizeObserver
        // delivery is tied to the rendering lifecycle and is not guaranteed in every
        // embedding, whereas this check costs two integer comparisons a frame
        if (this.clientWidth !== this.w || this.clientHeight !== this.h) this.resize();
        if (this.vis) this.paint();
      };
      this._raf = requestAnimationFrame(loop);
    });
  }
  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    if (this.ro) this.ro.disconnect();
    if (this.io) this.io.disconnect();
    if (this._onWinResize) {
      window.removeEventListener('resize', this._onWinResize);
      window.removeEventListener('orientationchange', this._onWinResize);
    }
  }

  bindSeek() {
    const el = this.canvas;
    const at = (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const pad = this.padFrac || 0;
      let u = this.kind === 'recurrence' ? (x - 0.10) / 0.88 : (x - pad) / (1 - pad * 2);
      u = Math.max(0, Math.min(1, u));
      const span = this.kind === 'transport' ? this.F.duration : this.S.duration;
      this.dispatchEvent(new CustomEvent('plate-seek', { bubbles: true, detail: { t: u * span } }));
    };
    let dn = false;
    el.style.cursor = 'crosshair';
    el.addEventListener('pointerdown', e => { dn = true; el.setPointerCapture(e.pointerId); at(e); });
    el.addEventListener('pointermove', e => { if (dn) at(e); });
    el.addEventListener('pointerup', () => { dn = false; });
    el.addEventListener('pointercancel', () => { dn = false; });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, this.clientWidth), h = Math.max(1, this.clientHeight);
    this.w = w; this.h = h; this.dpr = dpr;
    for (const c of [this.canvas, this.base]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.drawBase(); this.paint();
  }
  drawBase() {
    if (!this.F) return;
    // the first resize() runs before layout has resolved a height; drawing at 1 px
    // makes derived radii negative and throws (and is wasted work anyway)
    if (this.w < 40 || this.h < 40) return;
    const g = this.base.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const fn = this['draw_' + this.kind];
    if (fn) fn.call(this, g, this.w, this.h);
  }
  paint() {
    if (!this.F) return;
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.base, 0, 0);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const fn = this['over_' + this.kind];
    if (fn) fn.call(this, c, this.w, this.h);
  }

  /* helpers */
  envPath(g, x0, x1, yBase, amp, mirror) {
    const F = this.F;
    g.beginPath(); g.moveTo(x0, yBase);
    const N = Math.max(80, Math.round(x1 - x0));
    for (let i = 0; i <= N; i++) { const u = i / N; g.lineTo(x0 + u * (x1 - x0), yBase - F.env[F.frameAt(u * F.duration)] * amp); }
    if (mirror) for (let i = N; i >= 0; i--) { const u = i / N; g.lineTo(x0 + u * (x1 - x0), yBase + F.env[F.frameAt(u * F.duration)] * amp); }
    else g.lineTo(x1, yBase);
    g.closePath();
  }
  vline(g, x, y0, y1, color, dash) {
    g.save(); g.strokeStyle = color; g.lineWidth = 1; if (dash) g.setLineDash(dash);
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); g.restore();
  }
  tag(g, x, y, text, color, align = 'left') {
    g.font = `400 10px ${MONO}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
    g.fillText(text, x, y);
  }
  tagOpaque(g, x, y, text, color, align = 'left') {
    g.font = `400 10px ${MONO}`;
    const tw = g.measureText(text).width;
    const lx = align === 'right' ? x - tw : x;
    g.fillStyle = '#07080B'; g.fillRect(lx - 4, y - 10, tw + 8, 14);
    this.tag(g, x, y, text, color, align);
  }
  /* two legends on one baseline: stack them when they cannot both fit */
  legendPair(g, x0, x1, y, left, leftCol, right, rightCol) {
    g.font = `400 10px ${MONO}`;
    const lw = g.measureText(left).width, rw = g.measureText(right).width;
    if (lw + rw + 24 <= x1 - x0) {
      this.tag(g, x0, y, left, leftCol);
      this.tag(g, x1, y, right, rightCol, 'right');
    } else {
      this.tag(g, x0, y - 13, left, leftCol);
      this.tag(g, x0, y, right, rightCol);
    }
  }

  sectionAxis(g, X, yT, yB, h) {
    SECTIONS.forEach(s => {
      this.vline(g, X(s.t), yT, yB, 'rgba(234,229,219,0.1)');
      this.tag(g, X(s.t) + 4, yB + 14, s.roman, 'rgba(234,229,219,0.42)');
    });
  }

  /* ------------------------------------------------------------ transport */
  draw_transport(g, w, h) {
    const F = this.F, S = this.S; this.padFrac = 0;
    // the transport spans the whole audio file, including the final decay
    const span = this.F.duration;
    this._span = span;
    const yB = h - 15, amp = h - 26;
    g.fillStyle = 'rgba(255,255,255,0.025)'; g.fillRect(0, 0, w, h);
    SECTIONS.forEach((s, i) => {
      const x0 = s.t / span * w, x1 = s.end / span * w;
      g.fillStyle = i % 2 ? 'rgba(122,164,221,0.04)' : 'rgba(230,163,90,0.04)';
      g.fillRect(x0, 0, x1 - x0, h);
      this.vline(g, x0, 0, h, 'rgba(234,229,219,0.13)');
      this.tag(g, x0 + 5, 12, s.roman, 'rgba(234,229,219,0.4)');
    });
    // real note attacks, tick height by chord thickness
    for (const c of S.attacks) {
      const x = c.t / span * w;
      const k = Math.min(1, c.notes.length / 10);
      g.fillStyle = `rgba(234,229,219,${0.14 + k * 0.4})`;
      g.fillRect(x - 0.4, yB - 3 - k * 7, 1, 3 + k * 7);
    }
    this.envPath(g, 0, w, yB, amp, false);
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, 'rgba(233,150,74,0.5)'); grd.addColorStop(0.62, 'rgba(255,224,174,0.75)'); grd.addColorStop(1, 'rgba(112,140,226,0.38)');
    g.fillStyle = grd; g.fill();
    [MARKS.phiLow, MARKS.phiHigh].forEach(t => this.vline(g, t / span * w, 0, h, 'rgba(255,224,174,0.5)', [2, 3]));
  }
  over_transport(g, w, h) {
    const x = this.t / (this._span || this.F.duration) * w;
    g.fillStyle = 'rgba(7,8,11,0.55)'; g.fillRect(x, 0, w - x, h);
    this.vline(g, x, 0, h, '#FFE0AE');
    g.fillStyle = '#FFE0AE'; g.beginPath(); g.arc(x, h - 15, 2.6, 0, 7); g.fill();
  }

  /* ------------------------------------------------------------------ phi */
  draw_phi(g, w, h) {
    const S = this.S; const pad = this.padFrac = 0.045;
    const x0 = w * pad, x1 = w * (1 - pad), yM = h * 0.52, amp = h * 0.30;
    const X = t => x0 + t / S.duration * (x1 - x0);
    g.fillStyle = 'rgba(255,255,255,0.015)'; g.fillRect(0, 0, w, h);
    SECTIONS.forEach((s, i) => {
      g.fillStyle = i % 2 ? 'rgba(122,164,221,0.035)' : 'rgba(230,163,90,0.035)';
      g.fillRect(X(s.t), h * 0.12, X(s.end) - X(s.t), h * 0.80);
      const wid = X(s.end) - X(s.t);
      g.font = `300 13px ${SERIF}`; g.fillStyle = 'rgba(234,229,219,0.5)'; g.textAlign = 'left';
      g.fillText(wid > 118 ? `${s.roman}  ${s.name}` : s.roman, X(s.t) + 6, h * 0.965);
    });
    this.envPath(g, x0, x1, yM, amp, true);
    const grd = g.createLinearGradient(x0, 0, x1, 0);
    grd.addColorStop(0, 'rgba(233,150,74,0.36)'); grd.addColorStop(0.42, 'rgba(206,113,150,0.4)');
    grd.addColorStop(0.61, 'rgba(255,224,174,0.64)'); grd.addColorStop(1, 'rgba(112,140,226,0.3)');
    g.fillStyle = grd; g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 0.6; g.stroke();
    const gold = 'rgba(255,224,174,0.85)';
    [[MARKS.phiLow, '0.382 \u00b7 T  =  93.82 s', 'the piece\u2019s quietest breath', -1],
     [MARKS.phiHigh, '0.618 \u00b7 T  =  151.60 s', 'inside the culmination', 1]].forEach(([t, a, b, dir]) => {
      const x = X(t);
      this.vline(g, x, h * 0.10, h * 0.92, gold, [3, 4]);
      const al = dir < 0 ? 'right' : 'left';
      this.tag(g, x + dir * 8, h * 0.16, a, gold, al);
      this.tag(g, x + dir * 8, h * 0.16 + 13, b, 'rgba(234,229,219,0.52)', al);
    });
    const xa = X(MARKS.loudestAttack);
    this.vline(g, xa, yM - amp - 6, yM + amp + 6, '#FFFFFF');
    g.fillStyle = '#fff'; g.beginPath(); g.arc(xa, yM - amp - 8, 2.4, 0, 7); g.fill();
    this.tagOpaque(g, xa - 8, h * 0.80, 'loudest attack  150.06 s', '#fff', 'right');
    this.tagOpaque(g, xa - 8, h * 0.80 + 13, '\u0394 to \u03c6  =  1.54 s   \u2248  0.63 % of T', 'rgba(234,229,219,0.72)', 'right');
    g.strokeStyle = 'rgba(234,229,219,0.3)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, h * 0.055); g.lineTo(x1, h * 0.055);
    g.moveTo(x0, h * 0.04); g.lineTo(x0, h * 0.07); g.moveTo(x1, h * 0.04); g.lineTo(x1, h * 0.07); g.stroke();
    this.tag(g, (x0 + x1) / 2, h * 0.045, 'T  =  244.82 s  of  sounding  time', 'rgba(234,229,219,0.55)', 'center');
  }
  over_phi(g, w, h) {
    const x = w * 0.045 + this.t / this.S.duration * w * 0.91;
    this.vline(g, x, h * 0.10, h * 0.92, 'rgba(255,255,255,0.6)');
  }

  /* --------------------------------------------------------------- chroma */
  draw_chroma(g, w, h) {
    const A = this.A;
    const cx = w / 2, cy = (h - 76) * 0.5 + 12, R = Math.max(8, Math.min(w * 0.78, h - 110) * 0.40);
    const clampX = (x) => Math.max(10, Math.min(w - 10, x));
    g.font = `400 10px ${MONO}`; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.fillStyle = 'rgba(234,229,219,0.5)';
    g.fillText('sounding time by pitch class \u00b7 circle of fifths from C\u266F', 14, 20);
    for (let k = 1; k <= 4; k++) {
      g.beginPath(); g.arc(cx, cy, R * k / 4, 0, 7);
      g.strokeStyle = 'rgba(234,229,219,0.07)'; g.lineWidth = 1; g.stroke();
    }
    const order = [];
    for (let pc = 0; pc < 12; pc++) order[fifthsIndex(pc)] = pc;
    g.beginPath();
    order.forEach((pc, i) => {
      const a = i / 12 * Math.PI * 2 - Math.PI / 2, r = R * A.profN[pc];
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.closePath();
    g.fillStyle = 'rgba(230,163,90,0.10)'; g.fill();
    g.strokeStyle = 'rgba(255,224,174,0.4)'; g.lineWidth = 1; g.stroke();
    order.forEach((pc, i) => {
      const a = i / 12 * Math.PI * 2 - Math.PI / 2, r = R * A.profN[pc];
      const dia = isDiatonic(pc);
      g.strokeStyle = pcCSS(pc, dia ? 0.85 : 0.4); g.lineWidth = dia ? 3.4 : 1.6;
      if (!dia) g.setLineDash([2, 2]);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.06, cy + Math.sin(a) * R * 0.06);
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke();
      g.setLineDash([]);
      g.fillStyle = pcCSS(pc, dia ? 1 : 0.55);
      g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, dia ? 3.2 : 2, 0, 7); g.fill();
      const lr = R * 1.19, lx = cx + Math.cos(a) * lr, ly = cy + Math.sin(a) * lr;
      g.font = `${pc === 1 ? '600' : dia ? '400' : '300'} 12px ${MONO}`;
      g.fillStyle = pc === 1 ? '#FFE0AE' : (dia ? 'rgba(234,229,219,0.72)' : 'rgba(150,190,245,0.85)');
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(PC_NAMES[pc], lx, ly - 6);
      g.font = `400 9px ${MONO}`; g.fillStyle = 'rgba(234,229,219,0.42)';
      g.fillText((A.share[pc] * 100).toFixed(1) + '%', lx, ly + 7);
    });
    // the tonic's figure lives in the legend, not on the wheel: a spoke pointing
    // straight up would always collide with the title band
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.font = `300 10px ${MONO}`;
    g.fillStyle = '#FFE0AE';
    g.fillText(`C\u266F \u2014 the tonic, ${(A.share[1] * 100).toFixed(1)} % of all sounding time`, 14, h - 42);
    g.fillStyle = 'rgba(234,229,219,0.55)';
    g.fillText('solid \u2014 the seven notes of C\u266F minor', 14, h - 28);
    g.fillStyle = 'rgba(150,190,245,0.85)';
    g.fillText(`dashed \u2014 the five outsiders, ${((1 - this.S.diatonicShare) * 100).toFixed(1)} % of all sounding time`, 14, h - 14);
  }

  /* -------------------------------------------------------------- entropy */
  draw_entropy(g, w, h) {
    const A = this.A, S = this.S; const pad = this.padFrac = 0.06;
    const x0 = w * pad, x1 = w * (1 - pad), yT = h * 0.16, yB = h * 0.82;
    const HMAX = Math.log2(12), lo = 1.2;
    const Y = v => yB - Math.max(0, Math.min(1, (v - lo) / (HMAX - lo))) * (yB - yT);
    const X = t => x0 + t / S.duration * (x1 - x0);
    g.strokeStyle = 'rgba(234,229,219,0.10)';
    for (let v = 1.5; v <= 3.5; v += 0.5) {
      g.beginPath(); g.moveTo(x0, Y(v)); g.lineTo(x1, Y(v)); g.stroke();
      this.tag(g, x0 - 6, Y(v) + 3, v.toFixed(1), 'rgba(234,229,219,0.42)', 'right');
    }
    this.vline(g, X(MARKS.phiHigh), yT, yB, 'rgba(255,224,174,0.3)', [3, 4]);
    g.save(); g.setLineDash([5, 4]); g.strokeStyle = 'rgba(255,224,174,0.55)';
    g.beginPath(); g.moveTo(x0, Y(HMAX)); g.lineTo(x1, Y(HMAX)); g.stroke(); g.restore();
    this.tag(g, x1, Y(HMAX) - 7, 'log\u2082 12  =  3.585 bits  \u2014  all twelve equally present', '#FFE0AE', 'right');
    // 7-note diatonic reference
    g.save(); g.setLineDash([2, 4]); g.strokeStyle = 'rgba(150,190,245,0.5)';
    g.beginPath(); g.moveTo(x0, Y(Math.log2(7))); g.lineTo(x1, Y(Math.log2(7))); g.stroke(); g.restore();
    this.tag(g, x1, Y(Math.log2(7)) - 6, 'log\u2082 7  =  2.807  \u2014  a pure C\u266F minor scale', 'rgba(150,190,245,0.9)', 'right');
    g.beginPath();
    let started = false;
    // a window holding one or two pitch classes has no meaningful distribution;
    // break the line there rather than letting it fall out of the plot box
    const bare = [];
    A.ent.forEach(e => {
      const wIdx = Math.min(A.widths.length - 1, Math.round(e.t * A.RH));
      if (e.H == null || A.widths[wIdx] < 3) { started = false; bare.push(e.t); return; }
      const x = X(e.t), y = Y(e.H);
      started ? g.lineTo(x, y) : (g.moveTo(x, y), started = true);
    });
    g.strokeStyle = 'rgba(255,224,174,0.9)'; g.lineWidth = 1.5; g.stroke();
    // the bare windows, shown as their own row rather than hidden
    g.fillStyle = 'rgba(150,190,245,0.75)';
    bare.forEach(t => g.fillRect(X(t) - 1, yB + 4, 2.4, 5));
    SECTIONS.forEach(s => {
      this.vline(g, X(s.t), yT, yB, 'rgba(234,229,219,0.1)');
      this.tag(g, X(s.t) + 4, yB + 23, s.roman, 'rgba(234,229,219,0.42)');
    });
    this.tag(g, x0, yB + 38, `${bare.length} of ${A.ent.length} four-second windows hold fewer than three pitch classes`, 'rgba(150,190,245,0.85)');
    this.tag(g, x1, yB + 38, `narrowest 10 s window \u2014 ${A.Hmin.H.toFixed(2)} bits at ${Math.round(A.Hmin.t)} s`, '#fff', 'right');
    g.save(); g.setLineDash([1, 3]); g.strokeStyle = 'rgba(234,229,219,0.45)';
    g.beginPath(); g.moveTo(x0, Y(A.Hmean)); g.lineTo(x1, Y(A.Hmean)); g.stroke(); g.restore();
    this.tagOpaque(g, x0 + 4, yB - 9, `mean over 10 s windows   ${A.Hmean.toFixed(3)} bits   =  ${(A.Hmean / HMAX * 100).toFixed(1)} % of the ceiling`, 'rgba(234,229,219,0.75)');
    // the narrowest window is marked on the curve; its figure goes in the row
    // below the axis, so the callout cannot cut across the gridlines
    const xm = X(A.Hmin.t + 5);
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(xm, Y(A.Hmin.H), 3, 0, 7); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(xm, Y(A.Hmin.H) + 5); g.lineTo(xm, yB - 2); g.stroke();
  }
  over_entropy(g, w, h) { const x = w * 0.06 + this.t / this.S.duration * w * 0.88; this.vline(g, x, h * 0.16, h * 0.82, 'rgba(255,255,255,0.55)'); }
  /* ----------------------------------------------------------- recurrence */
  draw_recurrence(g, w, h) {
    const A = this.A, S = this.S;
    const RIB = 14, GAP = 5;
    const size = Math.min(w * 0.80, h * 0.80);
    const ox = w * 0.13 + RIB + GAP, oy = h * 0.045 + RIB + GAP;
    const N = A.RN, px = Math.round(size * this.dpr);
    // a luminous ramp: void -> indigo -> magenta -> bronze -> hot cream
    const STOPS = [[0, 8, 9, 14], [0.30, 38, 26, 74], [0.55, 150, 50, 104], [0.78, 226, 133, 58], [1, 255, 240, 214]];
    const ramp = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let a = STOPS[0], b = STOPS[STOPS.length - 1];
      for (let k = 0; k < STOPS.length - 1; k++) if (v >= STOPS[k][0] && v <= STOPS[k + 1][0]) { a = STOPS[k]; b = STOPS[k + 1]; break; }
      const u = (v - a[0]) / Math.max(1e-6, b[0] - a[0]);
      ramp[i * 3] = a[1] + (b[1] - a[1]) * u;
      ramp[i * 3 + 1] = a[2] + (b[2] - a[2]) * u;
      ramp[i * 3 + 2] = a[3] + (b[3] - a[3]) * u;
    }
    const img = g.createImageData(px, px);
    for (let y = 0; y < px; y++) {
      const j = Math.min(N - 1, Math.floor(y / px * N));
      for (let x = 0; x < px; x++) {
        const i = Math.min(N - 1, Math.floor(x / px * N));
        const a = A.cv[i], b = A.cv[j];
        let d = 0; for (let p = 0; p < 12; p++) d += a[p] * b[p];
        let v = Math.max(0, (d - 0.58) / 0.42);
        v = Math.pow(v, 1.15);
        const q = Math.min(255, Math.round(v * 255)) * 3;
        const o = (y * px + x) * 4;
        img.data[o] = ramp[q]; img.data[o + 1] = ramp[q + 1]; img.data[o + 2] = ramp[q + 2]; img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas'); tmp.width = px; tmp.height = px;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.drawImage(tmp, ox, oy, size, size);

    // texture-width ribbons on both axes: how many pitch classes are sounding
    const maxW = 12;
    for (let k = 0; k < N; k++) {
      const u = k / N, wv = A.widths[k] / maxW;
      const q = Math.min(255, Math.round(Math.pow(wv, 0.8) * 255)) * 3;
      const col = `rgb(${ramp[q]},${ramp[q + 1]},${ramp[q + 2]})`;
      g.fillStyle = col;
      g.fillRect(ox + u * size, oy - GAP - RIB, size / N + 0.6, RIB);
      g.fillRect(ox - GAP - RIB, oy + u * size, RIB, size / N + 0.6);
    }
    // unison moments: the windows that collapse onto a single pitch class
    g.fillStyle = 'rgba(198,222,255,0.95)';
    for (const u of A.unis) {
      const p = u.t / S.duration;
      g.fillRect(ox + p * size - 0.9, oy - GAP - RIB - 5, 1.8, 3.5);
      g.fillRect(ox - GAP - RIB - 5, oy + p * size - 0.9, 3.5, 1.8);
    }
    g.strokeStyle = 'rgba(234,229,219,0.2)'; g.lineWidth = 1;
    g.strokeRect(ox, oy, size, size);
    g.strokeRect(ox - GAP - RIB, oy - GAP - RIB, RIB, RIB);
    SECTIONS.forEach(s => {
      const u = s.t / S.duration;
      g.strokeStyle = 'rgba(234,229,219,0.22)';
      g.beginPath(); g.moveTo(ox + u * size, oy); g.lineTo(ox + u * size, oy + size);
      g.moveTo(ox, oy + u * size); g.lineTo(ox + size, oy + u * size); g.stroke();
      this.tag(g, ox + u * size + 3, oy + size + 14, s.roman, 'rgba(234,229,219,0.5)');
      this.tag(g, ox - GAP - RIB - 9, oy + u * size + 3, s.roman, 'rgba(234,229,219,0.5)', 'right');
    });
    this.tag(g, ox, oy + size + 30, 'ribbons \u2014 pitch classes sounding   \u00b7   ticks \u2014 windows on a single pitch class', 'rgba(198,222,255,0.8)');
    this._rc = { ox, oy, size };
  }
  over_recurrence(g, w, h) {
    if (!this._rc) return;
    const { ox, oy, size } = this._rc, u = this.t / this.S.duration;
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(ox + u * size, oy); g.lineTo(ox + u * size, oy + size);
    g.moveTo(ox, oy + u * size); g.lineTo(ox + size, oy + u * size); g.stroke();
  }

  /* ---------------------------------------------------------------- rhythm */
  draw_rhythm(g, w, h) {
    const A = this.A, S = this.S; const pad = this.padFrac = 0.06;
    const x0 = w * pad, x1 = w * (1 - pad), yT = h * 0.17, yB = h * 0.70;
    const X = t => x0 + t / S.duration * (x1 - x0);
    // speed: median IOI, inverted so faster = higher
    const iMax = 2.0;
    const Yspeed = v => yB - (1 - Math.min(1, v / iMax)) * (yB - yT);
    g.beginPath(); let st = false;
    A.ioi.forEach(d => { if (d.v == null) return; const y = Yspeed(d.v); st ? g.lineTo(X(d.t), y) : (g.moveTo(X(d.t), y), st = true); });
    g.strokeStyle = 'rgba(150,190,245,0.9)'; g.lineWidth = 1.7; g.stroke();
    // thickness: notes per attack
    const tMax = 9;
    const Ythick = v => yB - Math.min(1, v / tMax) * (yB - yT);
    g.beginPath(); st = false;
    A.thick.forEach(d => { if (d.v == null) return; const y = Ythick(d.v); st ? g.lineTo(X(d.t), y) : (g.moveTo(X(d.t), y), st = true); });
    g.strokeStyle = 'rgba(255,224,174,0.95)'; g.lineWidth = 1.7; g.stroke();
    const tight = (x1 - x0) < 430;
    this.legendPair(g, x0, x1, yT - 8,
      tight ? 'blue \u2014 attack rate' : 'blue \u2014 attack rate (median inter-onset interval, inverted)', 'rgba(150,190,245,0.95)',
      tight ? 'gold \u2014 notes/attack' : 'gold \u2014 notes per attack', '#FFE0AE');
    // per-section read-out: only as much of the table as the width can carry
    const colW = (x1 - x0) / SECTIONS.length;
    const showRowLabels = colW > 104;
    const showNames = colW > 88;
    A.secStats.forEach(s => {
      const xm = (X(s.t) + X(s.end)) / 2;
      g.textAlign = 'center';
      g.font = `300 12px ${SERIF}`; g.fillStyle = 'rgba(234,229,219,0.8)';
      g.fillText(s.thick.toFixed(2), xm, h * 0.80);
      g.font = `400 9px ${MONO}`; g.fillStyle = 'rgba(150,190,245,0.95)';
      g.fillText(s.ioi.toFixed(3) + ' s', xm, h * 0.865);
      g.font = `300 11px ${SERIF}`; g.fillStyle = 'rgba(234,229,219,0.6)';
      g.fillText(showNames ? s.roman + ' ' + s.name : s.roman, xm, h * 0.945);
    });
    if (showRowLabels) {
      this.tag(g, x0, h * 0.80, 'notes/attack', 'rgba(234,229,219,0.55)');
      this.tag(g, x0, h * 0.865, 'median IOI', 'rgba(150,190,245,0.8)');
    }
    SECTIONS.forEach(s => this.vline(g, X(s.t), yT, h * 0.90, 'rgba(234,229,219,0.1)'));
  }
  over_rhythm(g, w, h) { const x = w * 0.06 + this.t / this.S.duration * w * 0.88; this.vline(g, x, h * 0.17, h * 0.70, 'rgba(255,255,255,0.55)'); }

  /* ------------------------------------------------------------------ roll */
  draw_roll(g, w, h) {
    const S = this.S; const pad = this.padFrac = 0.05;
    const x0 = w * pad, x1 = w * (1 - pad), yT = h * 0.14, yB = h * 0.86;
    const X = t => x0 + t / S.duration * (x1 - x0);
    const Y = m => yB - (m - MIDI_LO) / (MIDI_HI - MIDI_LO) * (yB - yT);
    // octave guides
    for (let m = 24; m <= MIDI_HI + 1; m += 12) {
      g.strokeStyle = 'rgba(234,229,219,0.09)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x0, Y(m)); g.lineTo(x1, Y(m)); g.stroke();
      this.tag(g, x0 - 6, Y(m) + 3, 'C' + (Math.floor(m / 12) - 1), 'rgba(234,229,219,0.45)', 'right');
    }
    for (const n of S.notes) {
      const xa = X(n.t0), xb = Math.max(xa + 1.1, X(n.t1));
      const dia = isDiatonic(n.pc);
      // one variable per channel: alpha is velocity, outline is scale-membership
      g.fillStyle = pcCSS(n.pc, 0.34 + (n.v / 127) * 0.62);
      const bh = dia ? 3.2 : 5.4;
      g.fillRect(xa, Y(n.m) - bh / 2, xb - xa, bh);
      if (!dia) {
        g.strokeStyle = 'rgba(198,222,255,0.95)'; g.lineWidth = 0.7;
        g.strokeRect(xa - 0.5, Y(n.m) - bh / 2 - 0.5, (xb - xa) + 1, bh + 1);
      }
    }
    this.legendPair(g, x0, x1, h * 0.085,
      `${S.notes.length} notes, ${S.attacks.length} attacks \u2014 the aligned score`, 'rgba(234,229,219,0.55)',
      'outlined \u2014 the five notes outside C\u266F minor', 'rgba(198,222,255,0.95)');
    this.vline(g, X(MARKS.phiHigh), yT, yB, 'rgba(255,224,174,0.4)', [3, 4]);
    this.sectionAxis(g, X, yT, yB, h);
  }
  over_roll(g, w, h) { const x = w * 0.05 + this.t / this.S.duration * w * 0.90; this.vline(g, x, h * 0.14, h * 0.86, 'rgba(255,255,255,0.7)'); }

  /* ---------------------------------------------------------------- returns */
  draw_returns(g, w, h) {
    const A = this.A, S = this.S; const pad = this.padFrac = 0.06;
    const x0 = w * pad, x1 = w * (1 - pad);
    const yT = h * 0.16, yB = h * 0.52;
    const X = t => x0 + t / S.duration * (x1 - x0);
    const GMAX = 28;
    const Yg = v => yB - (1 - Math.min(1, v / GMAX)) * (yB - yT);
    // the stretch after the last statement
    g.fillStyle = 'rgba(122,164,221,0.07)';
    g.fillRect(X(A.motifStats.last), yT, x1 - X(A.motifStats.last), yB - yT);
    this.tag(g, x1 - 6, yT + 13, `${A.motifStats.silence.toFixed(0)} s with no statement`, 'rgba(150,190,245,0.9)', 'right');
    g.strokeStyle = 'rgba(234,229,219,0.1)';
    [5, 10, 20].forEach(v => {
      g.beginPath(); g.moveTo(x0, Yg(v)); g.lineTo(x1, Yg(v)); g.stroke();
      this.tag(g, x0 - 6, Yg(v) + 3, v + ' s', 'rgba(234,229,219,0.42)', 'right');
    });
    // gap-to-next as a step curve: higher means the bell returns sooner
    g.beginPath();
    A.motifGaps.forEach((v, i) => {
      const xa = X(A.motifs[i]), xb = X(A.motifs[i + 1]), y = Yg(v);
      if (i === 0) g.moveTo(xa, y); else g.lineTo(xa, y);
      g.lineTo(xb, y);
    });
    g.strokeStyle = 'rgba(255,224,174,0.9)'; g.lineWidth = 1.6; g.stroke();
    // each statement
    A.motifs.forEach(t => {
      const x = X(t);
      this.vline(g, x, yT, yB + 8, 'rgba(255,224,174,0.42)');
      g.fillStyle = '#FFE0AE'; g.beginPath(); g.arc(x, yB + 8, 2.6, 0, 7); g.fill();
    });
    this.tag(g, x0, yT - 8, `${A.motifStats.n} statements of A \u2013 G\u266F \u2013 C\u266F in the lowest voice \u00b7 gold \u2014 seconds until the next`, '#FFE0AE');
    this.tagOpaque(g, X(30), Yg(A.motifStats.medFirst) - 10, `first half: ${A.motifStats.medFirst.toFixed(1)} s apart`, 'rgba(234,229,219,0.85)');
    this.tagOpaque(g, X(140), Yg(A.motifStats.medSecond) - 10, `second half: ${A.motifStats.medSecond.toFixed(1)} s`, '#fff');
    SECTIONS.forEach(s => { this.vline(g, X(s.t), yT, yB, 'rgba(234,229,219,0.1)'); this.tag(g, X(s.t) + 4, yB + 26, s.roman, 'rgba(234,229,219,0.42)'); });

    // bass-motion histogram
    const hy = h * 0.94, hh = h * 0.26;
    const bmax = Math.max(...A.bassIv);
    const bw = (x1 - x0) / 12;
    const ivn = ['\u2013', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];
    const grp = (i) => [3, 4, 8, 9].includes(i) ? 'third' : ([5, 7].includes(i) ? 'fifth' : ([1, 2, 10, 11].includes(i) ? 'step' : 'other'));
    for (let i = 0; i < 12; i++) {
      const bh = A.bassIv[i] / bmax * hh;
      const t = grp(i);
      g.fillStyle = t === 'third' ? 'rgba(255,224,174,0.85)' : (t === 'fifth' ? 'rgba(150,190,245,0.85)' : 'rgba(234,229,219,0.28)');
      g.fillRect(x0 + i * bw + bw * 0.18, hy - bh, bw * 0.64, bh);
      g.font = `400 9px ${MONO}`; g.textAlign = 'center'; g.fillStyle = 'rgba(234,229,219,0.5)';
      g.fillText(ivn[i], x0 + i * bw + bw / 2, hy + 11);
    }
    g.textAlign = 'left';
    this.tag(g, x0, hy - hh - 8, `bass motion between attacks \u00b7 thirds ${(A.bassGroups.thirds * 100).toFixed(1)} %`, '#FFE0AE');
    this.tag(g, x1, hy - hh - 8, `fifths and fourths ${(A.bassGroups.fifths * 100).toFixed(1)} %`, 'rgba(150,190,245,0.9)', 'right');
  }
  over_returns(g, w, h) { const x = w * 0.06 + this.t / this.S.duration * w * 0.88; this.vline(g, x, h * 0.16, h * 0.52, 'rgba(255,255,255,0.55)'); }

  /* -------------------------------------------------------------- network */
  draw_network(g, w, h) {
    const A = this.A;
    const cx = w / 2, cy = h * 0.5 + 6, R = Math.min(w, h) * 0.29;
    const labels = A.topChords.map(c => c[0]);
    const pos = new Map();
    labels.forEach((lab, i) => {
      const a = i / labels.length * Math.PI * 2 - Math.PI / 2;
      const two = PC_NAMES.indexOf(lab.slice(0, 2));
      const root = two >= 0 ? two : PC_NAMES.indexOf(lab[0]);
      pos.set(lab, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, a, root: root < 0 ? 1 : root });
    });
    g.strokeStyle = 'rgba(234,229,219,0.05)';
    g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
    const maxE = Math.max(...A.topEdges.map(e => e[1]));
    [...A.topEdges].reverse().forEach(([k, v]) => {
      const [a, b] = k.split('\u2192');
      const p = pos.get(a), q = pos.get(b);
      if (!p || !q) return;
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, s = v / maxE;
      g.strokeStyle = `rgba(${Math.round(198 - s * 30)},${Math.round(214 - s * 20)},246,${0.07 + s * 0.6})`;
      g.lineWidth = 0.5 + s * 3.2;
      g.beginPath(); g.moveTo(p.x, p.y);
      g.quadraticCurveTo(cx + (mx - cx) * 0.68, cy + (my - cy) * 0.68, q.x, q.y);
      g.stroke();
    });
    const maxO = A.topChords[0][1];
    A.topChords.forEach(([lab, n]) => {
      const p = pos.get(lab), o = n / maxO;
      g.fillStyle = pcCSS(p.root, 0.3 + o * 0.7);
      g.beginPath(); g.arc(p.x, p.y, 3 + o * 12, 0, 7); g.fill();
      g.font = `${o > 0.6 ? '600' : '400'} 11px ${MONO}`;
      g.fillStyle = o > 0.6 ? '#FFE0AE' : 'rgba(234,229,219,0.8)';
      g.textBaseline = 'middle';
      // place the label outside its node, then keep the whole string inside the box
      const lr = R + 16 + o * 10;
      const tw = g.measureText(lab).width;
      const side = Math.cos(p.a);
      const align = side < -0.25 ? 'right' : (side > 0.25 ? 'left' : 'center');
      let lx = cx + side * lr;
      if (align === 'right') lx = Math.max(lx, 10 + tw);
      else if (align === 'left') lx = Math.min(lx, w - 10 - tw);
      else lx = Math.max(10 + tw / 2, Math.min(w - 10 - tw / 2, lx));
      g.textAlign = align;
      g.fillText(lab, lx, cy + Math.sin(p.a) * lr);
    });
    g.font = `300 10px ${MONO}`; g.fillStyle = 'rgba(234,229,219,0.5)'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(`the ${A.topChords.length} chords that carry ${(A.topShare * 100).toFixed(0)} % of the attacks`, 14, 20);
    g.fillText('node \u2014 attacks spent there   \u00b7   edge \u2014 transitions taken', 14, h - 30);
    this._np = pos;
  }
  over_network(g, w, h) {
    if (!this._np) return;
    const A = this.A;
    let cur = A.path[0];
    for (const p of A.path) { if (p.t <= this.t) cur = p; else break; }
    const p = this._np.get(cur.label);
    if (p) {
      g.strokeStyle = '#FFE0AE'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(p.x, p.y, 16, 0, 7); g.stroke();
    }
    // bottom-right, clear of the title at the top
    g.font = `400 11px ${MONO}`; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    const txt = 'now \u00b7 ' + cur.label + '  (' + cur.size + ')';
    const tw = g.measureText(txt).width;
    g.fillStyle = '#07080B'; g.fillRect(w - 18 - tw, h - 25, tw + 8, 15);
    g.fillStyle = '#FFE0AE';
    g.fillText(txt, w - 14, h - 14);
  }
}
customElements.define('viz-plate', VizPlate);

window.__preludePlates = {
  setTime(t) { document.querySelectorAll('viz-plate').forEach(p => { p.t = t; }); },
};

Promise.all([loadFeatures(), loadScore()]).then(([F, S]) => {
  const A = analyses(F, S);
  window.__preludeFacts = {
    duration: S.duration, marks: MARKS,
    strikes: A.motifs.length ? A.motifs : S.attacks.filter(c => c.t < 103.3 && c.notes.length >= 3).map(c => c.t),
    envAt: (t) => F.env[F.frameAt(t)],
    sectionAt: (t) => SECTIONS.find(s => t >= s.t && t < s.end) || SECTIONS[SECTIONS.length - 1],
    chordAt: (t) => { let c = A.path[0]; for (const p of A.path) { if (p.t <= t) c = p; else break; } return c.label; },
    notesAt: (t) => { let c = A.path[0]; for (const p of A.path) { if (p.t <= t) c = p; else break; } return c.size; },
  };
});
