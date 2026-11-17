// 導航路網 -> tiles/n/nav.bin
//
// 遊戲的路網是分區載入的 (只有附近的路段)，導航要能規劃到幾十公里外，所以這裡把「全部分區」的路段讀進來，
// 只留下規劃路線需要的東西: 每條路段的長度、速限、端點座標，以及每個路口 (路段端點) 可以接上哪些路段。
// 接續規則與遊戲的 nextOptions 完全相同: 走到路段 w 的端點時，可以接上「有一點剛好在同一位置、高度差 2.5 m 以內」的路段 o，
// 從那一點順著 o 的方向 (雙向一般道路兩個方向都行) 繼續走；fix_clip.mjs 移開的匝道端點用分區裡的 ramp 別名接回主線。
//
// 也產生目的地清單 (地名、交流道、傳送地點)，給導航搜尋與任務用。
//
// nav.bin 格式: uint32 JSON 長度 + JSON (補齊 4 bytes) + 資料區
//   (存在 tiles/n/nav.bin，遊戲用 tileBuf("n", "nav") 讀；台灣.html 內嵌)
//   JSON: { nw, nn, ne, dest: [[名稱, 種類, gid, 點, x, y], ...] }
//   資料區 (gid = 陣列索引):
//     wXY  i16[nw*4]   起點 x,y、終點 x,y (5 m 為單位)
//     wNode u32[nw*2]  起點、終點所在的路口編號
//     nOff u32[nn+1]   路口 -> 接續清單起訖 (CSR)
//     eWay u32[ne]     接續的路段 gid；最高位元 = 反向行駛
//     wLen u16[nw]     路段長度 (m)
//     eS   u16[ne]     接上的那一點離路段起點多遠 (m)
//     eI   u16[ne]     接上的那一點的索引
//     wFlag u8[nw]     bit0 一般道路 bit1 雙向 bit2 匝道 bit3 快速道路 bit4 隧道
//     wSpd u8[nw]      速限 km/h
//     wCls u8[nw]      一般道路等級 (國道 0)
//     wHd  i8[nw*2]    在起點 (反向行駛時抵達的方向)、終點 (順向抵達的方向) 的行進方位，256 等分
//     eHd  i8[ne]      接上之後的行進方位
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TILES = path.join(ROOT, 'tiles');
const DATA = path.join(ROOT, 'data');
const idx = JSON.parse(fs.readFileSync(path.join(TILES, 'index.json'), 'utf8'));
const NW = idx.nways;
const Z16 = (v) => (v < -5000 ? v + 65536 : v) * 0.1;

// ---------------------------------------------------------------- 讀所有細節分區 (格式見 tile_web.py pack_detail)
const W = new Array(NW).fill(null);
const ramps = [];
for (const f of fs.readdirSync(path.join(TILES, 'd'))) {
  if (!f.endsWith('.bin')) continue;
  const b = fs.readFileSync(path.join(TILES, 'd', f));
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const jl = new DataView(buf).getUint32(0, true);
  const hd = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
  let o = 4 + jl;
  const f32 = (n) => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const i16 = (n) => { const a = new Int16Array(buf, o, n); o += n * 2; return a; };
  const ncw = hd.cw.length;
  const fP = f32(hd.np * 3); f32(hd.np); f32(hd.npier * 9); const rxy0 = f32(ncw * 2);
  f32(hd.nb * 2); f32(hd.nb); f32(hd.nb);
  const roff = i16(hd.cnp * 2), rz = i16(hd.cnp);
  let p = 0;
  for (let q = 0; q < hd.fw.length; q++) {
    const m = hd.fw[q], n = hd.fc[q];
    const fl = m[7];
    W[m[0]] = { gid: m[0], ref: m[1], name: m[2], city: false, two: false, link: !!(fl & 4), trunk: !!m[9], tunnel: !!(fl & 2),
      maxspeed: m[8], cls: 0, P: Float64Array.from(fP.subarray(p * 3, (p + n) * 3)) };
    p += n;
  }
  p = 0;
  for (let q = 0; q < ncw; q++) {
    const m = hd.cw[q], n = hd.cc[q];
    const P = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      P[i * 3] = rxy0[q * 2] + roff[(p + i) * 2] * 0.1; P[i * 3 + 1] = rxy0[q * 2 + 1] + roff[(p + i) * 2 + 1] * 0.1; P[i * 3 + 2] = Z16(rz[p + i]);
    }
    W[m[0]] = { gid: m[0], ref: '', name: m[6], city: true, two: !m[3], link: m[1] === 6, trunk: false, tunnel: false, maxspeed: 0, cls: m[1], P };
    p += n;
  }
  if (hd.ramp) ramps.push(...hd.ramp);
}
const missing = W.filter((w) => !w).length;
for (const w of W) if (w) {
  const n = w.n = w.P.length / 3;
  w.s = new Float64Array(n);
  for (let i = 1; i < n; i++) w.s[i] = w.s[i - 1] + Math.hypot(w.P[i * 3] - w.P[i * 3 - 3], w.P[i * 3 + 1] - w.P[i * 3 - 2], w.P[i * 3 + 2] - w.P[i * 3 - 1]);
}
console.log('ways', NW, 'missing', missing, 'ramp aliases', ramps.length);

