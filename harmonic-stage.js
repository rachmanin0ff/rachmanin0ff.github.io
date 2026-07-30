import * as THREE from 'https://unpkg.com/three@0.184.0/build/three.module.js';
import { loadFeatures, loadScore, PC_NAMES, fifthsIndex, pcRGB, isDiatonic, MIDI_LO, MIDI_HI } from './features.js';

const RING_R = 7.2;
const Y0 = -0.6, YS = 0.205;            // MIDI -> height
const yOf = (m) => Y0 + (m - MIDI_LO) * YS;
const Y_TOP = yOf(MIDI_HI);
const HELIX_R = 17.2, HELIX_TURNS = 6.5;
const MAX_BEADS = 96;

class HarmonicStage extends HTMLElement {
  connectedCallback() {
    if (this._init) return;
    this._init = true;
    this.style.display = 'block'; this.style.position = 'relative';
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' });
    this.appendChild(this.canvas);
    this.layers = { bell: true, fifths: true, chord: true, helix: true, trails: true, field: true };
    this.mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
    this.onFrame = null; this.audio = null;
    this._pcE = new Float32Array(12);
    this._buf = []; this._sounding = [];
    this._t = 0;
    Promise.all([loadFeatures(), loadScore(), document.fonts ? document.fonts.ready : Promise.resolve()])
      .then(([F, S]) => { this.F = F; this.S = S; this.build(); this.start(); });
    window.__preludeStage = this;
  }
  attach(audioEl) { this.audio = audioEl; }

