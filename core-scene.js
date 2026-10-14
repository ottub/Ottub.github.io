import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

/*
 * i want — live core scene (v3)
 * DOM-free: the same module runs inside core-worker.js (OffscreenCanvas, off the main thread) and,
 * as a fallback, on the main thread from live-core.js. It only builds the scene and draws a pose;
 * when to draw (visibility, motion settings, size) is decided by live-core.js.
 *
 * A hub-mounted gimbal wheel:
 *   wheel  = armoured sphere + equatorial collar + 6 hydraulic struts + heavy rim ring
 *            (spins slowly about its own axle, which points roughly at the viewer)
 *   swing  = second gimbal ring, hung on two trunnion axles (hub -> swing ring -> rim)
 *            and rocking about that axle axis
 *   heart  = opening in the shell: lip, stepped tunnel, parabolic reflector,
 *            glowing nucleus, counter-rotating iris and a cross-spoke hub
 * Glow is faked with unlit emissive geometry, a strip shader and additive sprites.
 */

const TAU = Math.PI * 2;

// 2D canvases for the procedural textures: a DOM canvas on the main thread, an OffscreenCanvas in a worker.
function makeCanvas(size) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
  return new OffscreenCanvas(size, size);
}

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
const WHITE = [1, 1, 1];

// Collects many parts into one indexed geometry so each material costs one draw call.
class Builder {
  constructor() { this.p = []; this.n = []; this.t = []; this.c = []; this.i = []; }
  get count() { return this.p.length / 3; }
  vert(x, y, z, nx, ny, nz, u = 0, v = 0, col = WHITE) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, v); this.c.push(col[0], col[1], col[2]);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  // Flat polygon (Newell normal), oriented so that its normal points away from `ref`.
  poly(pts, ref, uv = [0.5, 0.75], col = WHITE) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) return;
    _n.set(nx / len, ny / len, nz / len);
    if (ref) {
      _c.set(0, 0, 0); for (const p of pts) _c.add(p);
      _c.multiplyScalar(1 / pts.length).sub(ref);
      if (_n.dot(_c) < 0) { pts = pts.slice().reverse(); _n.negate(); }
    }
    const base = this.count;
    for (const p of pts) this.vert(p.x, p.y, p.z, _n.x, _n.y, _n.z, uv[0], uv[1], col);
    for (let k = 1; k < pts.length - 1; k++) this.tri(base, base + k, base + k + 1);
  }
  // Append a stock BufferGeometry through a (non-mirroring) matrix.
  add(geo, matrix, uvRect, col = WHITE) {
    const pa = geo.attributes.position, na = geo.attributes.normal, ta = geo.attributes.uv;
    _m3.getNormalMatrix(matrix);
    const base = this.count;
    for (let k = 0; k < pa.count; k++) {
      _p.fromBufferAttribute(pa, k).applyMatrix4(matrix);
      _n.fromBufferAttribute(na, k).applyMatrix3(_m3).normalize();
      let u = ta ? ta.getX(k) : 0, v = ta ? ta.getY(k) : 0;
      if (uvRect) { u = uvRect[0] + u * (uvRect[2] - uvRect[0]); v = uvRect[1] + v * (uvRect[3] - uvRect[1]); }
      this.vert(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, u, v, col);
    }
    if (geo.index) for (let k = 0; k < geo.index.count; k++) this.i.push(base + geo.index.getX(k));
    else for (let k = 0; k < pa.count; k++) this.i.push(base + k);
    geo.dispose();
  }
  mesh(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    if (material.vertexColors) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return new THREE.Mesh(g, material);
  }
}

const mat4 = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
const mul = (a, b) => new THREE.Matrix4().multiplyMatrices(a, b);
// cylinders with their axis on X (radial, for struts/axles) or Z (ring normal)
const cylX = (r0, r1, len, seg = 20) => new THREE.CylinderGeometry(r1, r0, len, seg, 1).rotateZ(-Math.PI / 2);
const cylZ = (r, len, seg = 24) => new THREE.CylinderGeometry(r, r, len, seg, 1).rotateX(Math.PI / 2);

/*
 * Sweep a closed (r,z) profile, counter-clockwise, around the Z axis from a0 to a1 (a0 < a1).
 * Each profile edge gets its own flat normal, so chamfers and grooves stay crisp.
 */
function sweep(b, prof, a0, a1, steps, o = {}) {
  const n = prof.length, m = o.matrix;
  if (m) _m3.getNormalMatrix(m);
  const col = o.color || WHITE;
  const uvf = o.uv || (() => [0.5, 0.75]);
  const put = (r, z, th, nr, nz, f, v) => {
    const cs = Math.cos(th), sn = Math.sin(th);
    _p.set(r * cs, r * sn, z); _n.set(nr * cs, nr * sn, nz);
    if (m) { _p.applyMatrix4(m); _n.applyMatrix3(_m3).normalize(); }
    const uv = uvf(th, f, v);
    return b.vert(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, uv[0], uv[1], col);
  };
  for (let e = 0; e < n; e++) {
    const A = prof[e], B = prof[(e + 1) % n];
    const dr = B.r - A.r, dz = B.z - A.z, len = Math.hypot(dr, dz);
    if (len < 1e-9) continue;
    const nr = dz / len, nz = -dr / len;
    const ev = o.edgeV ? o.edgeV[e] : [0.75, 0.75];
    const base = b.count;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps, th = a0 + (a1 - a0) * f;
      put(A.r, A.z, th, nr, nz, f, ev[0]); put(B.r, B.z, th, nr, nz, f, ev[1]);
    }
    for (let s = 0; s < steps; s++) { const q = base + 2 * s; b.tri(q, q + 2, q + 1); b.tri(q + 1, q + 2, q + 3); }
  }
  if (!o.caps) return;
  const faces = THREE.ShapeUtils.triangulateShape(prof.map(p => new THREE.Vector2(p.r, p.z)), []);
  for (const [th, side] of [[a0, -1], [a1, 1]]) {
    const cs = Math.cos(th), sn = Math.sin(th), tx = -sn * side, ty = cs * side;
    const base = b.count;
    for (const p of prof) {
      _p.set(p.r * cs, p.r * sn, p.z); _n.set(tx, ty, 0);
      if (m) { _p.applyMatrix4(m); _n.applyMatrix3(_m3).normalize(); }
      b.vert(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, 0.5, 0.72, col);
    }
    for (const [i, j, k] of faces) {
      const P = prof[i], Q = prof[j], R = prof[k];
      const area = (Q.r - P.r) * (R.z - P.z) - (R.r - P.r) * (Q.z - P.z); // CCW in (r,z) faces -tangent
      if ((area > 0) === (side < 0)) b.tri(base + i, base + j, base + k);
      else b.tri(base + i, base + k, base + j);
    }
  }
}

const rect = (r0, r1, z0, z1, ch = 0) => ch > 0 ? [
  {r: r0 + ch, z: z0}, {r: r1 - ch, z: z0}, {r: r1, z: z0 + ch}, {r: r1, z: z1 - ch},
  {r: r1 - ch, z: z1}, {r: r0 + ch, z: z1}, {r: r0, z: z1 - ch}, {r: r0, z: z0 + ch}
] : [{r: r0, z: z0}, {r: r1, z: z0}, {r: r1, z: z1}, {r: r0, z: z1}];