// ---------------------------------------------------------------- 路口
const ptKey = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
const endKeys = new Set();
for (const w of W) if (w) { endKeys.add(ptKey(w.P[0], w.P[1])); endKeys.add(ptKey(w.P[(w.n - 1) * 3], w.P[(w.n - 1) * 3 + 1])); }
const at = new Map();   // key -> [[gid, i, z], ...]
const addAt = (key, g, i, z) => { let a = at.get(key); if (!a) at.set(key, a = []); if (!a.some((e) => e[0] === g && e[1] === i)) a.push([g, i, z]); };
for (const w of W) if (w) for (let i = 0; i < w.n; i++) { const k = ptKey(w.P[i * 3], w.P[i * 3 + 1]); if (endKeys.has(k)) addAt(k, w.gid, i, w.P[i * 3 + 2]); }
// 一般道路的點是「各路段自己的起點 + 0.1 m 整數位移」存的，同一個路口在不同路段上差幾公分、四捨五入常落到隔壁格子 (遊戲的 nodeLinks 同樣處理):
// 端點的隔壁 8 格裡、20 公分內的點也算同一個路口 (兩邊至少一條是一般道路才需要；國道之間的點本來就完全一致)
{
  const cityEnd = new Map();   // key -> [[x, y, 一般道路?]] (路段端點)
  for (const w of W) if (w) for (const e of [0, w.n - 1]) {
    const k = ptKey(w.P[e * 3], w.P[e * 3 + 1]); let a = cityEnd.get(k); if (!a) cityEnd.set(k, a = []); a.push([w.P[e * 3], w.P[e * 3 + 1], w.city]);
  }
  let snapped = 0;
  for (const w of W) if (w) for (let i = 0; i < w.n; i++) {
    const x = w.P[i * 3], y = w.P[i * 3 + 1], gx = Math.round(x * 10), gy = Math.round(y * 10);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      if (!ox && !oy) continue;
      const k = (gx + ox) + ',' + (gy + oy), a = cityEnd.get(k);
      if (a && a.some(([ex, ey, ec]) => (ec || w.city) && Math.hypot(ex - x, ey - y) < 0.2)) { const n0 = (at.get(k) || []).length; addAt(k, w.gid, i, w.P[i * 3 + 2]); if ((at.get(k) || []).length > n0) snapped++; }
    }
  }
  console.log('snap links', snapped);
}
for (const [g, e, , mg, mi] of ramps) {
  const w = W[g], m = W[mg];
  if (!w || !m || mi < 0 || mi >= m.n) continue;
  addAt(ptKey(w.P[e * 3], w.P[e * 3 + 1]), mg, mi, w.P[e * 3 + 2]);
  addAt(ptKey(m.P[mi * 3], m.P[mi * 3 + 1]), g, e, m.P[mi * 3 + 2]);
}
// 同一位置不同樓層 (高架與平面剛好重疊) 分成不同路口: 依高度排序，差 2.5 m 以上另開一個
const nodes = [];        // [[gid, i], ...]
const nodeOf = new Map(); // gid*65536 + i -> 路口編號 (只記端點)
for (const list of at.values()) {
  list.sort((a, b) => a[2] - b[2]);
  let cur = null, z0 = -1e9;
  for (const e of list) {
    if (!cur || e[2] - z0 > 2.5) { cur = []; nodes.push(cur); }   // 相鄰高度差 2.5 m 以內算同一層 (斜坡上的點會一路串起來)
    z0 = e[2];
    cur.push(e);
    const w = W[e[0]];
    if (e[1] === 0 || e[1] === w.n - 1) nodeOf.set(e[0] * 65536 + e[1], nodes.length - 1);
  }
}
const hd8 = (dx, dy) => { let a = Math.round(Math.atan2(dy, dx) / Math.PI * 128); if (a > 127) a -= 256; return a; };
const tan = (w, i, dir) => {   // 在第 i 點、往 dir 方向的切線
  const a = Math.max(0, Math.min(w.n - 2, dir > 0 ? i : i - 1));
  const dx = w.P[a * 3 + 3] - w.P[a * 3], dy = w.P[a * 3 + 4] - w.P[a * 3 + 1];
  return dir > 0 ? [dx, dy] : [-dx, -dy];
};
// 路網縫隙: 有些路段端點沒有剛好落在下一段的點上 (差幾公尺，遊戲裡車子會直接貼到旁邊的路面繼續走)。
// 路段端點走不下去時，找 8 m 內、高度差 2.5 m 內、方向順得過去的其他路段點接上。
{
  const GC2 = 16, g2 = new Map();
  for (const w of W) if (w) for (let i = 0; i < w.n; i++) {
    const k = Math.floor(w.P[i * 3] / GC2) * 100003 + Math.floor(w.P[i * 3 + 1] / GC2);
    let a = g2.get(k); if (!a) g2.set(k, a = []); a.push(w.gid, i);
  }
  const canGo = (nd, g, dir) => {
    const w = W[g], [hx, hy] = tan(w, dir > 0 ? w.n - 1 : 0, dir), L = Math.hypot(hx, hy) || 1;
    for (const [og, oi] of nodes[nd]) {
      if (og === g) continue;
      const o = W[og];
      for (const od of [1, -1]) {
        if (od > 0 ? oi >= o.n - 1 : (!o.two || oi <= 0)) continue;
        const [tx, ty] = tan(o, oi, od), M = Math.hypot(tx, ty) || 1;
        if ((hx * tx + hy * ty) / (L * M) >= ((w.city || o.city) ? -0.2 : 0.3)) return true;
      }
    }
    return false;
  };
  let fixed = 0;
  for (const w of W) if (w) for (const dir of w.two ? [1, -1] : [1]) {
    const e = dir > 0 ? w.n - 1 : 0, nd = nodeOf.get(w.gid * 65536 + e);
    if (nd == null || canGo(nd, w.gid, dir)) continue;
    const x = w.P[e * 3], y = w.P[e * 3 + 1], z = w.P[e * 3 + 2];
    const [hx, hy] = tan(w, e, dir), L = Math.hypot(hx, hy) || 1;
    const best = new Map();   // 每條路段只接最近的一點
    const cx = Math.floor(x / GC2), cy = Math.floor(y / GC2);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = g2.get((cx + i) * 100003 + cy + j); if (!a) continue;
      for (let q = 0; q < a.length; q += 2) {
        const og = a[q], oi = a[q + 1]; if (og === w.gid) continue;
        const o = W[og], d = Math.hypot(o.P[oi * 3] - x, o.P[oi * 3 + 1] - y);
        if (d > 8 || Math.abs(o.P[oi * 3 + 2] - z) > 2.5) continue;
        if (oi >= o.n - 1 && !o.two) continue;
        const [tx, ty] = tan(o, oi, 1), M = Math.hypot(tx, ty) || 1, c = (hx * tx + hy * ty) / (L * M);
        if (Math.abs(c) < 0.5 || (c < 0 && !o.two)) continue;
        const b = best.get(og); if (!b || d < b[1]) best.set(og, [oi, d]);
      }
    }
    for (const [og, [oi]] of best) { nodes[nd].push([og, oi, W[og].P[oi * 3 + 2]]); fixed++; }
  }
  console.log('gap links', fixed);
}
const eWay = [], eS = [], eI = [], eHd = [], nOff = [0];
for (const list of nodes) {
  for (const [g, i] of list) {
    const w = W[g];
    if (i < w.n - 1) { eWay.push(g); eS.push(Math.round(w.s[i])); eI.push(i); eHd.push(hd8(...tan(w, i, 1))); }
    if (w.two && i > 0) { eWay.push((g | 0x80000000) >>> 0); eS.push(Math.round(w.s[i])); eI.push(i); eHd.push(hd8(...tan(w, i, -1))); }
  }
  nOff.push(eWay.length);
}
const nn = nodes.length, ne = eWay.length;
console.log('nodes', nn, 'entries', ne);

