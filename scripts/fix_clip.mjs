// 穿模修復 (在 tile_web.py 之後、build_html.py 之前執行): node scripts/fix_clip.mjs
// 直接修改 tiles/d (路段、橋墩、建築) 與 tiles/t (地形)：
//   1. 路口高低差: 同一點上的路段高度不同 -> 一般道路平順拉到同一高度 (差太多視為不同樓層，錯開不相連)
//   2. 地形冒出路面: 每個路面取樣點所在的地形三角形三個頂點壓到路面下 (三角形內插保證不會再冒出來)
//   3. 建築壓到路: 牆角推到路緣外，推不開才移除
//   4. 橋墩插在別條路上: 沿帽梁左右找空位，找不到才移除
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TD = path.join(ROOT, 'tiles');
const Z16 = (v) => (v < -5000 ? v + 65536 : v) * 0.1;   // 高度 Int16 解碼 (3276.8 m 以上繞回負數)
const INDEX = JSON.parse(fs.readFileSync(path.join(TD, 'index.json'), 'utf8'));
const TC = INDEX.tc, STEP = INDEX.step, TN = TC + 3, TG = INDEX.terrain;

// ---------------------------------------------------------------- 讀分區
function parse(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const jl = new DataView(ab).getUint32(0, true);
  const hd = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, jl)));
  let o = 4 + jl;
  const take = (C, n) => { const a = new C(ab.slice(o, o + n * C.BYTES_PER_ELEMENT)); o += n * C.BYTES_PER_ELEMENT; return a; };
  const ncw = hd.cw.length;
  const t = { hd };
  t.fP = take(Float32Array, hd.np * 3); t.fU = take(Float32Array, hd.np); t.piers = take(Float32Array, hd.npier * 9);
  t.rxy0 = take(Float32Array, ncw * 2); t.bxy0 = take(Float32Array, hd.nb * 2); t.bbase = take(Float32Array, hd.nb); t.bh = take(Float32Array, hd.nb);
  t.roff = take(Int16Array, hd.cnp * 2); t.rz = take(Int16Array, hd.cnp); t.boff = take(Int16Array, hd.nbv * 2);
  t.bcnt = take(Uint16Array, hd.nb); t.emask = take(Uint8Array, hd.np); t.bcol = take(Uint8Array, hd.nb);
  return t;
}
function pack(t) {
  const hd = t.hd;
  let js = Buffer.from(JSON.stringify(hd), 'utf8');
  const pad = (4 - js.length % 4) % 4; if (pad) js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
  const len = Buffer.alloc(4); len.writeUInt32LE(js.length, 0);
  const b = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  return Buffer.concat([len, js, b(t.fP), b(t.fU), b(t.piers), b(t.rxy0), b(t.bxy0), b(t.bbase), b(t.bh), b(t.roff), b(t.rz), b(t.boff), b(t.bcnt), b(t.emask), b(t.bcol)]);
}

const tiles = new Map();
for (const key of Object.keys(INDEX.detail)) tiles.set(key, parse(fs.readFileSync(path.join(TD, 'd', key + '.bin'))));

// 路段清單 (P 是可寫入的 xyz Float64 複本，最後寫回)
const ways = [];
for (const [key, t] of tiles) {
  let p = 0;
  t.hd.fw.forEach((m, q) => {
    const n = t.hd.fc[q], P = new Float64Array(n * 3);
    for (let i = 0; i < n * 3; i++) P[i] = t.fP[(p * 3) + i];
    ways.push({ key, t, city: false, q, p0: p, n, P, gid: m[0], name: m[2], width: m[6], hw: m[6] / 2, bridge: !!(m[7] & 1), tunnel: !!(m[7] & 2) });
    p += n;
  });
  p = 0;
  t.hd.cw.forEach((m, q) => {
    const n = t.hd.cc[q], P = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      P[i * 3] = t.rxy0[q * 2] + t.roff[(p + i) * 2] * 0.1; P[i * 3 + 1] = t.rxy0[q * 2 + 1] + t.roff[(p + i) * 2 + 1] * 0.1; P[i * 3 + 2] = Z16(t.rz[p + i]);
    }
    ways.push({ key, t, city: true, q, p0: p, n, P, gid: m[0], name: m[6], width: m[4], hw: m[4] / 2, bridge: !!m[5], tunnel: false });
    p += n;
  });
}
const cum = (P, n) => { const s = new Float64Array(n); for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2]); return s; };
for (const w of ways) w.s = cum(w.P, w.n);
console.log('ways', ways.length, 'tiles', tiles.size);