// Chamfered box section with a glow groove on the front (optionally back / outer face)
// and a stepped-down inner band on the front (and back) face.
function ringProfile({ri, ro, h, ch, fg, bg, og, step}) {
  const P = [], p = (r, z, f = false) => P.push({r, z, f});
  const sd = step ? step.d : 0, bsd = bg && step ? sd : 0;
  p(ri + ch, -h + bsd);
  if (bsd) { p(step.r - sd, -h + sd); p(step.r, -h); }
  if (bg) { p(bg.c - bg.w / 2, -h); p(bg.c - bg.w / 2, -h + bg.d); p(bg.c + bg.w / 2, -h + bg.d); p(bg.c + bg.w / 2, -h); }
  p(ro - ch, -h); p(ro, -h + ch);
  if (og) { p(ro, og.c - og.w / 2); p(ro - og.d, og.c - og.w / 2); p(ro - og.d, og.c + og.w / 2); p(ro, og.c + og.w / 2); }
  p(ro, h - ch); p(ro - ch, h, true);
  if (fg) { p(fg.c + fg.w / 2, h, true); p(fg.c + fg.w / 2, h - fg.d, true); p(fg.c - fg.w / 2, h - fg.d, true); p(fg.c - fg.w / 2, h, true); }
  if (step) { p(step.r, h, true); p(step.r - sd, h - sd, true); }
  p(ri + ch, h - sd, true); p(ri, h - sd - ch); p(ri, -h + ch + bsd);
  return P;
}

// texture v: front face -> [0,0.5] by radius, every other face -> [0.5,1] by perimeter
function ringEdgeV(prof, ri, w) {
  const n = prof.length, lens = []; let total = 0;
  for (let e = 0; e < n; e++) {
    const A = prof[e], B = prof[(e + 1) % n];
    const len = (A.f && B.f) ? 0 : Math.hypot(B.r - A.r, B.z - A.z);
    lens.push(len); total += len;
  }
  let cum = 0; const out = [];
  for (let e = 0; e < n; e++) {
    const A = prof[e], B = prof[(e + 1) % n];
    if (A.f && B.f) out.push([0.01 + 0.48 * (A.r - ri) / w, 0.01 + 0.48 * (B.r - ri) / w]);
    else { out.push([0.5 + 0.5 * cum / total, 0.5 + 0.5 * (cum + lens[e]) / total]); cum += lens[e]; }
  }
  return out;
}

// strip uv: x = unwrapped angle in turns (drives the travelling pulse), y = 0..1 along the strip
const stripUV = (a0, a1) => (th) => [th / TAU, (th - a0) / (a1 - a0)];

// Heavy segmented gimbal ring: armour segments, clamp collars, glow strips, pivot knuckles.
function buildRing(o, B, glowCol) {
  const ri = o.R - o.W / 2, ro = o.R + o.W / 2, h = o.D / 2;
  const fg = {c: o.R + o.gOff, w: o.gW, d: o.gD};
  const bg = o.twoSided ? {c: o.R + o.gOff, w: o.gW, d: o.gD} : null;
  const og = o.outerGroove ? {c: 0, w: 0.05, d: 0.024} : null;
  const step = {r: fg.c - fg.w / 2 - 0.035, d: 0.016};
  const prof = ringProfile({ri, ro, h, ch: o.ch, fg, bg, og, step});
  const ev = ringEdgeV(prof, ri, o.W);
  const e = 0.018;
  const collarProf = rect(o.collarRi ?? ri - e, ro + e, -h - e, h + e, 0.02);
  const seg = TAU / o.N;
  const stripFront = rect(fg.c - fg.w / 2 + 0.006, fg.c + fg.w / 2 - 0.006, h - fg.d + 0.003, h - fg.d * 0.42);
  const stripBack = stripFront.map(q => ({r: q.r, z: -q.z})).reverse();
  const stripOuter = og ? rect(ro - og.d + 0.003, ro - og.d * 0.4, -og.w / 2 + 0.006, og.w / 2 - 0.006) : null;
  const addStrips = (s0, s1) => {
    let parts = [[s0, s1]];
    for (const pv of o.pivots) for (const c of [pv - TAU, pv, pv + TAU]) {
      parts = parts.flatMap(([x0, x1]) => (c - o.pivotSkip < x1 && c + o.pivotSkip > x0)
        ? [[x0, c - o.pivotSkip], [c + o.pivotSkip, x1]] : [[x0, x1]]);
    }
    for (const [x0, x1] of parts) {
      if (x1 - x0 < 0.05) continue;
      const steps = Math.max(3, Math.ceil((x1 - x0) * o.R * 10));
      const uv = stripUV(x0, x1);
      sweep(B.strip, stripFront, x0, x1, steps, {uv, caps: true});
      if (o.twoSided) sweep(B.strip, stripBack, x0, x1, steps, {uv, caps: true});
      if (stripOuter) sweep(B.strip, stripOuter, x0, x1, steps, {uv, caps: true});
    }
  };
  for (let k = 0; k < o.N; k++) {
    const c = k * seg, a0 = c - seg / 2 + o.gap / 2, a1 = c + seg / 2 - o.gap / 2;
    sweep(B.armor, prof, a0, a1, o.steps, {caps: true, edgeV: ev, uv: (th, f, v) => [f, v]});
    addStrips(a0 + o.inset, a1 - o.inset);
    const cc = c + seg / 2;
    sweep(B.steel, collarProf, cc - o.collar / 2, cc + o.collar / 2, 3, {caps: true});
    for (const rr of [o.R - o.W * 0.28, o.R + o.W * 0.28]) {
      const x = rr * Math.cos(cc), y = rr * Math.sin(cc);
      B.chrome.add(cylZ(0.017, 0.016, 8), mat4(x, y, h + e + 0.006));
      if (o.twoSided) B.chrome.add(cylZ(0.017, 0.016, 8), mat4(x, y, -h - e - 0.006));
    }
  }
  // pivot knuckles: round bearing housings the ring passes through
  const kr = o.knuckle;
  for (const pv of o.pivots) {
    const x = o.R * Math.cos(pv), y = o.R * Math.sin(pv);
    B.dark.add(cylZ(kr, o.D + 0.05, 40), mat4(x, y, 0));
    const faces = o.twoSided ? [mat4(x, y, 0, 0, 0, pv), mat4(x, y, 0, Math.PI, 0, -pv)] : [mat4(x, y, 0, 0, 0, pv)];
    for (const m of faces) {
      const z0 = h + 0.025;
      sweep(B.chrome, rect(kr * 0.62, kr * 1.02, z0 - 0.01, z0 + 0.03, 0.012), 0, TAU, 40, {matrix: m});
      sweep(B.dark, rect(kr * 0.3, kr * 0.62, z0 - 0.01, z0 + 0.008, 0.006), 0, TAU, 32, {matrix: m});
      sweep(B.glow, rect(kr * 0.4, kr * 0.52, z0 + 0.006, z0 + 0.012), 0, TAU, 32, {matrix: m, color: glowCol});
      sweep(B.chrome, rect(kr * 0.12, kr * 0.3, z0 - 0.01, z0 + 0.04, 0.01), 0, TAU, 24, {matrix: m});
      sweep(B.glow, rect(0.0, kr * 0.12, z0 + 0.02, z0 + 0.034), 0, TAU, 16, {matrix: m, color: glowCol});
      for (let j = 0; j < 4; j++) {
        const a = Math.PI / 4 + j * Math.PI / 2;
        B.chrome.add(cylZ(0.02, 0.018, 6), mul(m, mat4(kr * 0.82 * Math.cos(a), kr * 0.82 * Math.sin(a), z0 + 0.036)));
      }
    }
  }
}