// ---------------------------------------------------------------- 每條路段
const speedLimit = (w) => w.maxspeed || (w.city ? (w.cls === 5 ? 30 : 50) : w.trunk ? (w.link ? 50 : 80) : (w.link ? 60 : 100));
const wXY = new Int16Array(NW * 4), wNode = new Uint32Array(NW * 2).fill(0xffffffff), wLen = new Uint16Array(NW);
const wFlag = new Uint8Array(NW), wSpd = new Uint8Array(NW), wCls = new Uint8Array(NW), wHd = new Int8Array(NW * 2);
const q5 = (v) => Math.max(-32768, Math.min(32767, Math.round(v / 5)));
for (const w of W) if (w) {
  const g = w.gid, n = w.n;
  wXY[g * 4] = q5(w.P[0]); wXY[g * 4 + 1] = q5(w.P[1]); wXY[g * 4 + 2] = q5(w.P[(n - 1) * 3]); wXY[g * 4 + 3] = q5(w.P[(n - 1) * 3 + 1]);
  const a = nodeOf.get(g * 65536), b = nodeOf.get(g * 65536 + n - 1);
  if (a != null) wNode[g * 2] = a;
  if (b != null) wNode[g * 2 + 1] = b;
  wLen[g] = Math.min(65535, Math.round(w.s[n - 1]));
  wFlag[g] = (w.city ? 1 : 0) | (w.two ? 2 : 0) | (w.link ? 4 : 0) | (w.trunk ? 8 : 0) | (w.tunnel ? 16 : 0);
  wSpd[g] = speedLimit(w); wCls[g] = w.cls;
  wHd[g * 2] = hd8(...tan(w, 0, -1)); wHd[g * 2 + 1] = hd8(...tan(w, n - 1, 1));
}