// ---------------------------------------------------------------- 1. 路口高低差
const ptKey = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
const PT = new Map();
for (const w of ways) for (let i = 0; i < w.n; i++) { const k = ptKey(w.P[i * 3], w.P[i * 3 + 1]); let a = PT.get(k); if (!a) PT.set(k, a = []); a.push([w, i]); }
let jFixed = 0, jSplit = 0;
const pulls = new Map();   // way -> [[i, dz]]
for (const arr of PT.values()) {
  if (arr.length < 2) continue;
  let lo = 1e9, hi = -1e9;
  for (const [w, i] of arr) { const z = w.P[i * 3 + 2]; lo = Math.min(lo, z); hi = Math.max(hi, z); }
  if (hi - lo <= 0.15) continue;
  if (hi - lo > 3) {
    // 不同樓層剛好重疊: 一般道路端點錯開 0.3 m，路網就不會相連
    for (const [w, i] of arr) if (w.city && (i === 0 || i === w.n - 1)) {
      const j = i === 0 ? 1 : w.n - 2, dx = w.P[j * 3] - w.P[i * 3], dy = w.P[j * 3 + 1] - w.P[i * 3 + 1], L = Math.hypot(dx, dy) || 1;
      const zs = arr.filter(([o]) => o !== w).map(([o, k]) => o.P[k * 3 + 2]);
      if (zs.some((z) => Math.abs(z - w.P[i * 3 + 2]) > 3)) { w.P[i * 3] += dx / L * 0.3; w.P[i * 3 + 1] += dy / L * 0.3; jSplit++; }
    }
    continue;
  }
  const fz = arr.filter(([w]) => !w.city).map(([w, i]) => w.P[i * 3 + 2]);
  const target = fz.length ? fz.reduce((a, b) => a + b, 0) / fz.length : arr.reduce((a, [w, i]) => a + w.P[i * 3 + 2], 0) / arr.length;
  for (const [w, i] of arr) {
    if (!w.city) continue;
    const dz = target - w.P[i * 3 + 2];
    if (Math.abs(dz) < 0.05) continue;
    let a = pulls.get(w); if (!a) pulls.set(w, a = []); a.push([i, dz]);
  }
  jFixed++;
}
for (const [w, list] of pulls) {
  const R = 30, base = w.P.slice();
  const add = new Float64Array(w.n), wt = new Float64Array(w.n);
  for (const [i, dz] of list) for (let k = 0; k < w.n; k++) {
    const d = Math.abs(w.s[k] - w.s[i]); if (d >= R) continue;
    const u = 1 - d / R, f = u * u * (3 - 2 * u);
    add[k] += dz * f; wt[k] += f;
  }
  for (let k = 0; k < w.n; k++) if (wt[k] > 0) w.P[k * 3 + 2] = base[k * 3 + 2] + add[k] / Math.max(1, wt[k]);
}
console.log('junction groups fixed', jFixed, 'split (different levels)', jSplit);

// ---------------------------------------------------------------- 地形 (全域格點)
const G = new Float64Array(TG.w * TG.h);
const LC_TAIL = new Map();
for (const key of Object.keys(INDEX.tiles_t)) {
  const [tx, ty] = key.split('_').map(Number);
  const b = fs.readFileSync(path.join(TD, 't', key + '.bin'));
  const a = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + TN * TN * 2));
  if (b.byteLength > TN * TN * 2) LC_TAIL.set(key, b.subarray(TN * TN * 2));   // 地表分類 (寫回時原樣接上)
  for (let li = 1; li <= TC + 1; li++) for (let lj = 1; lj <= TC + 1; lj++) {
    const I = ty * TC + li - 1 - TG.I0, J = tx * TC + lj - 1 - TG.J0;
    if (I >= 0 && I < TG.h && J >= 0 && J < TG.w) G[I * TG.w + J] = Z16(a[li * TN + lj]);
  }
}
const G0 = G.slice();
/** 點 (x,y) 所在三角形的三個頂點索引與權重 (與 buildTerrainMesh 相同切法)；網格外回傳 null */
function tri(x, y) {
  const J = x / STEP - TG.J0, I = y / STEP - TG.I0, j = Math.floor(J), i = Math.floor(I), u = J - j, v = I - i;
  if (j < 0 || i < 0 || j >= TG.w - 1 || i >= TG.h - 1) return null;
  const q00 = i * TG.w + j, q10 = q00 + 1, q11 = q00 + TG.w + 1, q01 = q00 + TG.w;
  return u >= v ? [q00, q10, q11, 1 - u, u - v, v] : [q00, q11, q01, 1 - v, u, v - u];
}
const meshZ = (x, y) => { const t = tri(x, y); return t ? G[t[0]] * t[3] + G[t[1]] * t[4] + G[t[2]] * t[5] : -1e9; };