  build() {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !this.mobile, alpha: false, powerPreference: 'high-performance' });
    r.setClearColor(0x07080b, 1);
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.6 : 2));
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x07080b, 0.0062);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
    this.cam = { theta: 0.62, phi: 1.30, radius: this.mobile ? 34 : 25, vT: 0, vP: 0, idle: 0, drag: false };
    this.look = new THREE.Vector3(0, Y_TOP * 0.42, 0);

    // stars
    const sN = this.mobile ? 480 : 1000, sp = new Float32Array(sN * 3);
    for (let i = 0; i < sN; i++) {
      const rr = 80 + Math.random() * 150, a = Math.random() * Math.PI * 2, e = Math.acos(2 * Math.random() - 1);
      sp[i * 3] = rr * Math.sin(e) * Math.cos(a); sp[i * 3 + 1] = rr * Math.cos(e) * 0.7 + 6; sp[i * 3 + 2] = rr * Math.sin(e) * Math.sin(a);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x5a6478, size: 0.5, transparent: true, opacity: 0.5 }));
    this.scene.add(this.stars);

    // ---- the lattice: 12 vertical strings (fifths) x octave rings
    const field = new THREE.Group();
    this.pcDir = []; this.strings = [];
    for (let pc = 0; pc < 12; pc++) {
      const i = fifthsIndex(pc), a = i / 12 * Math.PI * 2 - Math.PI / 2;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      this.pcDir[pc] = dir;
      const c = pcRGB(pc), col = new THREE.Color(c[0], c[1], c[2]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        dir.x * RING_R, Y0 - 0.4, dir.z * RING_R, dir.x * RING_R, Y_TOP + 0.4, dir.z * RING_R]), 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }));
      field.add(line); this.strings.push(line);
      const lab = this.makeLabel(PC_NAMES[pc], col, isDiatonic(pc));
      lab.position.set(dir.x * RING_R * 1.16, Y0 - 1.5, dir.z * RING_R * 1.16);
      field.add(lab);
    }
    // octave rings at every C
    for (let m = 24; m <= MIDI_HI + 1; m += 12) {
      const y = yOf(m), N = 96, pos = new Float32Array(N * 3);
      for (let k = 0; k < N; k++) { const a = k / N * Math.PI * 2; pos[k * 3] = Math.cos(a) * RING_R; pos[k * 3 + 1] = y; pos[k * 3 + 2] = Math.sin(a) * RING_R; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      field.add(new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x33425c, transparent: true, opacity: 0.62 })));
      const oct = Math.floor(m / 12) - 1;
      const lab = this.makeLabel('C' + oct, new THREE.Color(0.55, 0.6, 0.72), false);
      lab.scale.multiplyScalar(0.72);
      lab.position.set(RING_R * 1.13, y + 0.16, 0);
      field.add(lab);
    }
    this.field = field; this.scene.add(field);

    // ---- bell: nested resonance shells + core
    const bell = new THREE.Group();
    bell.position.y = Y_TOP * 0.36;
    this.shells = [];
    const shapes = [
      (rr) => new THREE.IcosahedronGeometry(rr, 0), (rr) => new THREE.OctahedronGeometry(rr, 0),
      (rr) => new THREE.DodecahedronGeometry(rr, 0), (rr) => new THREE.TetrahedronGeometry(rr, 0)];
    const nShell = this.mobile ? 4 : 6;
    for (let i = 0; i < nShell; i++) {
      const rr = 0.5 + i * 0.3;
      const c = pcRGB(i < 4 ? 1 : 7);
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c[0], c[1], c[2]), wireframe: true, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(shapes[i % 4](rr), m);
      bell.add(mesh); this.shells.push(mesh);
    }
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 2), new THREE.MeshBasicMaterial({ color: 0xffcf8a, transparent: true, opacity: 0.9 }));
    bell.add(this.core);
    this.coreGlow = this.makeGlow(0xffb968, 3); bell.add(this.coreGlow);
    this.bell = bell; this.scene.add(bell);

    // ---- shockwaves (one per attack, radius scaled by chord thickness)
    this.waves = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(1, 1.03, 96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.visible = false;
      this.scene.add(m); this.waves.push(m);
    }
    this._wi = 0; this._lastWave = -9;

    // ---- note beads: one instance per sounding note, at its true register
    this.beads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }), MAX_BEADS);
    this.beads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beads.frustumCulled = false;
    this.scene.add(this.beads);
    this.beadGlow = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.glowTex(), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide }), MAX_BEADS);
    this.beadGlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beadGlow.frustumCulled = false;
    this.scene.add(this.beadGlow);
    this._dummy = new THREE.Object3D();
    this._col = new THREE.Color();

    // ---- chord: the voice ladder + the pitch-class hull
    const lg = new THREE.BufferGeometry();
    this.chordLinePos = new Float32Array(MAX_BEADS * 2 * 3);
    lg.setAttribute('position', new THREE.BufferAttribute(this.chordLinePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.chordLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xc6dcf6, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, linewidth: 2 }));
    this.chordLines.frustumCulled = false;
    const pg = new THREE.BufferGeometry();
    this.chordFacePos = new Float32Array(14 * 3 * 3);
    pg.setAttribute('position', new THREE.BufferAttribute(this.chordFacePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.chordFace = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0x8fb2e6, transparent: true, opacity: 0.05, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.chordFace.frustumCulled = false;
    this.chordGrp = new THREE.Group(); this.chordGrp.add(this.chordLines, this.chordFace);
    this.scene.add(this.chordGrp);

    this.buildHelix(); this.buildTrails(); this.bindInput();
    // retained on purpose: an unreachable ResizeObserver is garbage-collected
    // even with a live observation, and silently stops firing
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this);
    this._onWinResize = () => this.resize();
    window.addEventListener('resize', this._onWinResize);
    window.addEventListener('orientationchange', this._onWinResize);
    this.resize();
    this.io = new IntersectionObserver(e => { this.onScreen = e[0].isIntersecting; }, { threshold: 0.01 });
    this.io.observe(this); this.onScreen = true;
    this._ai = 0;
  }

  glowTex() {
    if (!HarmonicStage._gt) {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d');
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.22, 'rgba(255,255,255,0.32)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.06)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      HarmonicStage._gt = new THREE.CanvasTexture(c);
    }
    return HarmonicStage._gt;
  }
  makeGlow(hex, size) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex(), color: hex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    s.scale.setScalar(size); return s;
  }
  makeLabel(text, col, strong) {
    const c = document.createElement('canvas'); c.width = 160; c.height = 64;
    const x = c.getContext('2d');
    x.font = `${strong ? 600 : 400} 40px "IBM Plex Mono", ui-monospace, monospace`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#fff'; x.fillText(text, 80, 34);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, color: col, transparent: true, opacity: strong ? 0.9 : 0.6, depthWrite: false }));
    s.scale.set(2.1, 0.84, 1);
    return s;
  }

  /* the whole score at once, as a luminous outer helix */
  buildHelix() {
    const S = this.S, dur = S.duration;
    const step = this.mobile ? 2 : 1;
    const A = S.attacks.filter((c, i) => i % step === 0);
    const N = A.length;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), tt = new Float32Array(N), amp = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const c = A[k], u = c.t / dur;
      const a = u * Math.PI * 2 * HELIX_TURNS - Math.PI / 2;
      pos[k * 3] = Math.cos(a) * HELIX_R;
      pos[k * 3 + 1] = Y0 - 3 + u * (Y_TOP + 8);
      pos[k * 3 + 2] = Math.sin(a) * HELIX_R;
      let bestPc = 1, bestM = 999;
      for (const n of c.notes) if (n.m < bestM) { bestM = n.m; bestPc = n.pc; }
      const cc = pcRGB(bestPc);
      col[k * 3] = cc[0]; col[k * 3 + 1] = cc[1]; col[k * 3 + 2] = cc[2];
      tt[k] = u;
      amp[k] = Math.min(1, (c.notes.length / 9) * 0.6 + (c.vel / 127) * 0.6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
    g.setAttribute('aAmp', new THREE.BufferAttribute(amp, 1));
    this.helixMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uProg: { value: 0 }, uPix: { value: 1 } },
      vertexShader: `attribute vec3 aColor; attribute float aT; attribute float aAmp;
        uniform float uProg, uPix; varying vec3 vC; varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          float d = uProg - aT;
          float lit = d >= 0.0 ? (0.34 + 0.66*exp(-d*3.4)) : (0.04 + 0.13*exp(d*2.6));
          vA = lit; vC = aColor;
          gl_PointSize = uPix * (1.3 + aAmp*3.4) * (24.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d);
          if(r>0.25) discard; float f = smoothstep(0.25,0.0,r);
          gl_FragColor = vec4(vC*vA*f, vA*f); }`,
    });
    this.helixPts = new THREE.Points(g, this.helixMat);
    this.helixPts.frustumCulled = false;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
    this.helixLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x3c4a66, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.helixLine.frustumCulled = false;
    this.playhead = this.makeGlow(0xfff0d0, 3);
    this.playdot = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.helix = new THREE.Group();
    this.helix.add(this.helixLine, this.helixPts, this.playhead, this.playdot);
    this.scene.add(this.helix);
    this.helixPos = pos; this.helixN = N;
  }

  buildTrails() {
    const N = this.trailN = this.mobile ? 1300 : 3400;
    const g = new THREE.BufferGeometry();
    this.tOrigin = new Float32Array(N * 3); this.tVel = new Float32Array(N * 3);
    this.tColor = new Float32Array(N * 3); this.tBirth = new Float32Array(N).fill(-999); this.tDur = new Float32Array(N).fill(1);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aOrigin', new THREE.BufferAttribute(this.tOrigin, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aVel', new THREE.BufferAttribute(this.tVel, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.tColor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.tBirth, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aDur', new THREE.BufferAttribute(this.tDur, 1).setUsage(THREE.DynamicDrawUsage));
    this.trailMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPix: { value: 1 } },
      vertexShader: `attribute vec3 aOrigin, aVel, aColor; attribute float aBirth, aDur;
        uniform float uTime, uPix; varying vec3 vC; varying float vA;
        void main(){
          float age = uTime - aBirth; float k = age / aDur;
          if(k < 0.0 || k > 1.0){ vA = 0.0; gl_Position = vec4(0.0,0.0,2.0,1.0); gl_PointSize = 0.0; return; }
          vec3 p = aOrigin + aVel*age + vec3(0.0,-0.06,0.0)*age*age;
          vA = pow(1.0-k, 1.5); vC = aColor;
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          gl_PointSize = uPix * (0.9 + 2.6*vA) * (24.0 / -mv.z);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d);
          if(r > 0.25) discard; float f = smoothstep(0.25, 0.0, r);
          gl_FragColor = vec4(vC*vA*f, vA*f*0.9); }`,
    });
    this.trails = new THREE.Points(g, this.trailMat);
    this.trails.frustumCulled = false;
    this.scene.add(this.trails);
    this._ti = 0;
  }

  /* every struck note throws its own colour outward from its own register */
  emitAttack(t, cluster) {
    const per = Math.max(2, Math.round((this.mobile ? 4 : 7) * (this.trailScale ?? 1)));
    for (const n of cluster.notes) {
      const dir = this.pcDir[n.pc], y = yOf(n.m), c = pcRGB(n.pc);
      const w = n.v / 127;
      const cnt = Math.max(1, Math.round(per * (0.4 + w)));
      for (let k = 0; k < cnt; k++) {
        const i = this._ti = (this._ti + 1) % this.trailN;
        this.tOrigin[i * 3] = dir.x * RING_R + (Math.random() - 0.5) * 0.4;
        this.tOrigin[i * 3 + 1] = y + (Math.random() - 0.5) * 0.35;
        this.tOrigin[i * 3 + 2] = dir.z * RING_R + (Math.random() - 0.5) * 0.4;
        const out = 0.45 + Math.random() * 1.5 * (0.5 + w);
        this.tVel[i * 3] = dir.x * out + (Math.random() - 0.5) * 0.45;
        this.tVel[i * 3 + 1] = 0.18 + Math.random() * 0.95;
        this.tVel[i * 3 + 2] = dir.z * out + (Math.random() - 0.5) * 0.45;
        const b = 0.65 + w * 0.9;
        this.tColor[i * 3] = c[0] * b; this.tColor[i * 3 + 1] = c[1] * b; this.tColor[i * 3 + 2] = c[2] * b;
        this.tBirth[i] = t; this.tDur[i] = 3.2 + Math.random() * 4.4;
      }
    }
    const g = this.trails.geometry;
    ['aOrigin', 'aVel', 'aColor', 'aBirth', 'aDur'].forEach(k => { g.getAttribute(k).needsUpdate = true; });
  }

  wave(t, cluster) {
    if (t - this._lastWave < 0.16) return;
    this._lastWave = t;
    const m = this.waves[this._wi = (this._wi + 1) % this.waves.length];
    m.visible = true; m.userData.age = 0;
    m.userData.str = Math.min(1, cluster.notes.length / 9);
    let bestPc = 1, bestM = 999, sumY = 0;
    for (const n of cluster.notes) { if (n.m < bestM) { bestM = n.m; bestPc = n.pc; } sumY += yOf(n.m); }
    const c = pcRGB(bestPc);
    m.material.color.setRGB(c[0], c[1], c[2]);
    m.position.y = sumY / cluster.notes.length;
  }

  bindInput() {
    const el = this.canvas;
    let px = 0, py = 0, id = null, pinch = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && e.isPrimary === false) return;
      id = e.pointerId; px = e.clientX; py = e.clientY; this.cam.drag = true; this.cam.idle = 0;
      el.style.cursor = 'grabbing'; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.cam.drag || e.pointerId !== id) return;
      const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
      this.cam.vT = -dx * 0.005; this.cam.vP = -dy * 0.004;
      this.cam.theta += this.cam.vT;
      this.cam.phi = Math.max(0.2, Math.min(2.6, this.cam.phi + this.cam.vP));
    });
    const up = () => { this.cam.drag = false; id = null; el.style.cursor = 'grab'; };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.radius = Math.max(13, Math.min(64, this.cam.radius * (1 + e.deltaY * 0.0012)));
      this.cam.idle = 0;
    }, { passive: false });
    el.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.cam.radius = Math.max(13, Math.min(64, this.cam.radius * pinch / d)); pinch = d; this.cam.idle = 0;
      }
    }, { passive: true });
    el.addEventListener('touchend', () => { pinch = null; }, { passive: true });
  }

  setLayer(name, on) {
    this.layers[name] = on;
    if (!this.scene) return;
    if (name === 'bell') { this.bell.visible = on; if (!on) this.waves.forEach(w => { w.visible = false; }); }
    if (name === 'fifths') { this.field.visible = on; this.beads.visible = on; this.beadGlow.visible = on; }
    if (name === 'chord') this.chordGrp.visible = on;
    if (name === 'helix') this.helix.visible = on;
    if (name === 'trails') this.trails.visible = on;
    if (name === 'field') this.stars.visible = on;
  }
  resetCamera() { this.cam.theta = 0.62; this.cam.phi = 1.30; this.cam.radius = this.mobile ? 34 : 25; }
  focusPitch(pc) {
    const i = fifthsIndex(pc);
    this.cam.theta = -(i / 12 * Math.PI * 2 - Math.PI / 2) + Math.PI;
    this.cam.phi = 1.44; this.cam.radius = 20; this.cam.idle = -6;
  }

  resize() {
    if (!this.renderer) return;
    const w = this.clientWidth || 1, h = this.clientHeight || 1;
    this._w = this.clientWidth; this._h = this.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const pix = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.6 : 2) * Math.min(1.6, h / 700);
    if (this.helixMat) this.helixMat.uniforms.uPix.value = pix;
    if (this.trailMat) this.trailMat.uniforms.uPix.value = pix;
  }

  start() {
    let last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      // see plates.js: do not trust ResizeObserver delivery alone
      if (this.clientWidth !== this._w || this.clientHeight !== this._h) this.resize();
      if (!this.onScreen) return;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(tick);
  }

  update(dt) {
    const F = this.F, S = this.S;
    const t = this.audio ? this.audio.currentTime : this._t;
    const playing = this.audio ? !this.audio.paused : false;
    const prev = this._t; this._t = t;
    const env = F.env[F.frameAt(t)];
    const sounding = S.pcEnergyAt(t, this._pcE, this._buf);
    this._sounding = sounding;

    // ---- attacks straight off the score
    if (playing) {
      const AT = S.attacks;
      if (t < prev || t - prev > 1.0) {
        this._ai = 0;
        while (this._ai < AT.length && AT[this._ai].t < t) this._ai++;
      }
      while (this._ai < AT.length && AT[this._ai].t <= t) {
        const c = AT[this._ai];
        if (this.layers.trails) this.emitAttack(t, c);
        if (this.layers.bell) this.wave(t, c);
        this._ai++;
      }
    }

    // ---- camera
    const cm = this.cam;
    if (!cm.drag) {
      cm.idle += dt; cm.vT *= 0.90; cm.vP *= 0.90;
      cm.theta += cm.vT + (cm.idle > 2 ? 0.00042 + env * 0.0011 : 0);
      cm.phi = Math.max(0.2, Math.min(2.6, cm.phi + cm.vP));
    }
    const rad = cm.radius * (1 - env * 0.09);
    const cy = Y_TOP * 0.42;
    this.camera.position.set(
      rad * Math.sin(cm.phi) * Math.cos(cm.theta),
      cy + rad * Math.cos(cm.phi),
      rad * Math.sin(cm.phi) * Math.sin(cm.theta));
    this.camera.lookAt(0, cy + env * 1.4, 0);

    // ---- bell
    if (this.layers.bell) {
      for (let i = 0; i < this.shells.length; i++) {
        const b = F.bands[i][F.frameAt(t)] / 255;
        const m = this.shells[i];
        m.scale.setScalar(1 + b * 0.55 + env * 0.1);
        m.material.opacity = 0.02 + b * 0.22;
        m.rotation.y += dt * (0.05 + i * 0.012) * (i % 2 ? 1 : -1);
        m.rotation.x += dt * 0.02 * (i % 3 ? 1 : -1);
      }
      this.core.scale.setScalar(0.5 + env * 1.2);
      this.core.material.opacity = Math.min(1, 0.3 + env * 2);
      this.coreGlow.scale.setScalar(1.8 + env * 6);
      this.coreGlow.material.opacity = Math.min(0.45, 0.07 + env * 0.6);
      for (const w of this.waves) {
        if (!w.visible) continue;
        w.userData.age += dt;
        const k = w.userData.age / 1.9;
        if (k >= 1) { w.visible = false; continue; }
        const s = 0.8 + k * (3.6 + w.userData.str * 5.5);
        w.scale.set(s, s, s);
        w.material.opacity = (1 - k) * (1 - k) * 0.26 * (0.35 + w.userData.str);
      }
    }

    // ---- note beads + strings
    const d = this._dummy, col = this._col;
    let bi = 0;
    if (this.layers.fifths) {
      for (const o of sounding) {
        if (bi >= MAX_BEADS) break;
        const n = o.n, dir = this.pcDir[n.pc], y = yOf(n.m);
        const c = pcRGB(n.pc);
        const s = 0.16 + Math.min(1, o.w) * 0.42;
        d.position.set(dir.x * RING_R, y, dir.z * RING_R);
        d.scale.setScalar(s); d.rotation.set(0, 0, 0); d.updateMatrix();
        this.beads.setMatrixAt(bi, d.matrix);
        const b = 0.5 + Math.min(1, o.w) * 0.9;
        col.setRGB(Math.min(1, c[0] * b), Math.min(1, c[1] * b), Math.min(1, c[2] * b));
        this.beads.setColorAt(bi, col);
        d.scale.setScalar(1.0 + Math.min(1, o.w) * 3.8);
        d.quaternion.copy(this.camera.quaternion); d.updateMatrix();
        this.beadGlow.setMatrixAt(bi, d.matrix);
        this.beadGlow.setColorAt(bi, col);
        bi++;
      }
      d.scale.setScalar(0); d.updateMatrix();
      for (let k = bi; k < MAX_BEADS; k++) { this.beads.setMatrixAt(k, d.matrix); this.beadGlow.setMatrixAt(k, d.matrix); }
      this.beads.instanceMatrix.needsUpdate = true;
      this.beadGlow.instanceMatrix.needsUpdate = true;
      if (this.beads.instanceColor) this.beads.instanceColor.needsUpdate = true;
      if (this.beadGlow.instanceColor) this.beadGlow.instanceColor.needsUpdate = true;
      for (let pc = 0; pc < 12; pc++) this.strings[pc].material.opacity = 0.11 + Math.min(1, this._pcE[pc]) * 0.55;
    }

    // ---- chord: ladder through the sounding notes + pitch-class hull
    if (this.layers.chord) {
      const ns = sounding.filter(o => o.w > (this.chordThresh ?? 0.12)).map(o => o.n).sort((a, b) => a.m - b.m);
      let li = 0;
      for (let k = 1; k < ns.length && li < this.chordLinePos.length - 6; k++) {
        const a = ns[k - 1], b = ns[k];
        const da = this.pcDir[a.pc], db = this.pcDir[b.pc];
        this.chordLinePos[li++] = da.x * RING_R; this.chordLinePos[li++] = yOf(a.m); this.chordLinePos[li++] = da.z * RING_R;
        this.chordLinePos[li++] = db.x * RING_R; this.chordLinePos[li++] = yOf(b.m); this.chordLinePos[li++] = db.z * RING_R;
      }
      this.chordLines.geometry.setDrawRange(0, li / 3);
      this.chordLines.geometry.getAttribute('position').needsUpdate = true;
      this.chordLines.material.opacity = 0.3 + env * 0.5;
      if (ns.length) {
        const lowest = ns[0].pc, c = pcRGB(lowest);
        this.chordLines.material.color.setRGB(c[0] * 0.6 + 0.4, c[1] * 0.6 + 0.4, c[2] * 0.6 + 0.4);
        this.chordFace.material.color.setRGB(c[0], c[1], c[2]);
      }
      const pcs = [...new Set(ns.map(n => n.pc))].sort((a, b) => fifthsIndex(a) - fifthsIndex(b));
      let ti = 0;
      if (pcs.length >= 3) {
        let my = 0; for (const n of ns) my += yOf(n.m); my /= ns.length;
        for (let k = 0; k < pcs.length && ti < this.chordFacePos.length - 9; k++) {
          const p1 = this.pcDir[pcs[k]], p2 = this.pcDir[pcs[(k + 1) % pcs.length]];
          this.chordFacePos[ti++] = 0; this.chordFacePos[ti++] = my; this.chordFacePos[ti++] = 0;
          this.chordFacePos[ti++] = p1.x * RING_R; this.chordFacePos[ti++] = my; this.chordFacePos[ti++] = p1.z * RING_R;
          this.chordFacePos[ti++] = p2.x * RING_R; this.chordFacePos[ti++] = my; this.chordFacePos[ti++] = p2.z * RING_R;
        }
      }
      this.chordFace.geometry.setDrawRange(0, ti / 3);
      this.chordFace.geometry.getAttribute('position').needsUpdate = true;
      this.chordFace.material.opacity = 0.018 + env * 0.06;
    }

    // ---- helix + playhead
    if (this.layers.helix) {
      const u = Math.max(0, Math.min(1, t / S.duration));
      this.helixMat.uniforms.uProg.value = u;
      const k = Math.min(this.helixN - 1, Math.round(u * (this.helixN - 1)));
      const hp = this.helixPos;
      this.playdot.position.set(hp[k * 3], hp[k * 3 + 1], hp[k * 3 + 2]);
      this.playhead.position.copy(this.playdot.position);
      this.playhead.scale.setScalar(1.8 + env * 6);
      this.playhead.material.opacity = 0.32 + env * 0.5;
    }
    if (this.layers.trails) this.trailMat.uniforms.uTime.value = t;
    this.stars.rotation.y += dt * 0.004;

    if (this.onFrame) this.onFrame(t, env, this._pcE, sounding);
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
}
customElements.define('harmonic-stage', HarmonicStage);