// Thick spherical armour tile with a rounded bevel and side walls.
function sphereTile(b, R, t, th0, th1, ph0, ph1, quad) {
  const bev = 0.02, bd = 0.016;
  const sm = Math.max(Math.sin((th0 + th1) / 2), 0.25);
  const T0 = th0 + bev, T1 = th1 - bev, P0 = ph0 + bev / sm, P1 = ph1 - bev / sm;
  const nu = Math.max(3, Math.ceil((ph1 - ph0) * sm * 12)), nv = Math.max(3, Math.ceil((th1 - th0) * 12));
  const dir = (th, ph, r, out = new THREE.Vector3()) =>
    out.set(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
  const qu = (quad % 2) * 0.5, qv = Math.floor(quad / 2) * 0.5;
  const base = b.count;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    dir(T0 + (T1 - T0) * j / nv, P0 + (P1 - P0) * i / nu, 1, _n);
    b.vert(_n.x * R, _n.y * R, _n.z * R, _n.x, _n.y, _n.z, qu + 0.02 + 0.46 * i / nu, qv + 0.02 + 0.46 * j / nv);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = base + j * (nu + 1) + i;
    b.tri(a, a + nu + 1, a + 1); b.tri(a + 1, a + nu + 1, a + nu + 2);
  }
  const loop = (t0, t1, p0, p1, r) => {
    const pts = [];
    for (let i = 0; i < nu; i++) pts.push(dir(t0, p0 + (p1 - p0) * i / nu, r));
    for (let j = 0; j < nv; j++) pts.push(dir(t0 + (t1 - t0) * j / nv, p1, r));
    for (let i = 0; i < nu; i++) pts.push(dir(t1, p1 - (p1 - p0) * i / nu, r));
    for (let j = 0; j < nv; j++) pts.push(dir(t1 - (t1 - t0) * j / nv, p0, r));
    return pts;
  };
  const L1 = loop(T0, T1, P0, P1, R), L2 = loop(th0, th1, ph0, ph1, R - bd), L3 = loop(th0, th1, ph0, ph1, R - t);
  const ref = dir((th0 + th1) / 2, (ph0 + ph1) / 2, R - t / 2);
  const uv = [qu + 0.25, qv + 0.25];
  for (let k = 0; k < L1.length; k++) {
    const k1 = (k + 1) % L1.length;
    b.poly([L1[k], L1[k1], L2[k1], L2[k]], ref, uv);
    b.poly([L2[k], L2[k1], L3[k1], L3[k]], ref, uv);
  }
}

// local frame on the sphere: x = e_theta, y = e_phi, z = radial
function sphereFrame(th, ph, r) {
  const er = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th));
  const et = new THREE.Vector3(Math.cos(th) * Math.cos(ph), Math.cos(th) * Math.sin(ph), -Math.sin(th));
  const ep = new THREE.Vector3(-Math.sin(ph), Math.cos(ph), 0);
  return new THREE.Matrix4().makeBasis(et, ep, er).setPosition(er.multiplyScalar(r));
}

/* ------------------------------------------------------------------ */
/* procedural surface textures (panel lines, vents, wear), <= 512px    */
/* ------------------------------------------------------------------ */