// ---------------------------------------------------------------- 2. 地形冒出路面
// x, y, 目標高度 (地圖大了取樣點會超過一般陣列上限，用可擴充的 Float32Array)
let samples = new Float32Array(1 << 22), sn = 0;
let sWay = new Int32Array(1 << 20), curWay = 0;
const addSample = (x, y, z) => { if (sn + 3 > samples.length) { const b = new Float32Array(samples.length * 2); b.set(samples); samples = b; } if (sn / 3 >= sWay.length) { const b = new Int32Array(sWay.length * 2); b.set(sWay); sWay = b; } sWay[sn / 3] = curWay; samples[sn++] = x; samples[sn++] = y; samples[sn++] = z; };
for (const [wi, w] of ways.entries()) {
  if (w.tunnel) continue;
  curWay = wi;
  const P = w.P, br = w.bridge;
  const offs = br ? [-(w.hw + 0.5), -w.hw * 0.5, 0, w.hw * 0.5, w.hw + 0.5] : [-(w.hw + 1.2), -w.hw * 0.5, 0, w.hw * 0.5, w.hw + 1.2];
  const drop = br ? 2.0 : (w.city ? 0.32 : 0.4);
  for (let i = 0; i < w.n - 1; i++) {
    const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2], bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
    const L = Math.hypot(bx - ax, by - ay); if (L < 0.01) continue;
    const nx = -(by - ay) / L, ny = (bx - ax) / L, steps = Math.max(1, Math.ceil(L / 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      for (const o of offs) addSample(x + nx * o, y + ny * o, z - drop);
    }
  }
}
let carvedMax = 0;
for (let pass = 0; pass < 6; pass++) {
  const req = new Float64Array(G.length);
  let bad = 0;
  for (let k = 0; k < sn; k += 3) {
    const t = tri(samples[k], samples[k + 1]); if (!t) continue;
    const d = G[t[0]] * t[3] + G[t[1]] * t[4] + G[t[2]] * t[5] - samples[k + 2];
    if (d <= 0.02) continue;
    if (pass === 0 && d > 40 && process.env.CLIPDBG) { const w = ways[sWay[k / 3]]; (globalThis.DBG ||= new Map()).set(w, Math.max(d, globalThis.DBG.get(w) || 0)); }
    bad++;
    for (let m = 0; m < 3; m++) if (d + 0.02 > req[t[m]]) req[t[m]] = d + 0.02;
  }
  for (let q = 0; q < G.length; q++) if (req[q] > 0) G[q] -= req[q];
  console.log('terrain pass', pass, 'samples above road', bad);
  if (pass === 0 && globalThis.DBG) { const a = [...globalThis.DBG].sort((p, q) => q[1] - p[1]); console.log('deep carve ways', a.length); for (const [w, d] of a.slice(0, 25)) { const zs = []; for (let i = 0; i < w.n; i++) zs.push(w.P[i*3].toFixed(0)+','+w.P[i*3+1].toFixed(0)+','+w.P[i*3+2].toFixed(0)); let mi=0,ma=0; for (let i=0;i<w.n;i++){ if(w.P[i*3+2]<w.P[mi*3+2])mi=i; if(w.P[i*3+2]>w.P[ma*3+2])ma=i;} console.log('n',w.n,'min',zs[mi],'@',mi,'max',zs[ma],'@',ma, 'meshZ at min', meshZ(w.P[mi*3],w.P[mi*3+1]).toFixed(0), 'meshZ at max', meshZ(w.P[ma*3],w.P[ma*3+1]).toFixed(0)); console.log(zs.slice(Math.max(0,ma-5),ma+5).join(' ')); } for (const [w, d] of a.slice(0, 25)) console.log(' ', w.city ? 'city' : 'fwy', w.gid, w.name, 'br', w.bridge, 'd', d.toFixed(1), 'xy', w.P[0].toFixed(0), w.P[1].toFixed(0), 'z', w.P[2].toFixed(1)); process.exit(0); }
  if (!bad) break;
}
let nLow = 0; for (let q = 0; q < G.length; q++) { const d = G0[q] - G[q]; if (d > 0.01) nLow++; carvedMax = Math.max(carvedMax, d); }
console.log('terrain vertices lowered', nLow, 'max', carvedMax.toFixed(1), 'm');