// ---------------------------------------------------------------- 目的地
// 依座標找最近的路點 (pref: 優先的路段種類)
const GRID = new Map(), GC = 200;
for (const w of W) if (w) for (let i = 0; i < w.n; i++) {
  const k = Math.floor(w.P[i * 3] / GC) * 100003 + Math.floor(w.P[i * 3 + 1] / GC);
  let a = GRID.get(k); if (!a) GRID.set(k, a = []); a.push(w.gid, i);
}
function nearest(x, y, ok, R = 1500) {
  let best = null, bd = R * R;
  const r = Math.ceil(R / GC), cx = Math.floor(x / GC), cy = Math.floor(y / GC);
  for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
    const a = GRID.get((cx + i) * 100003 + (cy + j)); if (!a) continue;
    for (let q = 0; q < a.length; q += 2) {
      const w = W[a[q]], p = a[q + 1];
      if (!ok(w)) continue;
      const d = (w.P[p * 3] - x) ** 2 + (w.P[p * 3 + 1] - y) ** 2;
      if (d < bd) { bd = d; best = [w.gid, Math.min(p, w.n - 2)]; }
    }
  }
  return best;
}
const dest = [], seen = new Set();
const pushDest = (name, kind, g, i) => {
  const w = W[g]; if (!w) return;
  const key = kind + name; if (seen.has(key)) return; seen.add(key);
  dest.push([name, kind, g, i, Math.round(w.P[i * 3]), Math.round(w.P[i * 3 + 1])]);
};
// 傳送地點
for (const [name, g, i] of idx.spawns || []) pushDest(name.replace(/\s+/g, ' '), 'spot', g, Math.min(i, (W[g] ? W[g].n : 2) - 2));
// 交流道: 出口指示牌 (主線 gid、點) 前方第一個分岔出去的匝道，目的地 = 匝道終點 (下了交流道)
try {
  const signs = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'extra', 'signs.json'), 'utf8'));
  const byMain = new Map();
  for (const [g, e, , mg, mi] of ramps) if (e === 0) { let a = byMain.get(mg); if (!a) byMain.set(mg, a = []); a.push([g, mi]); }
  for (const s of signs) {
    if (!s.name) continue;
    // 主線在指示牌之後可能已經換到下一條路段: 沿接續找 2 km 內第一個出口匝道
    let g = s.gid, from = s.idx, dist = 0, found = null, guard = 0;
    while (g != null && dist < 2000 && guard++ < 8) {
      const w = W[g]; if (!w) break;
      const c = (byMain.get(g) || []).filter(([, mi]) => mi >= from).sort((a, b) => a[1] - b[1]);
      if (c.length) { found = c[0][0]; break; }
      dist += w.s[w.n - 1] - w.s[Math.min(from, w.n - 1)];
      const nd = nodeOf.get(g * 65536 + w.n - 1); g = null; from = 0;
      if (nd != null) for (const [og, oi] of nodes[nd]) { const o = W[og]; if (og !== w.gid && !o.link && !o.city && oi === 0) { g = og; break; } }
    }
    if (found != null) { const r = W[found]; pushDest(s.name.replace(/(交流道)?$/, '交流道'), 'exit', found, Math.max(0, r.n - 2)); }
  }
} catch (e) { console.log('signs skipped', e.message); }
// OSM 地名 (fetch_places.py): 城鎮、鄉里、車站、服務區
const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F), EP2 = E2 / (1 - E2), K0 = 0.9999, LON0 = 121, FE = 250000;
function tm2(lat, lon) {
  const phi = lat * Math.PI / 180, lam = (lon - LON0) * Math.PI / 180;
  const s = Math.sin(phi), c = Math.cos(phi), N = A / Math.sqrt(1 - E2 * s * s), Tn = Math.tan(phi) ** 2, C = EP2 * c * c, Aa = c * lam;
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
  const x = FE + K0 * N * (Aa + (1 - Tn + C) * Aa ** 3 / 6 + (5 - 18 * Tn + Tn * Tn + 72 * C - 58 * EP2) * Aa ** 5 / 120);
  const y = K0 * (M + N * Math.tan(phi) * (Aa * Aa / 2 + (5 - Tn + 9 * C + 4 * C * C) * Aa ** 4 / 24 + (61 - 58 * Tn + Tn * Tn + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  return [x - idx.origin_twd97[0], y - idx.origin_twd97[1]];
}
const placesFile = path.join(DATA, 'places_osm.json');
if (fs.existsSync(placesFile)) {
  const els = JSON.parse(fs.readFileSync(placesFile, 'utf8')).elements || [];
  const RANK = { city: 0, town: 1, suburb: 2, station: 3, services: 3, quarter: 4, village: 5, rest_area: 6 };
  const items = [];
  for (const e of els) {
    const t = e.tags || {}; const name = t['name:zh'] || t.name; if (!name || e.lat == null) continue;
    let kind = t.place || (t.railway === 'station' ? 'station' : t.highway === 'services' ? 'services' : t.highway === 'rest_area' ? 'rest_area' : null);
    if (!kind || RANK[kind] == null) continue;
    if (kind === 'station' && !/站$/.test(name)) continue;
    items.push([RANK[kind], name, kind, e.lat, e.lon]);
  }
  items.sort((a, b) => a[0] - b[0]);
  for (const [, name, kind, lat, lon] of items) {
    const [x, y] = tm2(lat, lon);
    const ok = kind === 'services' || kind === 'rest_area' ? (w) => !w.city : (w) => w.city && w.cls <= 4;
    const r = nearest(x, y, ok, kind === 'services' ? 600 : 1500);
    if (r) pushDest(name, kind === 'services' || kind === 'rest_area' ? 'services' : kind === 'station' ? 'station' : 'place', r[0], r[1]);
  }
}
console.log('destinations', dest.length);

// ---------------------------------------------------------------- 地名里程牌 (國道入口匝道併入主線後約 600 m) -> web/extra/distsigns.json
// 照實景: 綠底白字，列出前方 3 個交流道與距離 (公里)。[主線 gid, 點, [[地名, 公里], ...]]
try {
  const signs = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'extra', 'signs.json'), 'utf8'));
  const sByGid = new Map();
  for (const s of signs) if (s.name) { let a = sByGid.get(s.gid); if (!a) sByGid.set(s.gid, a = []); a.push(s); }
  for (const a of sByGid.values()) a.sort((p, q) => p.idx - q.idx);
  // 出口 = 從主線分岔出去的匝道 (fix_clip 的 ramp 別名，端點 0)；名稱用那裡的出口指示牌，沒有就用匝道名稱
  const clean = (t) => (t || '').replace(/[（(].*?[)）]/g, '').replace(/(系統)?(交流道)?(北上|南下|東向|西向)?(出口|入口)?(匝道|引道)?$/, '').replace(/(系統)?交流道$/, '').trim();
  const exits = new Map();
  const pairs = [];
  for (const list of nodes) for (const [g, e] of list) {
    const r = W[g]; if (!r.link || r.city || e !== 0) continue;
    for (const [mg, mi] of list) { const m = W[mg]; if (!m.link && !m.city && mi < m.n - 1 || (!m.link && !m.city && mi === m.n - 1)) pairs.push([g, mg, mi]); }
  }
  for (const [g, mg, mi] of pairs) {
    const r = W[g], m = W[mg];
    const sg = (sByGid.get(mg) || []).filter((s) => s.idx <= mi && m.s[mi] - m.s[s.idx] < 700).pop();
    const name = sg ? clean(sg.name) : clean(r.name);
    if (!name || /^\d/.test(name)) continue;
    let a = exits.get(mg); if (!a) exits.set(mg, a = []);
    if (!a.some((x) => x.idx === mi)) a.push({ idx: mi, name });
  }
  for (const a of exits.values()) a.sort((p, q) => p.idx - q.idx);
  const nextMain = (w) => {   // 主線接續: 同路線編號優先
    const nd = nodeOf.get(w.gid * 65536 + w.n - 1); if (nd == null) return null;
    let best = null;
    for (const [og, oi] of nodes[nd]) { const o = W[og]; if (og === w.gid || o.link || o.city || oi !== 0) continue; if (!best || (o.ref === w.ref && best.ref !== w.ref)) best = o; }
    return best;
  };
  const out = [], done = new Set();
  for (const [g, e, , mg, mi] of ramps) {
    const r = W[g], m = W[mg];
    if (!r || !m || !r.link || m.link || m.city || e !== r.n - 1) continue;   // 只要「匝道終點併入主線」
    const key = mg * 65536 + mi; if (done.has(key)) continue; done.add(key);
    // 從併入點往前 600 m 放牌子
    let w = m, i = mi, left = 600, guard = 0;
    while (w && guard++ < 20) {
      let k = i; while (k < w.n - 1 && w.s[k] - w.s[i] < left) k++;
      if (w.s[k] - w.s[i] >= left) { i = k; break; }
      left -= w.s[w.n - 1] - w.s[i]; w = nextMain(w); i = 0;
    }
    if (!w) continue;
    const at = [w.gid, Math.min(i, w.n - 2)];
    // 往前收集出口: 出口指示牌在分岔點前 230 m
    const list = []; let d = 0, cw = w, ci = i; guard = 0;
    while (cw && list.length < 3 && d < 90000 && guard++ < 400) {
      for (const s of exits.get(cw.gid) || []) {
        if (s.idx < ci) continue;
        const km = (d + cw.s[Math.min(s.idx, cw.n - 1)] - cw.s[ci]) / 1000;
        const nm = s.name;
        if (km > 0.3 && !list.some((x) => x[0] === nm)) list.push([nm, Math.max(1, Math.round(km))]);
        if (list.length >= 3) break;
      }
      d += cw.s[cw.n - 1] - cw.s[ci]; cw = nextMain(cw); ci = 0;
    }
    if (list.length) out.push([at[0], at[1], list, m.ref || '']);
  }
  fs.writeFileSync(path.join(ROOT, 'web', 'extra', 'distsigns.json'), JSON.stringify(out));
  console.log('distance signs', out.length, out.slice(0, 3).map((o) => o[2].map((x) => x.join(' ')).join(', ')).join(' | '));
} catch (e) { console.log('distsigns skipped', e.message); }

