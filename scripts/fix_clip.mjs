// 穿模修復 (在 tile_web.py 之後、build_html.py 之前執行): node scripts/fix_clip.mjs
// 直接修改 tiles/d (路段、橋墩、建築) 與 tiles/t (地形)：
//   1. 路口高低差: 同一點上的路段高度不同 -> 一般道路平順拉到同一高度 (差太多視為不同樓層，錯開不相連)
//   2. 地形冒出路面: 每個路面取樣點所在的地形三角形三個頂點壓到路面下 (三角形內插保證不會再冒出來)
//   3. 建築壓到路: 牆角推到路緣外，推不開才移除
//   0. 匝道: 接主線那一段改成貼著主線外側並行 (路緣相接、高度一致)，再慢慢分開；記下匝道資訊給網頁畫槽化線、導桿
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
    ways.push({ key, t, city: false, q, p0: p, n, P, gid: m[0], name: m[2], width: m[6], hw: m[6] / 2, bridge: !!(m[7] & 1), tunnel: !!(m[7] & 2),
      link: !!(m[7] & 4), oneway: !!(m[7] & 8), M: t.emask.subarray(p, p + n) });
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

const ptKey = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
// ---------------------------------------------------------------- 0. 匝道接主線
// OSM 的匝道在交流道是從主線「中心線」岔出去的，所以前一兩百公尺整條疊在主線路面上 (穿模、高高低低)。
// 做法 (保守版，不搬動匝道的平面位置，避免路面扭曲、錯開):
//   - 和主線重疊的那段，匝道高度 = 主線高度 (略低 2 cm，重疊處看到的是主線路面，不會閃)；離開主線後漸漸回到原本的縱斷面
//   - 匝道整條都在主線路面內的那幾段不畫路面 (emask bit2)，也不放護欄
//   - 兩路緣距離小於 GORE_MAX 的範圍兩邊不放護欄；網頁在兩條路真的分開後 (路緣間有空隙) 畫槽化線、導桿、緩衝桶
// 記在 hd.ramp: [匝道 gid, 端點, 在主線哪一側, 主線 gid, 端點在主線上的點]
const GORE_MAX = 9;   // 兩路緣距離小於這個值的範圍是槽化區 (沒有護欄)
const MCELL = 50, MGRID = new Map();
const mck = (x, y) => Math.floor(x / MCELL) * 100003 + Math.floor(y / MCELL);
for (const w of ways) {
  if (w.city || w.link) continue;
  for (let i = 0; i < w.n - 1; i++) {
    const ax = w.P[i * 3], ay = w.P[i * 3 + 1], bx = w.P[i * 3 + 3], by = w.P[i * 3 + 4], r = 30;
    for (let cx = Math.floor((Math.min(ax, bx) - r) / MCELL); cx <= Math.floor((Math.max(ax, bx) + r) / MCELL); cx++)
      for (let cy = Math.floor((Math.min(ay, by) - r) / MCELL); cy <= Math.floor((Math.max(ay, by) + r) / MCELL); cy++) {
        const k = cx * 100003 + cy; let a = MGRID.get(k); if (!a) MGRID.set(k, a = []); a.push(w, i);
      }
  }
}
/** 最近的同向主線: 投影點、左法向、帶正負號的橫向距離 */
function projMain(x, y, z, tx, ty) {
  const a = MGRID.get(mck(x, y)); if (!a) return null;
  let best = null;
  for (let q = 0; q < a.length; q += 2) {
    const w = a[q], i = a[q + 1], P = w.P;
    const ax = P[i * 3], ay = P[i * 3 + 1], bx = P[i * 3 + 3], by = P[i * 3 + 4];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy); if (L < 1e-3) continue;
    const ux = dx / L, uy = dy / L;
    if (ux * tx + uy * ty < 0.7) continue;
    const t = ((x - ax) * ux + (y - ay) * uy) / L;
    if (t < -0.02 || t > 1.02) continue;
    const tc = Math.min(1, Math.max(0, t));
    const pz = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * tc;
    if (Math.abs(pz - z) > 3) continue;
    const px = ax + dx * tc, py = ay + dy * tc, lat = (x - px) * -uy + (y - py) * ux;
    if (!best || Math.abs(lat) < Math.abs(best.lat)) best = { w, i, t: tc, px, py, pz, nx: -uy, ny: ux, lat };
  }
  return best;
}
const tanAt = (w, k, dir) => {   // 沿行車方向 (路線點序) 的切線
  const a = Math.max(0, Math.min(w.n - 2, k - (dir > 0 ? 0 : 1)));
  const dx = w.P[a * 3 + 3] - w.P[a * 3], dy = w.P[a * 3 + 4] - w.P[a * 3 + 1], L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
};
const ORIG = new Map();   // 原始端點座標 -> [[way, idx]] (移動匝道的點時，接在同一點的其他路段端點一起移)
for (const w of ways) for (const i of [0, w.n - 1]) { const k = ptKey(w.P[i * 3], w.P[i * 3 + 1]); let a = ORIG.get(k); if (!a) ORIG.set(k, a = []); a.push([w, i]); }
const smooth = (u) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
let rampEnds = 0, rampMoved = 0, rampAlias = 0, followMoved = 0;
const moved = new Set();
for (const w of ways) {
  if (!w.link || w.city || w.tunnel) continue;
  for (const e of [0, w.n - 1]) {
    const dir = e === 0 ? 1 : -1;   // 從端點往路段內走的方向
    const x0 = w.P[e * 3], y0 = w.P[e * 3 + 1], z0 = w.P[e * 3 + 2];
    const [tx0, ty0] = tanAt(w, e, 1);
    const m0 = projMain(x0, y0, z0, tx0, ty0);
    if (!m0 || Math.abs(m0.lat) > 1.2) continue;
    // 端點附近要和主線差不多平行才算 (環道、垂直接上的不處理)
    let k20 = e, a20 = 0;
    while (a20 < 20 && k20 + dir >= 0 && k20 + dir < w.n) { a20 += Math.hypot(w.P[(k20 + dir) * 3] - w.P[k20 * 3], w.P[(k20 + dir) * 3 + 1] - w.P[k20 * 3 + 1]); k20 += dir; }
    const ddx = (w.P[k20 * 3] - x0) * dir, ddy = (w.P[k20 * 3 + 1] - y0) * dir, dl = Math.hypot(ddx, ddy) || 1;
    if ((ddx * m0.ny - ddy * m0.nx) / dl < 0.85) continue;   // 主線切線 = (ny, -nx)
    rampEnds++;
    // 沿匝道記錄每一點相對主線的位置
    const rec = [];
    let along = 0;
    for (let k = e; k >= 0 && k < w.n && along < 450; k += dir) {
      if (k !== e) along += Math.hypot(w.P[k * 3] - w.P[(k - dir) * 3], w.P[k * 3 + 1] - w.P[(k - dir) * 3 + 1]);
      const [tx, ty] = tanAt(w, k, 1);
      const m = projMain(w.P[k * 3], w.P[k * 3 + 1], w.P[k * 3 + 2], tx, ty);
      if (!m) break;
      rec.push({ k, along, m });
    }
    if (rec.length < 3) continue;
    let side = 0;
    for (const r of rec) if (Math.abs(r.m.lat) > r.m.w.hw + w.hw + 3) { side = Math.sign(r.m.lat); break; }
    if (!side) { for (let j = rec.length - 1; j >= 0; j--) if (Math.abs(rec[j].m.lat) > 1) { side = Math.sign(rec[j].m.lat); break; } }
    if (!side) continue;
    // 高度: 重疊處跟主線一樣，分開後漸漸回到原本的縱斷面 (平面位置不動)
    const B = 8;
    let free = 0, prevM = null;
    const tipOld = [x0, y0];
    for (const r of rec) {
      const { k, m } = r;
      const R = m.w.hw + w.hw - 0.05, x = side * m.lat - R;
      if (x >= B) { if (++free >= 3) break; r.gap = x; continue; }
      if (free > 0) break;   // 已經分開又「貼回」= 找到別條主線，不處理
      if (prevM && m.w !== prevM.w && Math.abs(m.lat - prevM.lat) > 4) break;   // 主線突然換一條、位置跳很多
      prevM = m;
      const out = Math.max(0, x);   // 兩路緣之間的空隙 (重疊時 0)
      const oz = w.P[k * 3 + 2];
      const wz = 1 - smooth((out - 1) / 13);
      const nz = (m.pz - 0.02) * wz + oz * (1 - wz);
      w.P[k * 3 + 2] = nz;
      r.gap = out;
      rampMoved++;
      // 匝道整條在主線路面內: 不畫路面、兩邊都不放護欄
      if (side * m.lat + w.hw <= m.w.hw + 0.2) w.M[k] |= 1 | 2 | 4;
      // 槽化區兩邊不放護欄 / 側牆: 主線靠匝道那一側、匝道靠主線那一側
      if (out < GORE_MAX) {
        const mb = side > 0 ? 1 : 2;
        m.w.M[m.i] |= mb; m.w.M[m.i + 1] |= mb;
        const [ltx, lty] = tanAt(w, k, 1);
        const lb = (-lty * -side * m.nx + ltx * -side * m.ny) > 0 ? 1 : 2;   // 匝道左法向 (-ty, tx) 跟「朝主線」同向 = 左側
        w.M[k] |= lb;
      }
    }
    // 高度沿線再順一次 (端點固定)，避免縱斷面出現小台階
    const last = rec.findIndex((r) => r.gap != null && r.gap >= B);
    const upto = Math.min(rec.length, (last < 0 ? rec.length : last) + 6);
    for (let pass = 0; pass < 3; pass++) {
      const zs = rec.slice(0, upto).map((r) => w.P[r.k * 3 + 2]);
      for (let j = 1; j < upto - 1; j++) w.P[rec[j].k * 3 + 2] = 0.25 * zs[j - 1] + 0.5 * zs[j] + 0.25 * zs[j + 1];
    }
    // 端點原本和主線的某個點重合 -> 記下來給網頁接路網
    let mi = -1;
    for (let i = 0; i < m0.w.n; i++) if (Math.hypot(m0.w.P[i * 3] - tipOld[0], m0.w.P[i * 3 + 1] - tipOld[1]) < 0.6) { mi = i; break; }
    if (mi >= 0) rampAlias++;
    (w.t.hd.ramp ||= []).push([w.gid, e, side, m0.w.gid, mi]);
  }
}
console.log('ramp ends aligned', rampEnds, 'points moved', rampMoved, 'joined ends followed', followMoved, 'network aliases', rampAlias);

// ---------------------------------------------------------------- 1. 路口高低差
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