// ---------------------------------------------------------------- 路段空間索引 (給 3、4)
const CELL = 25, SEG = new Map();
const ck = (cx, cy) => cx * 100003 + cy;
for (const w of ways) for (let i = 0; i < w.n - 1; i++) {
  const ax = w.P[i * 3], ay = w.P[i * 3 + 1], bx = w.P[i * 3 + 3], by = w.P[i * 3 + 4], r = w.hw + 1;
  for (let cx = Math.floor((Math.min(ax, bx) - r) / CELL); cx <= Math.floor((Math.max(ax, bx) + r) / CELL); cx++)
    for (let cy = Math.floor((Math.min(ay, by) - r) / CELL); cy <= Math.floor((Math.max(ay, by) + r) / CELL); cy++) {
      const k = ck(cx, cy); let a = SEG.get(k); if (!a) SEG.set(k, a = []); a.push(w, i);
    }
}
/** (x,y) 落在哪些路面上: 回傳 [{w, z, lat, nx, ny}] */
function roadsAt(x, y, extra = 0) {
  const a = SEG.get(ck(Math.floor(x / CELL), Math.floor(y / CELL))); if (!a) return [];
  const out = [];
  for (let q = 0; q < a.length; q += 2) {
    const w = a[q], i = a[q + 1], P = w.P;
    const ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L2 = dx * dx + dy * dy; if (L2 < 1e-4) continue;
    const t = ((x - ax) * dx + (y - ay) * dy) / L2; if (t < 0 || t > 1) continue;
    const L = Math.sqrt(L2), lat = ((x - ax) * -dy + (y - ay) * dx) / L;
    if (Math.abs(lat) > w.hw + extra) continue;
    out.push({ w, z: P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t, lat, nx: -dy / L, ny: dx / L });
  }
  return out;
}

// ---------------------------------------------------------------- 3. 建築壓到路
let bMoved = 0, bRemoved = 0;
const inPoly = (X, Y, x, y) => { let c = false; for (let i = 0, j = X.length - 1; i < X.length; j = i++) if ((Y[i] > y) !== (Y[j] > y) && x < (X[j] - X[i]) * (y - Y[i]) / (Y[j] - Y[i]) + X[i]) c = !c; return c; };
for (const t of tiles.values()) {
  const hd = t.hd, keep = new Uint8Array(hd.nb).fill(1);
  const vstart = new Int32Array(hd.nb + 1);
  for (let b = 0; b < hd.nb; b++) vstart[b + 1] = vstart[b] + t.bcnt[b];
  for (let b = 0; b < hd.nb; b++) {
    const n = t.bcnt[b], X = new Float64Array(n), Y = new Float64Array(n), base = t.bbase[b], top = base + t.bh[b];
    for (let k = 0; k < n; k++) { X[k] = t.bxy0[b * 2] + t.boff[(vstart[b] + k) * 2] * 0.1; Y[k] = t.bxy0[b * 2 + 1] + t.boff[(vstart[b] + k) * 2 + 1] * 0.1; }
    const hitRoad = (r) => !r.w.tunnel && r.z > base - 1.0 && r.z < top - 0.5;
    // 牆角在路面內 -> 推到路緣外 0.15 m
    let moved = false;
    for (let k = 0; k < n; k++) for (let it = 0; it < 3; it++) {
      const rs = roadsAt(X[k], Y[k], -0.2).filter(hitRoad); if (!rs.length) break;
      const r = rs[0], sgn = r.lat >= 0 ? 1 : -1, push = sgn * (r.w.hw + 0.15) - r.lat;
      X[k] += r.nx * push; Y[k] += r.ny * push; moved = true;
    }
    // 檢查: 路中心線或路面還穿過建築 -> 移除
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let k = 0; k < n; k++) { x0 = Math.min(x0, X[k]); x1 = Math.max(x1, X[k]); y0 = Math.min(y0, Y[k]); y1 = Math.max(y1, Y[k]); }
    let bad = false;
    for (let x = x0 + 0.5; x < x1 && !bad; x += 1.5) for (let y = y0 + 0.5; y < y1 && !bad; y += 1.5) {
      if (!inPoly(X, Y, x, y)) continue;
      if (roadsAt(x, y, -0.6).some(hitRoad)) bad = true;
    }
    if (bad) { keep[b] = 0; bRemoved++; continue; }
    if (moved) {
      bMoved++;
      for (let k = 0; k < n; k++) { t.boff[(vstart[b] + k) * 2] = Math.round((X[k] - t.bxy0[b * 2]) * 10); t.boff[(vstart[b] + k) * 2 + 1] = Math.round((Y[k] - t.bxy0[b * 2 + 1]) * 10); }
    }
  }
  if (keep.some((v) => !v)) {
    const nb = keep.reduce((a, v) => a + v, 0), nbv = Array.from(t.bcnt).reduce((a, c, b) => a + (keep[b] ? c : 0), 0);
    const bxy0 = new Float32Array(nb * 2), bbase = new Float32Array(nb), bh = new Float32Array(nb), boff = new Int16Array(nbv * 2), bcnt = new Uint16Array(nb), bcol = new Uint8Array(nb);
    let q = 0, v = 0;
    for (let b = 0; b < hd.nb; b++) {
      if (!keep[b]) continue;
      bxy0[q * 2] = t.bxy0[b * 2]; bxy0[q * 2 + 1] = t.bxy0[b * 2 + 1]; bbase[q] = t.bbase[b]; bh[q] = t.bh[b]; bcnt[q] = t.bcnt[b]; bcol[q] = t.bcol[b];
      boff.set(t.boff.subarray(vstart[b] * 2, vstart[b + 1] * 2), v * 2); v += t.bcnt[b]; q++;
    }
    Object.assign(t, { bxy0, bbase, bh, boff, bcnt, bcol }); hd.nb = nb; hd.nbv = nbv;
  }
}
console.log('buildings pushed off road', bMoved, 'removed', bRemoved);