// ---------------------------------------------------------------- 測速照相 (fetch_cameras.py) -> web/extra/cameras.json
// cams: [x, y, z, 監測的行進方位 (弧度；null = 雙向), 速限, 種類 0 固定式]
// sections (區間測速): [名稱, 速限, 起點 x, y, 終點 x, y, 起點行進方位]
const camFile = path.join(DATA, 'cameras_osm.json');
if (fs.existsSync(camFile)) {
  const els = JSON.parse(fs.readFileSync(camFile, 'utf8')).elements || [];
  const node = new Map();
  for (const e of els) if (e.type === 'node') node.set(e.id, e);
  // 相機所屬的執法關係: 從 from 點往相機的方向 = 被拍的車流方向
  const relOf = new Map(), sections = [];
  const num = (v) => { const m = /\d+/.exec(v || ''); return m ? +m[0] : 0; };
  for (const r of els) {
    if (r.type !== 'relation') continue;
    const t = r.tags || {};
    const role = (k) => r.members.filter((m) => m.type === 'node' && m.role === k).map((m) => node.get(m.ref)).filter(Boolean);
    const from = role('from')[0], to = role('to')[0], devs = role('device');
    if (t.enforcement === 'maxspeed') for (const d of devs) relOf.set(d.id, { from, max: num(t.maxspeed) });
    if (t.enforcement === 'average_speed' && from && to) {
      const [fx, fy] = tm2(from.lat, from.lon), [tx, ty] = tm2(to.lat, to.lon);
      sections.push({ name: t['name:zh'] || t.name || '', max: num(t.maxspeed), fx, fy, tx, ty });
    }
  }
  // 找最近的路段點；有方向就挑行進方向對得上的那一側車道
  function snap(x, y, hdg, R = 35) {
    let best = null, bs = 1e18;
    const r = Math.ceil(R / GC), cx = Math.floor(x / GC), cy = Math.floor(y / GC);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const a = GRID.get((cx + i) * 100003 + (cy + j)); if (!a) continue;
      for (let q = 0; q < a.length; q += 2) {
        const w = W[a[q]], p = a[q + 1];
        if (w.link) continue;
        const d2 = (w.P[p * 3] - x) ** 2 + (w.P[p * 3 + 1] - y) ** 2;
        if (d2 > R * R) continue;
        const [dx, dy] = tan(w, p, 1), th = Math.atan2(dy, dx);
        let sc = d2, dirH = th;
        if (hdg != null) {
          const c = Math.cos(hdg - th);
          if (w.two) { dirH = c >= 0 ? th : th + Math.PI; sc += (1 - Math.abs(c)) * 900; }
          else sc += (1 - c) * 900;
        }
        if (sc < bs) { bs = sc; best = { w, p, th: dirH }; }
      }
    }
    return best;
  }
  const cams = [];
  for (const e of els) {
    const t = e.tags || {};
    if (e.type !== 'node' || t.highway !== 'speed_camera') continue;
    const [x, y] = tm2(e.lat, e.lon);
    const rel = relOf.get(e.id);
    let hdg = null;
    if (rel && rel.from) { const [fx, fy] = tm2(rel.from.lat, rel.from.lon); if (Math.hypot(x - fx, y - fy) > 3) hdg = Math.atan2(y - fy, x - fx); }
    if (hdg == null && /^\d+(\.\d+)?$/.test(t.direction || '')) hdg = Math.PI / 2 - (+t.direction) * Math.PI / 180;   // 0 = 北、順時針 -> 數學角
    const s = snap(x, y, hdg);
    if (!s) continue;
    const { w, p } = s;
    // 單向路段 (國道一側車道): 方向就是路的方向；雙向一般道路沒資料就兩個方向都拍
    const dirH = !w.two ? s.th : (hdg != null ? s.th : null);
    const max = num(t.maxspeed) || (rel && rel.max) || speedLimit(w);
    cams.push([Math.round(w.P[p * 3] * 10) / 10, Math.round(w.P[p * 3 + 1] * 10) / 10, Math.round(w.P[p * 3 + 2] * 10) / 10,
      dirH == null ? null : Math.round(dirH * 1000) / 1000, max, 0]);
  }
  const secs = [];
  for (const s of sections) {
    const a = snap(s.fx, s.fy, Math.atan2(s.ty - s.fy, s.tx - s.fx), 60), b = snap(s.tx, s.ty, Math.atan2(s.ty - s.fy, s.tx - s.fx), 60);
    if (!a || !b) continue;
    secs.push([s.name, s.max || speedLimit(a.w), Math.round(a.w.P[a.p * 3]), Math.round(a.w.P[a.p * 3 + 1]), Math.round(b.w.P[b.p * 3]), Math.round(b.w.P[b.p * 3 + 1]),
      Math.round(a.th * 1000) / 1000, Math.round(a.w.P[a.p * 3 + 2]), Math.round(b.w.P[b.p * 3 + 2])]);
  }
  fs.writeFileSync(path.join(ROOT, 'web', 'extra', 'cameras.json'), JSON.stringify({ cams, sections: secs }));
  console.log('cameras', cams.length, 'sections', secs.length, secs.map((s) => s[0] + ' ' + s[1]).join(' / '));
}

// ---------------------------------------------------------------- 寫檔
const head = Buffer.from(JSON.stringify({ nw: NW, nn, ne, dest }));
const pad = (4 - head.length % 4) % 4;
const parts = [Buffer.from(new Uint32Array([head.length + pad]).buffer), head, Buffer.alloc(pad, 32)];
const push = (ta) => parts.push(Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
push(wXY); push(wNode); push(Uint32Array.from(nOff)); push(Uint32Array.from(eWay));
push(wLen); push(Uint16Array.from(eS.map((v) => Math.min(65535, v)))); push(Uint16Array.from(eI));
push(wFlag); push(wSpd); push(wCls); push(wHd); push(Int8Array.from(eHd));
const out = Buffer.concat(parts);
fs.mkdirSync(path.join(TILES, 'n'), { recursive: true });
fs.writeFileSync(path.join(TILES, 'n', 'nav.bin'), out);
console.log('wrote tiles/n/nav.bin', (out.length / 1e6).toFixed(2), 'MB');