function rng(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function surfaceTextures(kind, aniso) {
  const S = 512;
  const make = () => { const c = makeCanvas(S); return [c, c.getContext('2d', {willReadFrequently: true})]; };
  const [colC, col] = make(), [hC, hgt] = make(), [, rgh] = make();
  const R = rng(kind === 'ring' ? 7 : 19);
  col.fillStyle = '#d4d4d4'; col.fillRect(0, 0, S, S);
  hgt.fillStyle = '#8c8c8c'; hgt.fillRect(0, 0, S, S);
  rgh.fillStyle = 'rgb(100,100,100)'; rgh.fillRect(0, 0, S, S);
  // soft blotches of grime / polish
  for (let k = 0; k < 70; k++) {
    const x = R() * S, y = R() * S, r = 10 + R() * 50, light = R() < 0.5;
    for (const [ctx, c0, a] of [[col, light ? '255,255,255' : '0,0,0', 0.05], [rgh, light ? '60,60,60' : '170,170,170', 0.22]]) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${c0},${a})`); g.addColorStop(1, `rgba(${c0},0)`);
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  // brushed streaks along u (along the ring / along phi on the shell)
  for (let k = 0; k < 1100; k++) {
    const x = R() * S, y = R() * S, w = 12 + R() * 110, light = R() < 0.55;
    col.fillStyle = light ? `rgba(255,255,255,${0.02 + R() * 0.05})` : `rgba(0,0,0,${0.03 + R() * 0.06})`;
    col.fillRect(x, y, w, 1);
    rgh.fillStyle = light ? `rgba(55,55,55,${0.12 + R() * 0.12})` : `rgba(175,175,175,${0.1 + R() * 0.12})`;
    rgh.fillRect(x, y, w, 1);
  }
  // [ctx, recess colour, raised colour]: recesses are dark, rough and low
  const all = [[col, '#1c1c1c', '#f0f0f0'], [hgt, '#141414', '#e8e8e8'], [rgh, '#b4b4b4', '#5a5a5a']];
  const fill = (draw, light = false) => { for (const [ctx, dark, lit] of all) { ctx.fillStyle = light ? lit : dark; ctx.beginPath(); draw(ctx); ctx.fill(); } };
  const box = (x, y, w, h, light) => fill(ctx => ctx.rect(x, y, w, h), light);
  const dot = (x, y, r, light) => fill(ctx => ctx.arc(x, y, r, 0, TAU), light);
  const frame = (x, y, w, h, lw = 2) => {
    for (const [ctx, dark] of all) { ctx.strokeStyle = dark; ctx.lineWidth = lw; ctx.strokeRect(x + 0.5, y + 0.5, w, h); }
  };
  const bolt = (x, y, r = 4.5) => { dot(x, y, r + 1.5); dot(x, y, r, true); };
  const slant = (x, y, w, h, lean) => fill(ctx => { ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w + lean, y); ctx.lineTo(x + lean, y); ctx.closePath(); });

  if (kind === 'ring') {
    // lower half = front face (radial fraction f: y = 512 - 256 f), upper half = sides / back
    frame(10, 266, 490, 236);
    for (const x0 of [30, 422]) for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) dot(x0 + i * 16, 286 + j * 16, 3.4);
    for (let i = 0; i < 4; i++) { box(204 + i * 28, 446, 20, 6); box(204 + i * 28, 468, 20, 6); }
    frame(128, 432, 52, 50, 1.5); frame(332, 432, 52, 50, 1.5);
    bolt(22, 490, 3.5); bolt(490, 490, 3.5); bolt(22, 278, 3.5); bolt(490, 278, 3.5);
    for (const [ctx] of all) {              // worn, polished segment ends
      if (ctx === hgt) continue;
      const g = ctx.createLinearGradient(0, 0, 36, 0);
      const c = ctx === rgh ? '40,40,40' : '255,255,255';
      g.addColorStop(0, `rgba(${c},0.3)`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, 36, S);
      ctx.save(); ctx.translate(S, 0); ctx.scale(-1, 1); ctx.fillRect(0, 0, 36, S); ctx.restore();
    }
    box(0, 62, S, 2); box(0, 190, S, 2);
    for (let x = 64; x < S; x += 128) { box(x, 112, 18, 7); box(x + 40, 132, 10, 10); }
    bolt(26, 128); bolt(486, 128);
  } else {
    // four tile designs in a 2x2 atlas; quad q -> canvas origin (flipY: v 0..0.5 is the lower half)
    const Q = q => [(q % 2) * 256, (1 - Math.floor(q / 2)) * 256];
    for (let q = 0; q < 4; q++) { const [x, y] = Q(q); frame(x + 16, y + 16, 224, 224); }
    { const [x, y] = Q(0); bolt(x + 36, y + 36); bolt(x + 220, y + 220); box(x + 16, y + 150, 90, 2); }
    { const [x, y] = Q(1); for (let i = 0; i < 6; i++) slant(x + 128 + i * 17, y + 66, 8, 120, -26); bolt(x + 40, y + 216); }
    { const [x, y] = Q(2); for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) dot(x + 52 + i * 18, y + 62 + j * 18, 4); frame(x + 160, y + 170, 60, 34, 1.5); }
    { const [x, y] = Q(3); frame(x + 52, y + 64, 152, 128); for (const [bx, by] of [[66, 78], [190, 78], [66, 178], [190, 178]]) bolt(x + bx, y + by, 4);
      box(x + 16, y + 40, 60, 2); box(x + 90, y + 118, 76, 8); }
  }
  // pack height (R) + roughness (G) into one texture: bumpMap reads .r, roughnessMap reads .g
  const hd = hgt.getImageData(0, 0, S, S), rd = rgh.getImageData(0, 0, S, S).data;
  for (let k = 0; k < hd.data.length; k += 4) { hd.data[k + 1] = rd[k]; hd.data[k + 2] = 0; hd.data[k + 3] = 255; }
  hgt.putImageData(hd, 0, 0);
  const map = new THREE.CanvasTexture(colC); map.colorSpace = THREE.SRGBColorSpace;
  const rb = new THREE.CanvasTexture(hC);
  map.anisotropy = rb.anisotropy = aniso;
  return {map, rb};
}

function glowSprite(stops) {
  const c = makeCanvas(128);
  const ctx = c.getContext('2d'), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, s] of stops) g.addColorStop(o, s);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ------------------------------------------------------------------ */
/* surrounding decoration: orbits + nodes, wire cubes, + marks, halo,  */
/* dust lit by the core. Thin, faint, slow — the wheel stays the hero. */
/* ------------------------------------------------------------------ */

function buildDecor(parent, shared, camDist) {
  const deco = new THREE.Group(); parent.add(deco);
  const scale = shared.uScale;
  const additive = {transparent: true, depthWrite: false, blending: THREE.AdditiveBlending};

  // ① orbit ellipses: 1px lines, each with its own tilt; ② a comet head runs each orbit
  const orbitDefs = [
    {R: 2.28, rot: [0.28, 1.22, 0.32], speed: 0.021, phase: 0.10, alpha: 0.56, dash: 0},
    {R: 2.26, rot: [1.20, 0.18, -0.55], speed: -0.016, phase: 0.55, alpha: 0.44, dash: 120},
    {R: 2.08, rot: [-0.62, -0.52, 0.95], speed: 0.027, phase: 0.80, alpha: 0.30, dash: 0},
  ];
  const orbits = new THREE.Group(); deco.add(orbits);
  const mats = orbitDefs.map(o => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...o.rot)));
  const onOrbit = (k, t, out) => out.set(orbitDefs[k].R * Math.cos(t * TAU), orbitDefs[k].R * Math.sin(t * TAU), 0).applyMatrix4(mats[k]);
  const SEG = 240, pos = [], aT = [], aS = [], aP = [], aA = [], aD = [];
  const v = new THREE.Vector3();
  orbitDefs.forEach((o, k) => {
    for (let i = 0; i < SEG; i++) for (const j of [i, i + 1]) {
      onOrbit(k, j / SEG, v); pos.push(v.x, v.y, v.z);
      aT.push(j / SEG); aS.push(o.speed); aP.push(o.phase); aA.push(o.alpha); aD.push(o.dash);
    }
  });
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  for (const [name, arr] of [['aT', aT], ['aSpeed', aS], ['aPhase', aP], ['aAlpha', aA], ['aDash', aD]]) og.setAttribute(name, new THREE.Float32BufferAttribute(arr, 1));
  const orbitMat = new THREE.ShaderMaterial({...additive,
    uniforms: {uTime: shared.uTime, uBreath: shared.uBreath, uDist: {value: camDist}},
    vertexShader: `attribute float aT; attribute float aSpeed; attribute float aPhase; attribute float aAlpha; attribute float aDash;
      uniform float uTime; uniform float uDist;
      varying float vT; varying float vHead; varying float vDir; varying float vAlpha; varying float vDash; varying float vFade;
      void main(){ vT = aT; vHead = fract(uTime * aSpeed + aPhase); vDir = sign(aSpeed); vAlpha = aAlpha; vDash = aDash;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFade = clamp(0.62 + 0.16 * (mv.z + uDist), 0.3, 1.0);      // far side of an orbit is dimmer
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uBreath;
      varying float vT; varying float vHead; varying float vDir; varying float vAlpha; varying float vDash; varying float vFade;
      void main(){
        float d = fract((vHead - vT) * vDir);                   // 0 at the head, grows along the tail
        float tail = exp(-d * 14.0);
        float dash = vDash > 0.5 ? step(0.45, fract(vT * vDash)) : 1.0;
        float a = (vAlpha * dash * (0.85 + 0.15 * uBreath) + tail * 1.0) * vFade;
        gl_FragColor = vec4(mix(vec3(0.36, 0.95, 0.64), vec3(0.86, 1.0, 0.93), tail), clamp(a, 0.0, 1.0)); }`
  });
  orbits.add(new THREE.LineSegments(og, orbitMat));

  // ② nodes: static markers on the orbits + the moving comet heads
  const nodeDefs = [[0, 0.12], [0, 0.63], [1, 0.34], [1, 0.81], [2, 0.47], [2, 0.93]];
  const nodeCount = nodeDefs.length + orbitDefs.length;
  const np = new Float32Array(nodeCount * 3), ns = new Float32Array(nodeCount), nglow = new Float32Array(nodeCount);
  nodeDefs.forEach(([k, t], i) => { onOrbit(k, t, v); np.set([v.x, v.y, v.z], i * 3); ns[i] = 8; nglow[i] = 0.8; });
  for (let k = 0; k < orbitDefs.length; k++) { ns[nodeDefs.length + k] = 13; nglow[nodeDefs.length + k] = 1; }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.BufferAttribute(np, 3));
  ng.setAttribute('aSize', new THREE.BufferAttribute(ns, 1));
  ng.setAttribute('aGlow', new THREE.BufferAttribute(nglow, 1));
  const nodeMat = new THREE.ShaderMaterial({...additive,
    uniforms: {uScale: scale},
    vertexShader: `attribute float aSize; attribute float aGlow; uniform float uScale; varying float vGlow;
      void main(){ vGlow = aGlow; gl_PointSize = max(3.0, aSize * uScale); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vGlow;
      void main(){ float r = length(gl_PointCoord - 0.5) * 2.0;
        float core = smoothstep(0.38, 0.0, r), halo = pow(max(0.0, 1.0 - r), 2.0) * 0.45;
        gl_FragColor = vec4(mix(vec3(0.4, 1.0, 0.68), vec3(0.92, 1.0, 0.96), core), (core + halo) * vGlow); }`
  });
  const nodes = new THREE.Points(ng, nodeMat); nodes.frustumCulled = false; orbits.add(nodes);

  // ③ floating wireframe cubes
  const cubeMat = new THREE.LineBasicMaterial({color: 0x9ccfb6, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false});
  const cubes = [
    {p: [1.9, 1.8, 0.2], s: 0.28, w: [0.13, 0.19], ph: 0.0},
    {p: [-2.15, 1.0, -0.4], s: 0.22, w: [-0.17, 0.11], ph: 1.7},
    {p: [-1.7, -1.9, 0.4], s: 0.26, w: [0.1, -0.15], ph: 3.1},
    {p: [2.15, -1.1, -0.2], s: 0.19, w: [-0.12, -0.2], ph: 4.4},
  ].map(c => {
    const box = new THREE.BoxGeometry(c.s, c.s, c.s), edges = new THREE.EdgesGeometry(box); box.dispose();
    const m = new THREE.LineSegments(edges, cubeMat);
    m.position.set(...c.p); m.rotation.set(c.ph, c.ph * 0.7, 0.3); deco.add(m);
    return {m, c, dx: 0};
  });

  // ④ + marks: points always facing the screen
  const marks = [[-2.1, 1.65, 0.0], [2.2, 0.5, 0.1], [1.6, -2.05, 0.2], [-1.2, -2.15, -0.2], [0.55, 2.2, -0.3], [-2.25, -0.55, 0.0]];
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(marks.flat(), 3));
  mg.setAttribute('aPhase', new THREE.Float32BufferAttribute(marks.map((_, i) => i * 1.9), 1));
  const markMat = new THREE.ShaderMaterial({...additive,
    uniforms: {uTime: shared.uTime, uScale: scale},
    vertexShader: `attribute float aPhase; uniform float uTime; uniform float uScale; varying float vSize; varying float vA;
      void main(){ vSize = max(7.0, 13.0 * uScale); gl_PointSize = vSize;
        vA = 0.42 * (0.78 + 0.22 * sin(uTime * 0.4 + aPhase));   // slow, no flicker
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vSize; varying float vA;
      void main(){ vec2 p = abs(gl_PointCoord - 0.5) * 2.0; float w = 1.15 / vSize;
        float a = (p.x < w || p.y < w) ? 1.0 : 0.0;
        a *= 1.0 - 0.5 * smoothstep(0.6, 1.0, max(p.x, p.y));
        gl_FragColor = vec4(0.58, 0.92, 0.74, a * vA); }`
  });
  const markAttr = mg.attributes.position;
  const markPts = new THREE.Points(mg, markMat); markPts.frustumCulled = false; deco.add(markPts);

  // ⑤ wide soft halo behind the wheel
  const haloMat = new THREE.SpriteMaterial({...additive, toneMapped: false,
    map: glowSprite([[0, 'rgba(70,210,130,0.34)'], [0.4, 'rgba(35,150,90,0.15)'], [0.75, 'rgba(20,90,55,0.04)'], [1, 'rgba(0,0,0,0)']])});
  const halo = new THREE.Sprite(haloMat); halo.position.z = -1.6; halo.scale.set(6.0, 6.0, 1); deco.add(halo);

  // dust lit by the core
  const R = rng(29), DUST = 180;
  const dp = [], dph = [], dsz = [];
  while (dp.length < DUST * 3) {
    v.set(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1); if (v.lengthSq() > 1 || v.lengthSq() < 0.01) continue;
    v.normalize().multiplyScalar(1.35 + 1.15 * Math.pow(R(), 0.7)); v.z *= 0.6;
    if (Math.hypot(v.x, v.y) > 2.25) continue;
    dp.push(v.x, v.y, v.z); dph.push(R() * TAU); dsz.push(1.6 + R() * 1.6);
  }
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
  dg.setAttribute('aPhase', new THREE.Float32BufferAttribute(dph, 1));
  dg.setAttribute('aSize', new THREE.Float32BufferAttribute(dsz, 1));
  const dustMat = new THREE.ShaderMaterial({...additive,
    uniforms: {uTime: shared.uTime, uBreath: shared.uBreath, uScale: scale, uDist: {value: camDist}},
    vertexShader: `attribute float aPhase; attribute float aSize; uniform float uTime; uniform float uBreath; uniform float uScale; uniform float uDist;
      varying float vA;
      void main(){ vec3 p = position;
        p.y += sin(uTime * 0.23 + aPhase) * 0.06; p.x += cos(uTime * 0.17 + aPhase * 1.7) * 0.05;
        float d = length(p), lit = 0.15 + 1.1 / (1.0 + d * d * 0.55);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = max(2.2, aSize * uScale * uDist / -mv.z);
        vA = lit * (0.55 + 0.2 * uBreath) * (0.75 + 0.25 * sin(uTime * 0.5 + aPhase * 3.0));
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vA;
      void main(){ float r = length(gl_PointCoord - 0.5) * 2.0;
        gl_FragColor = vec4(0.6, 1.0, 0.8, pow(max(0.0, 1.0 - r), 1.5) * vA * 0.5); }`
  });
  const dust = new THREE.Points(dg, dustMat); dust.frustumCulled = false; deco.add(dust);

  const headAttr = ng.attributes.position;
  return {
    group: deco,
    // Keep cubes and + marks inside the part of the canvas that is on screen (u0..u1 across the
    // drawn square), 6% in from any edge the viewport cuts. Edges that are not cut impose nothing,
    // so a fully visible canvas (1440 layout) keeps the authored positions.
    fit(u0, u1) {
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(15));        // camera fov 30
      const lim = (z, half) => {
        const w = (camDist - z) * tanHalf;
        return [u0 > 0.001 ? (2 * (u0 + 0.06) - 1) * w + half : -Infinity, u1 < 0.999 ? (2 * (u1 - 0.06) - 1) * w - half : Infinity];
      };
      const clampX = (x, [lo, hi]) => Math.min(Math.max(x, lo), hi);
      for (const q of cubes) {
        const x = deco.position.x + q.c.p[0];
        q.dx = clampX(x, lim(q.c.p[2], q.c.s * 0.87 + 0.05)) - x;
      }
      marks.forEach((mk, i) => markAttr.setX(i, clampX(deco.position.x + mk[0], lim(mk[2], 0.06)) - deco.position.x));
      markAttr.needsUpdate = true;
    },
    update(t, b) {
      orbits.rotation.set(0.03 * Math.sin(0.07 * t), 0.05 * Math.sin(0.05 * t + 1), 0);
      orbitDefs.forEach((o, k) => {
        const h = ((t * o.speed + o.phase) % 1 + 1) % 1;
        onOrbit(k, h, v); headAttr.setXYZ(nodeDefs.length + k, v.x, v.y, v.z);
      });
      headAttr.needsUpdate = true;
      for (const q of cubes) {
        const {m, c} = q;
        m.rotation.x = c.ph + t * c.w[0]; m.rotation.y = c.ph * 0.7 + t * c.w[1];
        m.position.y = c.p[1] + 0.07 * Math.sin(t * 0.45 + c.ph);
        m.position.x = c.p[0] + q.dx + 0.04 * Math.sin(t * 0.31 + c.ph * 2);
      }
      dust.rotation.y = t * 0.012;
      haloMat.opacity = 0.55 * (0.85 + 0.2 * b);
    }
  };
}


export function createCore(renderer, {dpr = 1} = {}) {
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(dpr, 1.25));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40);
  camera.position.set(0, 0, 10.3);   // wheel ~70% of the width, room for the decoration
  camera.lookAt(0, 0, 0);

  let envTarget = null;
  const buildEnvironment = () => {       // also re-run after a context restore (the PMREM target is lost)
    const room = new RoomEnvironment();
    let pmrem = null;
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      const next = pmrem.fromScene(room, 0.04);
      const previous = envTarget;             // swap first, dispose the old target only after success
      envTarget = next; scene.environment = next.texture;
      if (previous) previous.dispose();
    } finally {
      if (pmrem) pmrem.dispose();
      if (room.dispose) room.dispose();
    }
  };
  buildEnvironment();

  scene.add(new THREE.HemisphereLight(0xc4d9d2, 0x040706, 0.55));
  const key = new THREE.DirectionalLight(0xf3f7f5, 3.4); key.position.set(-4, 5, 6); scene.add(key);
  const rim = new THREE.DirectionalLight(0xcfe0ff, 2.2); rim.position.set(5, 3, -4); scene.add(rim);
  const under = new THREE.DirectionalLight(0x4dffa0, 1.3); under.position.set(2, -5, -1); scene.add(under);

  const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const ringTex = surfaceTextures('ring', aniso), tileTex = surfaceTextures('tile', aniso);

  const armorMat = new THREE.MeshStandardMaterial({color: 0x48504e, metalness: 0.86, roughness: 1,
    map: ringTex.map, roughnessMap: ringTex.rb, bumpMap: ringTex.rb, bumpScale: 1.3, envMapIntensity: 1.0});
  const shellMat = new THREE.MeshStandardMaterial({color: 0x3d4543, metalness: 0.84, roughness: 1,
    map: tileTex.map, roughnessMap: tileTex.rb, bumpMap: tileTex.rb, bumpScale: 1.3, envMapIntensity: 1.0});
  const chromeMat = new THREE.MeshStandardMaterial({color: 0xa7b1ae, metalness: 1, roughness: 0.25, envMapIntensity: 1.25});
  const steelMat = new THREE.MeshStandardMaterial({color: 0x737d7a, metalness: 1, roughness: 0.34, envMapIntensity: 1.1});
  const darkMat = new THREE.MeshStandardMaterial({color: 0x1a201e, metalness: 0.8, roughness: 0.42, envMapIntensity: 0.9});
  const underMat = new THREE.MeshStandardMaterial({color: 0x070b09, metalness: 0.6, roughness: 0.55,
    emissive: 0x1f8a52, emissiveIntensity: 0.35});
  const glowMat = new THREE.MeshBasicMaterial({vertexColors: true, toneMapped: false});

  const lin = (hex, k = 1) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };
  const MINT = lin(0x6dffb2, 1.35), HOT = lin(0xeafff4, 1.6);

  const uniforms = {uTime: {value: 0}, uBreath: {value: 0.5}};
  const stripMat = new THREE.ShaderMaterial({
    uniforms: {uTime: uniforms.uTime, uBreath: uniforms.uBreath,
      uColor: {value: new THREE.Vector3(0.30, 0.93, 0.62)}, uHot: {value: new THREE.Vector3(0.86, 1.0, 0.93)}},
    vertexShader: `varying vec2 vUv; varying float vFace;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFace = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform float uBreath; uniform vec3 uColor; uniform vec3 uHot;
      varying vec2 vUv; varying float vFace;
      float pulse(float a){ float d = 0.5 - abs(fract(a) - 0.5); return exp(-d * d * 1400.0); }
      void main(){
        float a = vUv.x - uTime * 0.042;
        float p = max(pulse(a), pulse(a + 0.5) * 0.7);
        float ends = smoothstep(0.0, 0.1, vUv.y) * smoothstep(1.0, 0.9, vUv.y);
        float lvl = (0.62 + 0.28 * uBreath) * (0.45 + 0.55 * ends) + p * 0.9;
        vec3 col = mix(uColor, uHot, clamp(p * 0.85 + 0.12 * uBreath, 0.0, 1.0)) * lvl * (0.7 + 0.3 * vFace);
        gl_FragColor = vec4(col, 1.0); }`
  });
  const nucleusMat = new THREE.ShaderMaterial({
    uniforms: {uTime: uniforms.uTime, uBreath: uniforms.uBreath},
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform float uBreath; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){
        float f = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float r = length(vP.xy) / 0.36;
        float ang = atan(vP.y, vP.x);
        float ripple = 0.5 + 0.5 * sin(r * 24.0 - uTime * 1.3);
        float swirl = 0.5 + 0.5 * sin(ang * 3.0 + r * 6.0 - uTime * 0.45);
        float heat = pow(f, 3.0);
        vec3 deep = vec3(0.03, 0.30, 0.16), mint = vec3(0.32, 0.98, 0.63), hot = vec3(0.88, 1.0, 0.94);
        vec3 col = mix(deep, mint, smoothstep(0.05, 0.85, f));
        col += hot * heat * (0.5 + 0.4 * uBreath);
        col *= 0.8 + 0.14 * ripple * (1.0 - heat) + 0.08 * swirl;
        gl_FragColor = vec4(col, 1.0); }`
  });

  // ---- hierarchy -------------------------------------------------
  const base = new THREE.Group();          // fixed 3/4 view: the axle points right-down toward the viewer
  base.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0.45, -0.30, 0.84).normalize());
  base.position.set(0.16, -0.08, 0);     // centres the silhouette (perspective pushes it up-left)
  scene.add(base);
  const sway = new THREE.Group(); base.add(sway);
  const wheel = new THREE.Group(); sway.add(wheel);
  const swing = new THREE.Group(); wheel.add(swing);
  const spokes = new THREE.Group(); wheel.add(spokes);
  const iris = new THREE.Group(); wheel.add(iris);

  const W = {armor: new Builder(), shell: new Builder(), steel: new Builder(), chrome: new Builder(), dark: new Builder(), strip: new Builder(), glow: new Builder()};
  const G = {armor: new Builder(), steel: new Builder(), chrome: new Builder(), dark: new Builder(), strip: new Builder(), glow: new Builder()};

  // rim: the wheel's heavy outer ring, knuckles on the trunnion axis (local X)
  buildRing({R: 1.9, W: 0.30, D: 0.24, N: 16, gap: 0.03, collar: 0.062, ch: 0.03, steps: 14,
    gOff: 0.03, gW: 0.06, gD: 0.036, outerGroove: true, twoSided: false, collarRi: 1.675,
    pivots: [0, Math.PI], pivotSkip: 0.15, inset: 0.05, knuckle: 0.2}, W, MINT);
  sweep(W.dark, rect(1.69, 1.77, -0.045, 0.045, 0.012), 0, TAU, 160);            // inner rail
  // swing: second gimbal ring, rocking about the same trunnion axis
  buildRing({R: 1.52, W: 0.22, D: 0.19, N: 14, gap: 0.03, collar: 0.075, ch: 0.024, steps: 12,
    gOff: 0.0, gW: 0.046, gD: 0.028, outerGroove: false, twoSided: true,
    pivots: [0, Math.PI], pivotSkip: 0.15, inset: 0.05, knuckle: 0.14}, G, MINT);

  // trunnion axles: sphere socket -> swing knuckle -> rim knuckle, on +X and -X
  for (const side of [0, Math.PI]) {
    const m = mat4(0, 0, 0, 0, 0, side);
    const at = (geo, x, which, col) => W[which].add(geo, mul(m, mat4(x, 0, 0)), null, col);
    at(cylX(0.135, 0.135, 0.2, 32), 1.13, 'dark');
    at(cylX(0.15, 0.15, 0.035, 32), 1.215, 'chrome');
    at(cylX(0.139, 0.139, 0.014, 32), 1.1, 'glow', MINT);
    at(cylX(0.066, 0.066, 0.22, 20), 1.32, 'chrome');
    at(cylX(0.092, 0.092, 0.05, 24), 1.39, 'dark');
    at(cylX(0.074, 0.074, 0.14, 20), 1.7, 'chrome');
  }
  // hydraulic struts: sphere collar -> rim rail
  for (const deg of [45, 90, 135, 225, 270, 315]) {
    const m = mat4(0, 0, 0, 0, 0, deg * Math.PI / 180);
    const at = (geo, x, which, col) => W[which].add(geo, mul(m, mat4(x, 0, 0)), null, col);
    at(cylX(0.105, 0.105, 0.16, 24), 1.12, 'chrome');
    at(cylX(0.07, 0.078, 0.28, 20), 1.33, 'dark');
    at(cylX(0.081, 0.081, 0.016, 20), 1.26, 'glow', MINT);
    at(cylX(0.081, 0.081, 0.016, 20), 1.4, 'glow', MINT);
    at(cylX(0.088, 0.088, 0.05, 20), 1.48, 'chrome');
    at(cylX(0.042, 0.042, 0.2, 16), 1.6, 'chrome');
    at(new THREE.BoxGeometry(0.12, 0.16, 0.15), 1.7, 'dark');
    at(cylZ(0.035, 0.19, 12), 1.7, 'chrome');
  }

  // armoured sphere: dark under-shell (faint green through the seams) + thick plates
  const underMesh = new THREE.Mesh(new THREE.SphereGeometry(0.925, 64, 40, 0, TAU, 0.6, Math.PI - 0.6).rotateX(Math.PI / 2), underMat);
  wheel.add(underMesh);
  const gapA = 0.016;
  const bands = [
    {t0: 0.70, t1: 1.05, n: 8, off: Math.PI / 8, q: [1, 0, 1, 3, 1, 0, 1, 3]},
    {t0: 1.09, t1: 1.47, n: 8, off: 0, q: [2, -1, 0, 3, 2, -1, 0, 3]},
    {t0: 1.675, t1: 2.06, n: 8, off: Math.PI / 8, q: [0, 2, 3, 1, 0, 2, 3, 1]},
    {t0: 2.10, t1: 2.52, n: 6, off: 0, q: [3, 0, 2, 0, 3, 1]},
    {t0: 2.56, t1: Math.PI, n: 3, off: 0.4, q: [0, 3, 0]},
  ];
  bands.forEach((band, bi) => {
    for (let k = 0; k < band.n; k++) {
      const p0 = band.off + k * TAU / band.n, p1 = p0 + TAU / band.n, tm = (band.t0 + band.t1) / 2;
      if (band.q[k] < 0) {                  // open bay: radiator fins under a missing plate
        for (let i = 0; i < 6; i++) {
          const ph = p0 + (p1 - p0) * (0.16 + 0.68 * i / 5);
          W.dark.add(new THREE.BoxGeometry(band.t1 - band.t0 - 0.08, 0.012, 0.06), sphereFrame(tm, ph, 0.955));
        }
        W.chrome.add(new THREE.BoxGeometry(0.03, (p1 - p0) * 0.9, 0.03), sphereFrame(tm, (p0 + p1) / 2, 0.99));
        continue;
      }
      const R = 1.0 + ((k + bi) % 2) * 0.016;
      sphereTile(W.shell, R, 0.075, band.t0 + gapA, Math.min(band.t1 - gapA, Math.PI), p0 + gapA, p1 - gapA, band.q[k]);
    }
  });
  // equatorial collar with a glow groove; carries the strut and axle sockets
  sweep(W.dark, ringProfile({ri: 0.95, ro: 1.1, h: 0.085, ch: 0.02, og: {c: 0, w: 0.036, d: 0.02}}), 0, TAU, 96);
  sweep(W.chrome, rect(1.06, 1.105, 0.07, 0.1, 0.008), 0, TAU, 96);
  sweep(W.chrome, rect(1.06, 1.105, -0.1, -0.07, 0.008), 0, TAU, 96);
  sweep(W.strip, rect(1.083, 1.092, -0.013, 0.013), 0, TAU, 96, {uv: th => [th / TAU, 0.5]});

  // opening: lip with glow groove and clamps, tunnel wall, parabolic reflector
  const lip = ringProfile({ri: 0.52, ro: 0.73, h: 0.1, ch: 0.024, fg: {c: 0.63, w: 0.036, d: 0.026}}).map(q => ({...q, z: q.z + 0.745}));
  sweep(W.dark, lip, 0, TAU, 72);
  sweep(W.strip, rect(0.618, 0.642, 0.745 + 0.1 - 0.024, 0.745 + 0.1 - 0.012), 0, TAU, 72, {uv: th => [th / TAU * 2, 0.5]});
  for (let k = 0; k < 8; k++) {
    const a = k * TAU / 8 + Math.PI / 8;
    W.chrome.add(new THREE.BoxGeometry(0.2, 0.06, 0.04), mat4(0.625 * Math.cos(a), 0.625 * Math.sin(a), 0.855, 0, 0, a));
    W.dark.add(cylZ(0.016, 0.02, 6), mat4(0.56 * Math.cos(a + 0.2), 0.56 * Math.sin(a + 0.2), 0.848));
    W.chrome.add(cylZ(0.016, 0.02, 6), mat4(0.70 * Math.cos(a + 0.2), 0.70 * Math.sin(a + 0.2), 0.848));
  }
  sweep(W.dark, rect(0.46, 0.535, 0.47, 0.81, 0.012), 0, TAU, 64);
  const bowl = [];
  for (let i = 0; i <= 10; i++) { const r = 0.5 * (1 - i / 10); bowl.push({r, z: 0.04 + 0.45 * (r / 0.5) ** 2}); }
  for (let i = 10; i >= 0; i--) { const r = 0.5 * (1 - i / 10); bowl.push({r: Math.max(r - 0.004, 0), z: 0.012 + 0.45 * (r / 0.5) ** 2}); }
  sweep(W.chrome, bowl, 0, TAU, 48);

  // counter-rotating iris with teeth
  const IR = new Builder();
  sweep(IR, rect(0.35, 0.47, 0.45, 0.52, 0.01), 0, TAU, 48);
  for (let k = 0; k < 12; k++) {
    const a = k * TAU / 12;
    IR.add(new THREE.BoxGeometry(0.07, 0.034, 0.045), mat4(0.33 * Math.cos(a), 0.33 * Math.sin(a), 0.49, 0, 0, a));
  }
  iris.add(IR.mesh(darkMat));

  // cross spokes + hub, riding a bearing race inside the tunnel
  const SP = {chrome: new Builder(), dark: new Builder(), glow: new Builder()};
  sweep(SP.chrome, rect(0.425, 0.462, 0.64, 0.73, 0.008), 0, TAU, 56);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    SP.dark.add(new THREE.BoxGeometry(0.33, 0.056, 0.07), mat4(0.28 * Math.cos(a), 0.28 * Math.sin(a), 0.685, 0, 0, a));
    SP.chrome.add(new THREE.BoxGeometry(0.29, 0.016, 0.014), mat4(0.29 * Math.cos(a), 0.29 * Math.sin(a), 0.726, 0, 0, a));
  }
  SP.dark.add(new THREE.CylinderGeometry(0.118, 0.128, 0.12, 36).rotateX(Math.PI / 2), mat4(0, 0, 0.7));
  sweep(SP.chrome, rect(0.074, 0.122, 0.752, 0.782, 0.007), 0, TAU, 36);
  sweep(SP.glow, rect(0.05, 0.068, 0.772, 0.784), 0, TAU, 32, {color: MINT});
  SP.glow.add(cylZ(0.036, 0.05, 20), mat4(0, 0, 0.78), null, HOT);
  spokes.add(SP.chrome.mesh(chromeMat), SP.dark.mesh(darkMat), SP.glow.mesh(glowMat));

  // nucleus sitting in the reflector
  const nucleus = new THREE.Mesh(new THREE.SphereGeometry(0.36, 48, 32), nucleusMat);
  nucleus.position.z = 0.2; wheel.add(nucleus);

  wheel.add(W.armor.mesh(armorMat), W.shell.mesh(shellMat), W.steel.mesh(steelMat), W.chrome.mesh(chromeMat),
    W.dark.mesh(darkMat), W.strip.mesh(stripMat), W.glow.mesh(glowMat));
  swing.add(G.armor.mesh(armorMat), G.steel.mesh(steelMat), G.chrome.mesh(chromeMat), G.dark.mesh(darkMat),
    G.strip.mesh(stripMat), G.glow.mesh(glowMat));

  // light from the core: reaches the inner faces of the rings, struts and tunnel (outer faces face away)
  const coreLight = new THREE.PointLight(0x5dffa0, 16, 0, 2); wheel.add(coreLight);
  const mouthLight = new THREE.PointLight(0x7dffbc, 2.2, 1.8, 2); mouthLight.position.z = 0.5; wheel.add(mouthLight);

  // pseudo-bloom: a hot glow behind the spokes (they read as dark silhouettes against it),
  // a soft spill over the lip, and a faint aura behind the whole machine
  const additive = map => new THREE.SpriteMaterial({map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false});
  const mouthMat = additive(glowSprite([[0, 'rgba(200,255,225,0.95)'], [0.3, 'rgba(110,255,175,0.5)'], [0.7, 'rgba(50,220,130,0.12)'], [1, 'rgba(0,0,0,0)']]));
  const mouth = new THREE.Sprite(mouthMat); mouth.position.z = 0.6; mouth.scale.set(1.25, 1.25, 1); wheel.add(mouth);
  const spillMat = additive(glowSprite([[0, 'rgba(120,255,185,0.34)'], [0.35, 'rgba(70,235,150,0.16)'], [1, 'rgba(0,0,0,0)']]));
  const spill = new THREE.Sprite(spillMat); spill.position.z = 1.0; spill.scale.set(2.5, 2.5, 1); wheel.add(spill);
  const auraMat = additive(glowSprite([[0, 'rgba(90,255,160,0.6)'], [0.35, 'rgba(40,200,120,0.2)'], [1, 'rgba(0,0,0,0)']]));
  const aura = new THREE.Sprite(auraMat); aura.scale.set(4.6, 4.6, 1); sway.add(aura);

  const decoScale = {value: 1};
  const decor = buildDecor(scene, {uTime: uniforms.uTime, uBreath: uniforms.uBreath, uScale: decoScale}, camera.position.z);
  decor.group.position.copy(base.position);          // decoration is centred on the wheel

  // ---- motion: heavy, incommensurate periods -----------------------
  const axleWorld = new THREE.Vector3(), toCamera = new THREE.Vector3(), wheelPos = new THREE.Vector3();
  const SPIN0 = 0.9;                // at t=0 the pivot axis lies near the rim's long screen axis
  const breath = t => THREE.MathUtils.clamp(0.5 + 0.32 * Math.sin(TAU * t / 6.4) + 0.18 * Math.sin(TAU * t / 15.1 + 1.1), 0, 1);
  function pose(t) {
    const b = breath(t);
    sway.rotation.set(0.05 * Math.sin(0.083 * t), 0.07 * Math.sin(0.061 * t + 0.8), 0);
    wheel.rotation.z = SPIN0 - 0.07 * t;                                     // ~90 s per turn
    swing.rotation.x = 0.6 + 0.17 * Math.sin(0.16 * t + 0.4) + 0.05 * Math.sin(0.41 * t + 1.3);  // 0.38..0.82 rad, clear of the struts
    spokes.rotation.z = 0.3 * t;
    iris.rotation.z = 0.2 - 0.13 * t;
    uniforms.uTime.value = t; uniforms.uBreath.value = b;
    underMat.emissiveIntensity = 0.25 + 0.3 * b;
    glowMat.color.setScalar(0.82 + 0.3 * b);
    coreLight.intensity = 12 + 8 * b;
    mouthLight.intensity = 1.6 + 1.4 * b;
    scene.updateMatrixWorld();
    axleWorld.set(0, 0, 1).transformDirection(wheel.matrixWorld);
    wheel.getWorldPosition(wheelPos);
    toCamera.subVectors(camera.position, wheelPos).normalize();
    const facing = Math.max(0, axleWorld.dot(toCamera));
    mouthMat.opacity = 0.8 * (0.35 + 0.65 * facing) * (0.75 + 0.35 * b);
    spillMat.opacity = 0.7 * (0.25 + 0.75 * facing) * (0.7 + 0.4 * b);
    auraMat.opacity = 0.2 * (0.75 + 0.4 * b);
    decor.update(t, b);
  }

  // ---- API for the host (live-core.js on the main thread, or core-worker.js) ---------------
  let drawnSize = 0, fitKey = '';
  return {
    draw(t) { pose(t); renderer.render(scene, camera); },
    // size: CSS px of the square canvas (<= 800); u0..u1: horizontal part of it that is on screen.
    // Returns true when something changed and a redraw is due. Assigning the canvas size clears the
    // drawing buffer even when the value is unchanged, so it is only touched on a real change.
    resize(size, u0, u1) {
      let changed = false;
      if (size !== drawnSize) {
        renderer.setSize(size, size, false); drawnSize = size; changed = true;
        decoScale.value = renderer.getPixelRatio() * size / 800;   // point sprites scale with the canvas
      }
      if (u0 != null && u1 != null) {
        const key = u0.toFixed(4) + ',' + u1.toFixed(4);
        if (key !== fitKey) { fitKey = key; decor.fit(u0, u1); changed = true; }
      }
      return changed;
    },
    restore() { buildEnvironment(); },   // after a WebGL context restore (the PMREM target is lost)
  };
}