// ---------------------------------------------------------------- 4. 橋墩插在別條路上
let pMoved = 0, pRemoved = 0;
for (const t of tiles.values()) {
  const out = [];
  for (let k = 0; k < t.piers.length / 9; k++) {
    const p = Array.from(t.piers.subarray(k * 9, k * 9 + 9));
    const [x, y, tx, ty, off, zg, top, capL, capR] = p;
    const free = (o) => {
      const px = x - ty * o, py = y + tx * o;
      for (const dx of [-0.6, 0, 0.6]) for (const dy of [-0.6, 0, 0.6])
        if (roadsAt(px + dx, py + dy, 0.4).some((r) => r.z > zg + 0.3 && r.z < top - 1.6)) return false;
      return true;
    };
    if (free(off)) { out.push(...p); continue; }
    let best = null;
    for (let d = 0.5; d <= 12 && best == null; d += 0.5) for (const o of [off - d, off + d]) if (best == null && o > capL - 3 && o < capR + 3 && free(o)) best = o;
    if (best == null) { pRemoved++; continue; }
    p[4] = best; p[7] = Math.min(capL, best - 1.0); p[8] = Math.max(capR, best + 1.0);
    out.push(...p); pMoved++;
  }
  t.piers = new Float32Array(out); t.hd.npier = out.length / 9;
}
console.log('piers moved', pMoved, 'removed', pRemoved);

// ---------------------------------------------------------------- 寫回
for (const w of ways) {
  const t = w.t;
  if (w.city) {
    for (let i = 0; i < w.n; i++) {
      t.roff[(w.p0 + i) * 2] = Math.round((w.P[i * 3] - t.rxy0[w.q * 2]) * 10);
      t.roff[(w.p0 + i) * 2 + 1] = Math.round((w.P[i * 3 + 1] - t.rxy0[w.q * 2 + 1]) * 10);
      t.rz[w.p0 + i] = Math.round(w.P[i * 3 + 2] * 10);
    }
  } else for (let i = 0; i < w.n * 3; i++) t.fP[w.p0 * 3 + i] = w.P[i];
}
for (const [key, t] of tiles) { const b = pack(t); fs.writeFileSync(path.join(TD, 'd', key + '.bin'), b); INDEX.detail[key] = b.length; }
for (const key of Object.keys(INDEX.tiles_t)) {
  const [tx, ty] = key.split('_').map(Number);
  const a = new Int16Array(TN * TN);
  for (let li = 0; li < TN; li++) for (let lj = 0; lj < TN; lj++) {
    const I = Math.min(Math.max(ty * TC + li - 1 - TG.I0, 0), TG.h - 1), J = Math.min(Math.max(tx * TC + lj - 1 - TG.J0, 0), TG.w - 1);
    a[li * TN + lj] = Math.round(G[I * TG.w + J] * 10);
  }
  const tail = LC_TAIL.get(key);
  const out = tail ? Buffer.concat([Buffer.from(a.buffer), tail]) : Buffer.from(a.buffer);
  fs.writeFileSync(path.join(TD, 't', key + '.bin'), out);
  INDEX.tiles_t[key] = out.length;
}
fs.writeFileSync(path.join(TD, 'index.json'), JSON.stringify(INDEX));
console.log('done');
