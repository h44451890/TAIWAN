/* 台灣 1:1 — 擴充: 即時路況、AI 車流、CMS 電子看板、ETC 門架、警廣電台、引擎音效
 * 資料來自 Smart-Nav-Map (api/freeway-speed.js、api/cms.js、etc_gantry_data.js、智行地圖.html 電台)
 */
(function () {
'use strict';
const TW = window.TW;
if (!TW) return;
const T = TW.T, WAYS = TW.WAYS, S = TW.S, LANE_W = TW.LANE_W;
const $ = (id) => document.getElementById(id);
const LIVE = JSON.parse($('extra-live').textContent);
const API = TW.params.get('api') || LIVE.apiBase;
const rand = (a, b) => a + Math.random() * (b - a);

// ======================================================================= 即時路況
const ROADS = new Set(LIVE.sections.map((x) => x.road));
const WAYMAP = LIVE.wayMap;
let SECTIONS = LIVE.sections;
const fmtTime = (s) => { const m = /T(\d\d:\d\d)/.exec(s || ''); return m ? m[1] : ''; };
let trafficSource = '快照 ' + fmtTime(LIVE.updateTime);
const wayTraffic = new Array(WAYS.length).fill(null);
const LV_COLOR = ['#8a939b', '#2fbf5b', '#b9d63a', '#f2b632', '#f07c2a', '#e0302a'];
const LV_NAME = ['無資料', '順暢', '車多', '車多', '壅塞', '嚴重壅塞'];
const levelOf = (t) => {
  if (!t || t.speed < 0) return 0;
  if (t.level) return Math.min(5, Math.max(1, t.level));
  return t.speed >= 80 ? 1 : t.speed >= 60 ? 2 : t.speed >= 40 ? 3 : t.speed >= 20 ? 4 : 5;
};
function recomputeTraffic() {
  const idx = {};
  for (const x of SECTIONS) (idx[x.road + '|' + x.dir] = idx[x.road + '|' + x.dir] || []).push(x);
  for (let k = 0; k < WAYS.length; k++) {
    wayTraffic[k] = null;
    const mp = WAYMAP[k];
    if (!mp) continue;
    const arr = idx[mp[0] + '|' + mp[1]] || (mp[0].indexOf('汐止五股') >= 0 ? idx['國道1號|' + mp[1]] : null);
    if (!arr) continue;
    let best = null, bd = 1e18;
    for (const x of arr) {
      const lo = Math.min(x.s, x.e), hi = Math.max(x.s, x.e);
      const d = mp[2] < lo ? lo - mp[2] : mp[2] > hi ? mp[2] - hi : 0;
      if (d < bd) { bd = d; best = x; }
    }
    if (best && bd < 1500) wayTraffic[k] = best;
  }
}
recomputeTraffic();
TW.HOOKS.wayColor = (w) => {
  if (w.link) return null;
  const lv = levelOf(wayTraffic[w.k]);
  return lv ? LV_COLOR[lv] : null;
};
async function fetchJson(url, ms) {
  const c = new AbortController();
  const tm = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(tm); }
}
async function pollSpeed() {
  let wait = 60000;
  try {
    const j = await fetchJson(API + '/freeway-speed', 8000);
    if (j && j.ok && j.data && Array.isArray(j.data.items)) {
      SECTIONS = j.data.items.filter((x) => ROADS.has(x.road));
      trafficSource = '即時 ' + fmtTime(j.data.updateTime);
      recomputeTraffic();
      for (const c of cars) if (c.alive) c.v0 = desiredSpeed(c);
      wait = (j.data.nextUpdateIn || 60000) + Math.random() * 1500;
    }
  } catch (e) { /* 連不到後端: 沿用快照 */ }
  setTimeout(pollSpeed, wait);
}

// ======================================================================= 共用: 合併幾何
function sliceGeo(g, start, count) {
  const out = new T.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const a = g.getAttribute(name);
    out.setAttribute(name, new T.Float32BufferAttribute(a.array.slice(start * 3, (start + count) * 3), 3));
  }
  return out;
}
function mergeGeos(list) {
  let n = 0;
  for (const g of list) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.getAttribute('position').array, o * 3);
    const na = g.getAttribute('normal');
    if (na) nor.set(na.array, o * 3);
    o += g.getAttribute('position').count;
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}
/** 把 root 底下的 mesh 依材質合併 (座標相對 frame)。filter(o) 決定要不要收。 */
function bakeByMaterial(root, frame, filter) {
  root.updateMatrixWorld(true);
  const inv = new T.Matrix4().copy(frame.matrixWorld).invert();
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh || (filter && !filter(o))) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const parts = (Array.isArray(o.material) && g.groups.length) ? g.groups.map((gr) => [mats[gr.materialIndex], sliceGeo(g, gr.start, gr.count)]) : [[mats[0], g]];
    for (const [m, pg] of parts) { if (!byMat.has(m)) byMat.set(m, []); byMat.get(m).push(pg); }
  });
  return [...byMat].map(([m, list]) => [m, mergeGeos(list)]);
}

// ======================================================================= AI 車流
const MAX_AI = Math.max(0, Math.min(200, +(TW.params.get('cars') || 90)));
const COLORS = [ // 線性色彩；權重
  [[0.80, 0.80, 0.78], 24], [[0.45, 0.46, 0.48], 18], [[0.012, 0.012, 0.014], 14], [[0.09, 0.095, 0.10], 10],
  [[0.80, 0.52, 0.02], 8], [[0.50, 0.02, 0.02], 7], [[0.03, 0.08, 0.36], 7], [[0.04, 0.17, 0.07], 4], [[0.48, 0.40, 0.28], 5], [[0.65, 0.66, 0.70], 3],
];
const COLOR_SUM = COLORS.reduce((a, c) => a + c[1], 0);
function pickColor() { let r = Math.random() * COLOR_SUM; for (const [c, w] of COLORS) { if ((r -= w) <= 0) return c; } return COLORS[0][0]; }
const BODY_TYPES = [[1, 1, 1, 50], [1.0, 1.16, 1.04, 30], [0.88, 1.03, 0.99, 20]]; // 轎車 / 休旅 / 掀背 (長, 高, 寬)

const cars = [];
let inst = null;
function buildInstances() {
  const tpl = TW.buildCar();
  const ud = tpl.userData;
  const pivR = ud.wheels[0].pivot, pivL = ud.wheels[1].pivot;
  const wheelPivots = new Set(ud.wheels.map((w) => w.pivot));
  const under = (o, p) => { while (o) { if (o === p) return true; o = o.parent; } return false; };
  const inAnyWheel = (o) => { for (const p of wheelPivots) if (under(o, p)) return true; return false; };
  const conv = (m) => {
    if (m === ud.paint) { const c = m.clone(); c.color.setRGB(1, 1, 1); c.userData.kind = 'paint'; return c; }
    if (m === ud.tailMat) { const c = new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }); c.userData.kind = 'tail'; return c; }
    if (m === ud.headMat) return new T.MeshBasicMaterial({ color: new T.Color(1.6, 1.55, 1.4) });
    if (m === ud.sigLMat || m === ud.sigRMat) { const c = new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }); c.userData.kind = m === ud.sigLMat ? 'sigL' : 'sigR'; return c; }
    const c = m.clone(); if (c.map) c.map = null; return c;
  };
  const mk = (pairs, count) => pairs.map(([m, g]) => {
    const im = new T.InstancedMesh(g, conv(m), count);
    im.instanceMatrix.setUsage(T.DynamicDrawUsage);
    im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true; im.count = 0;
    const kind = im.material.userData.kind;
    if (kind) { for (let i = 0; i < count; i++) im.setColorAt(i, new T.Color(1, 1, 1)); }
    TW.scene.add(im);
    return im;
  });
  inst = {
    body: mk(bakeByMaterial(tpl, tpl, (o) => !inAnyWheel(o)), MAX_AI),
    wr: mk(bakeByMaterial(pivR, pivR), MAX_AI * 2),
    wl: mk(bakeByMaterial(pivL, pivL), MAX_AI * 2),
    offR: [ud.wheels[0].pivot.position.clone(), ud.wheels[2].pivot.position.clone()],
    offL: [ud.wheels[1].pivot.position.clone(), ud.wheels[3].pivot.position.clone()],
  };
}

const NEXT = new Map();
function nextMain(w) {
  if (NEXT.has(w.k)) return NEXT.get(w.k);
  const lx = w.P[(w.n - 1) * 3], ly = w.P[(w.n - 1) * 3 + 1];
  const tx = w.ny[w.n - 1], ty = -w.nx[w.n - 1];
  let best = null, bs = -1e9;
  for (const [k, i] of (TW.PT_INDEX.get(TW.ptKey(lx, ly)) || [])) {
    if (k === w.k || WAYS[k].city) continue;   // AI 不開進一般道路 (到盡頭會在遠處回收)
    const o = WAYS[k];
    if (i >= o.n - 1) continue;
    const dot = tx * o.ny[i] + ty * -o.nx[i];
    if (dot < 0.5) continue;
    const sc = dot + (o.ref === w.ref && o.ref ? 2 : 0) + (o.link ? -3 : 0) + (w.link && !o.link ? 3 : 0);
    if (sc > bs) { bs = sc; best = [o, i]; }
  }
  NEXT.set(w.k, best);
  return best;
}
function seek(w, s) {
  let lo = 0, hi = w.n - 1;
  if (s <= 0) return 0;
  if (s >= w.s[hi]) return hi - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (w.s[m] <= s) lo = m; else hi = m; }
  return lo;
}
const POSE = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
function poseAt(w, s, lat, out = POSE) {
  const i = seek(w, s), P = w.P;
  const L = (w.s[i + 1] - w.s[i]) || 1, t = Math.min(Math.max((s - w.s[i]) / L, 0), 1);
  const nx = w.nx[i] + (w.nx[i + 1] - w.nx[i]) * t, ny = w.ny[i] + (w.ny[i + 1] - w.ny[i]) * t, nl = Math.hypot(nx, ny) || 1;
  out.x = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t + nx / nl * lat;
  out.y = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t + ny / nl * lat;
  out.z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t;
  out.tx = ny / nl; out.ty = -nx / nl;
  return out;
}
const laneLat = (w, lane) => w.hw - w.ls - LANE_W * (lane + 0.5);
const wayLen = (w) => w.s[w.n - 1];

function desiredSpeed(c) {
  const t = wayTraffic[c.w.k];
  const lim = (c.w.maxspeed || (c.w.trunk ? (c.w.link ? 50 : 80) : (c.w.link ? 60 : 100))) / 3.6;
  const base = t && t.speed > 0 ? t.speed / 3.6 : lim;
  return Math.max(3, base * c.pers * c.mood);
}
function densityWeight(w) {
  const lv = levelOf(wayTraffic[w.k]);
  return [1, 1, 1.8, 2.6, 3.6, 4.5][lv];
}

// 生成點: 主線每 40 m 一個
const SAMPLES = [];
for (const w of WAYS) {
  if (w.link || w.city || w.n < 2 || wayLen(w) < 20) continue;   // AI 只在國道 / 快速道路主線生成
  for (let s = 10; s < wayLen(w) - 5; s += 40) { poseAt(w, s, 0); SAMPLES.push([w.k, s, POSE.x, POSE.y]); }
}

function trySpawn(c, minR, maxR) {
  const cand = [];
  for (const sm of SAMPLES) {
    const d2 = (sm[2] - S.x) ** 2 + (sm[3] - S.y) ** 2;
    if (d2 > minR * minR && d2 < maxR * maxR) cand.push(sm);
  }
  if (!cand.length) return false;
  for (let attempt = 0; attempt < 16; attempt++) {
    const sm = cand[(Math.random() * cand.length) | 0];
    const w = WAYS[sm[0]];
    if (Math.random() > densityWeight(w) / 4.5) continue;
    const lane = (Math.random() * w.lanes) | 0;
    poseAt(w, sm[1], laneLat(w, lane));
    let ok = Math.hypot(POSE.x - S.x, POSE.y - S.y) > Math.min(minR, 40);
    for (const o of cars) if (ok && o.alive && o !== c && (o.x - POSE.x) ** 2 + (o.y - POSE.y) ** 2 < 28 * 28 && Math.abs(o.z - POSE.z) < 3) ok = false;
    if (!ok) continue;
    const bt = (() => { let r = Math.random() * 100; for (const b of BODY_TYPES) if ((r -= b[3]) <= 0) return b; return BODY_TYPES[0]; })();
    Object.assign(c, {
      alive: true, w, s: sm[1], lane, lat: laneLat(w, lane), prevLat: laneLat(w, lane), pers: rand(0.88, 1.1), mood: 1, moodT: 1, moodTimer: rand(10, 40),
      color: pickColor(), sx: bt[0], sy: bt[1], sz: bt[2], len: 4.7 * bt[0], spin: 0, lcCool: rand(2, 8), brake: false, deadEnd: false, pending: null, signal: 0, sigT: 0,
      x: POSE.x, y: POSE.y, z: POSE.z, h: Math.atan2(POSE.ty, POSE.tx), pitch: 0,
    });
    c.v0 = desiredSpeed(c); c.v = c.v0 * rand(0.85, 1);
    return true;
  }
  return false;
}

function initTraffic() {
  if (!MAX_AI) return;
  buildInstances();
  for (let i = 0; i < MAX_AI; i++) { const c = { alive: false }; cars.push(c); trySpawn(c, 60, 1500); }
}

const IDM = { A: 1.4, B: 2.2, S0: 2.5, TH: 1.3 };
// 玩家也算一台車 (給 AI 跟車、換道判斷用)
const PLAYER = { len: 4.7, isPlayer: true };
function syncPlayer() {
  PLAYER.x = S.x; PLAYER.y = S.y; PLAYER.z = S.z; PLAYER.h = S.h; PLAYER.v = S.v;
  PLAYER.changing = !!S.signal;
  return PLAYER;
}
const isChanging = (o) => o.isPlayer ? o.changing : (o.pending != null || Math.abs(o.lat - laneLat(o.w, o.lane)) > 0.3);
function eachOther(me, fn) {
  for (const o of cars) if (o !== me && o.alive) fn(o);
  if (me !== PLAYER) fn(syncPlayer());
}
/** 前車: shift = 目標車道相對目前位置的橫向位移 (左正)；換道途中兩個車道都要看 */
function leaderFor(me, shift) {
  const fx = Math.cos(me.h), fy = Math.sin(me.h);
  const lo = Math.min(0, shift) - 1.9, hi = Math.max(0, shift) + 1.9;
  let gap = 1e9, vl = 40;
  eachOther(me, (o) => {
    if (Math.abs(o.z - me.z) > 3) return;
    const dx = o.x - me.x, dy = o.y - me.y, d = dx * fx + dy * fy;
    if (d <= 0 || d > 160) return;
    const lat = -dx * fy + dy * fx;
    if (lat < lo || lat > hi || Math.cos(o.h - me.h) < 0.3) return;
    const g = d - (me.len + o.len) / 2;
    if (g < gap) { gap = g; vl = Math.max(0, o.v * Math.cos(o.h - me.h)); }
  });
  return { gap, v: vl };
}
/** 目標車道安全嗎: 前後都要留距離；附近有車正在換道 (或打方向燈) 也先不切，避免兩台同時切進同一車道 */
function laneSafeFor(me, shift) {
  const fx = Math.cos(me.h), fy = Math.sin(me.h);
  let safe = true;
  eachOther(me, (o) => {
    if (!safe || Math.abs(o.z - me.z) > 3 || Math.cos(o.h - me.h) < 0.3) return;
    const dx = o.x - me.x, dy = o.y - me.y, d = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
    if (Math.abs(lat - shift) < 2.1 && d > -(14 + Math.max(0, o.v - me.v) * 2.8) && d < 24 + Math.max(0, me.v - o.v) * 2.2) { safe = false; return; }
    if (Math.abs(d) >= 32 || !isChanging(o)) return;
    if (o.isPlayer) { if (Math.abs(lat - shift) < 5.8) safe = false; return; }
    // 對方正在換道 / 打方向燈: 只有他要切進我想去的那條車道時才讓
    const tl = laneLat(o.w, o.pending != null ? o.pending : o.lane) - o.lat;
    if (Math.abs(lat + tl - shift) < 2.3) safe = false;
  });
  return safe;
}
TW.HOOKS.leader = (shift) => leaderFor(syncPlayer(), shift);
TW.HOOKS.laneFree = (shift) => laneSafeFor(syncPlayer(), shift);

const stats = { bumps: 0, laneChanges: 0 };
function stepCar(c, dt) {
  const w = c.w;
  // 前車 (含玩家)
  const shift = laneLat(w, c.lane) - c.lat;
  const ld = leaderFor(c, c.pending != null ? laneLat(w, c.pending) - c.lat : shift);
  const gap = ld.gap, vl = ld.gap < 1e8 ? ld.v : c.v0;
  // 個性: 偶爾想快一點或慢一點
  c.moodTimer -= dt;
  if (c.moodTimer <= 0) { c.moodT = rand(0.88, 1.12); c.moodTimer = rand(15, 50); }
  c.mood += (c.moodT - c.mood) * Math.min(1, dt * 0.3);
  c.v0 = desiredSpeed(c);
  // IDM
  let a = IDM.A * (1 - Math.pow(c.v / c.v0, 4));
  if (gap < 1e8) {
    const ss = IDM.S0 + Math.max(0, c.v * IDM.TH + c.v * (c.v - vl) / (2 * Math.sqrt(IDM.A * IDM.B)));
    a -= IDM.A * (ss / Math.max(gap, 0.1)) ** 2;
  }
  a = Math.max(-9, Math.min(IDM.A, a));
  c.v = Math.max(0, c.v + a * dt);
  if (gap < 0.6) c.v = Math.min(c.v, vl * 0.9);
  let ds = c.v * dt;
  if (gap < 1e8) ds = Math.min(ds, Math.max(0, gap - 0.4));
  c.brake = a < -0.9 || (c.v < 0.8 && gap < 25);
  // 換車道: 先打方向燈 1.2 秒，再確認一次安全才切；切完熄燈
  c.lcCool -= dt;
  if (c.pending != null) {
    c.sigT -= dt;
    if (c.sigT <= 0) {
      if (c.pending >= 0 && c.pending < w.lanes && laneSafeFor(c, laneLat(w, c.pending) - c.lat)) { c.lane = c.pending; stats.laneChanges++; }
      else c.signal = 0;
      c.pending = null;
    }
  } else if (c.lcCool <= 0 && Math.abs(shift) < 0.3 && w.lanes > 1 && !w.link) {
    const blocked = gap < 50 && vl < c.v0 - 2.5;
    const tries = blocked ? [c.lane - 1, c.lane + 1] : (gap > 90 && Math.random() < dt * 0.08 ? [c.lane + 1] : []);
    for (const ln of tries) {
      if (ln < 0 || ln >= w.lanes) continue;
      if (laneSafeFor(c, laneLat(w, ln) - c.lat)) { c.pending = ln; c.sigT = 1.2; c.signal = ln < c.lane ? -1 : 1; c.lcCool = rand(6, 14); break; }
    }
    if (tries.length && c.lcCool <= 0) c.lcCool = 1.5;
  }
  if (c.pending == null && c.signal && Math.abs(laneLat(c.w, c.lane) - c.lat) < 0.3) c.signal = 0;
  // 前進 (跨路段)
  c.s += ds;
  let guard = 0;
  while (c.s > wayLen(c.w) && guard++ < 8) {
    const nm = nextMain(c.w);
    if (!nm) { c.s = wayLen(c.w); c.v = 0; c.deadEnd = true; break; }
    const wasLink = c.w.link;
    c.s = nm[0].s[nm[1]] + (c.s - wayLen(c.w));
    c.w = nm[0];
    if (c.lane >= c.w.lanes) c.lane = c.w.lanes - 1;
    if (wasLink && !c.w.link) c.lane = c.w.lanes - 1;
  }
  // 橫向 (平滑換道)
  const tgt = laneLat(c.w, c.lane);
  c.prevLat = c.lat;
  c.lat += Math.max(-1.15 * dt, Math.min(1.15 * dt, tgt - c.lat));
  poseAt(c.w, c.s, c.lat);
  c.x = POSE.x; c.y = POSE.y; c.z = POSE.z;
  const latVel = (c.lat - c.prevLat) / Math.max(dt, 1e-3);
  c.h = Math.atan2(POSE.ty, POSE.tx) + Math.atan2(latVel, Math.max(c.v, 3));
  const z1 = poseAt(c.w, Math.min(c.s + 1.4, wayLen(c.w)), c.lat, {}).z, z0 = poseAt(c.w, Math.max(c.s - 1.4, 0), c.lat, {}).z;
  c.pitch = Math.atan2(z1 - z0, 2.8);
  c.spin -= c.v * dt / 0.33;
}

let bumpCooldown = 0;
function collidePlayer(dt) {
  bumpCooldown -= dt;
  const fx = Math.cos(S.h), fy = Math.sin(S.h);
  for (const c of cars) {
    if (!c.alive || Math.abs(c.z - S.z) > 2) continue;
    const dx = c.x - S.x, dy = c.y - S.y;
    if (dx * dx + dy * dy > 64) continue;
    const ax = dx * fx + dy * fy, ay = -dx * fy + dy * fx;
    const hl = 2.35 + c.len / 2 - 0.15, hw = 0.92 + 0.9 * c.sz;
    if (Math.abs(ax) >= hl || Math.abs(ay) >= hw) continue;
    const px = hl - Math.abs(ax), py = hw - Math.abs(ay);
    let nx = S.x, ny = S.y;
    if (px < py) {
      const sg = Math.sign(ax) || 1;
      nx -= fx * sg * px; ny -= fy * sg * px;
      if (ax > 0) S.v = Math.min(S.v, c.v * Math.cos(c.h - S.h) * 0.9); else S.v = Math.max(S.v, c.v * 0.9);
    } else {
      const sg = Math.sign(ay) || 1;
      nx += fy * sg * py; ny -= fx * sg * py;
      S.v *= 0.97;
    }
    if (TW.roadAt(nx, ny, S.z, 0.9)) { S.x = nx; S.y = ny; }
    if (bumpCooldown <= 0) { bumpCooldown = 0.6; stats.bumps++; sound.bump(); }
  }
}

const _m = new T.Matrix4(), _w = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler(), _p = new T.Vector3(), _s = new T.Vector3(), _col = new T.Color();
const TAIL_ON = new T.Color(1, 0.02, 0.01), TAIL_OFF = new T.Color(0.45, 0.004, 0.004);
const SIG_ON = new T.Color(1.0, 0.42, 0.0), SIG_OFF = new T.Color(0.18, 0.07, 0.0);
let respawnClock = 0;
function updateTraffic(dt) {
  if (!inst) return;
  const sub = dt > 1 / 45 ? 2 : 1;
  for (let k = 0; k < sub; k++) for (const c of cars) if (c.alive) stepCar(c, dt / sub);
  collidePlayer(dt);
  // 遠離玩家的車回收到附近 (不在眼前生成或消失)
  respawnClock -= dt;
  if (respawnClock <= 0) {
    respawnClock = 0.25;
    let n = 0;
    for (const c of cars) {
      const d = c.alive ? Math.hypot(c.x - S.x, c.y - S.y) : 1e9;
      if ((d > 1800 || (c.deadEnd && d > 700)) && n++ < 3) { c.alive = false; trySpawn(c, 750, 1500); }
    }
  }
  // 更新繪製
  const blink = (performance.now() % 666) < 333;
  let i = 0;
  for (const c of cars) {
    if (!c.alive) continue;
    _e.set(0, c.h, c.pitch, 'YZX');
    _q.setFromEuler(_e);
    _m.compose(_p.set(c.x, c.z, -c.y), _q, _s.set(c.sx, c.sy, c.sz));
    for (const im of inst.body) {
      im.setMatrixAt(i, _m);
      const kind = im.material.userData.kind;
      if (kind === 'paint') im.setColorAt(i, _col.setRGB(c.color[0], c.color[1], c.color[2]));
      else if (kind === 'tail') im.setColorAt(i, c.brake ? TAIL_ON : TAIL_OFF);
      else if (kind === 'sigL') im.setColorAt(i, c.signal === -1 && blink ? SIG_ON : SIG_OFF);
      else if (kind === 'sigR') im.setColorAt(i, c.signal === 1 && blink ? SIG_ON : SIG_OFF);
    }
    for (const [ims, offs] of [[inst.wr, inst.offR], [inst.wl, inst.offL]]) for (let j = 0; j < 2; j++) {
      _w.makeRotationZ(c.spin); _w.setPosition(offs[j]);
      _w.premultiply(_m);
      for (const im of ims) im.setMatrixAt(i * 2 + j, _w);
    }
    i++;
  }
  for (const im of inst.body) { im.count = i; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  for (const im of [...inst.wr, ...inst.wl]) { im.count = i * 2; im.instanceMatrix.needsUpdate = true; }
}
TW.HOOKS.minimap.push((ctx, s) => {
  for (const c of cars) {
    if (!c.alive) continue;
    ctx.beginPath(); ctx.arc(c.x - S.x, c.y - S.y, 2.4 / s, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${c.color.map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',')})`;
    ctx.fill(); ctx.lineWidth = 0.8 / s; ctx.strokeStyle = '#000'; ctx.stroke();
  }
});

// ======================================================================= CMS 電子看板 / ETC 門架 (造型參考 Smart-Nav-Map cms_3d.js)
const RED_WORDS = /事故|封閉|施工|壅塞|車禍|管制|散落|故障|危險|注意|慢行|追撞|落石|火警/;
const cleanText = (t) => String(t || '').replace(/\(圖\)/g, '').replace(/\(至\)/g, '至').replace(/[\s　]+/g, ' ').trim();
function pageColor(p) {
  if (p.type === '7' || RED_WORDS.test(p.text)) return '#FF3B2F';
  if (p.type === '6' || /雨|霧|風|減速|限速/.test(p.text)) return '#FFB31A';
  return '#3CFF52';
}
function splitLines(t) {
  const a = Array.from(t);
  if (a.length <= 10) return [t];
  const n = Math.ceil(a.length / 2);
  return [a.slice(0, n).join(''), a.slice(n, Math.min(a.length, n * 2)).join('')];
}
const COLS = 192, ROWS = 60, PITCH = 4;
function boardCanvas(p) {
  const lo = document.createElement('canvas'); lo.width = COLS; lo.height = ROWS;
  const lx = lo.getContext('2d'), lines = splitLines(p.text), col = pageColor(p);
  let fs = lines.length > 1 ? 26 : 34;
  const font = (n) => '700 ' + n + 'px "PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif';
  lx.font = font(fs);
  const widest = Math.max(...lines.map((l) => lx.measureText(l).width));
  if (widest > COLS - 4) { fs = Math.max(12, Math.floor(fs * (COLS - 4) / widest)); lx.font = font(fs); }
  lx.fillStyle = '#fff'; lx.textAlign = 'center'; lx.textBaseline = 'middle';
  lines.forEach((l, i) => lx.fillText(l, COLS / 2, lines.length > 1 ? ROWS * (0.27 + i * 0.47) : ROWS / 2));
  const px = lx.getImageData(0, 0, COLS, ROWS).data;
  const cv = document.createElement('canvas'); cv.width = COLS * PITCH; cv.height = ROWS * PITCH;
  const x = cv.getContext('2d');
  x.fillStyle = '#08080A'; x.fillRect(0, 0, cv.width, cv.height);
  const lit = [], dim = [];
  for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) (px[(gy * COLS + gx) * 4 + 3] > 110 ? lit : dim).push(gx, gy);
  const dots = (arr, color, r) => { x.fillStyle = color; x.beginPath(); for (let i = 0; i < arr.length; i += 2) { const cx = arr[i] * PITCH + PITCH / 2, cy = arr[i + 1] * PITCH + PITCH / 2; x.moveTo(cx + r, cy); x.arc(cx, cy, r, 0, Math.PI * 2); } x.fill(); };
  dots(dim, '#1E1F22', 1.35);
  x.globalAlpha = 0.35; dots(lit, col, 2.4);
  x.globalAlpha = 1; dots(lit, col, 1.6);
  return cv;
}
const lampTex = {};
function lampTexture(kind) {
  if (lampTex[kind]) return lampTex[kind];
  const Sz = 128, cv = document.createElement('canvas'); cv.width = Sz; cv.height = Sz;
  const x = cv.getContext('2d');
  let g;
  if (kind === 'halo') {
    g = x.createRadialGradient(Sz / 2, Sz / 2, Sz * 0.12, Sz / 2, Sz / 2, Sz / 2);
    g.addColorStop(0, 'rgba(206,245,90,0.75)'); g.addColorStop(0.45, 'rgba(196,242,58,0.25)'); g.addColorStop(1, 'rgba(196,242,58,0)');
    x.fillStyle = g; x.fillRect(0, 0, Sz, Sz);
  } else {
    x.fillStyle = '#0B0B0D'; x.fillRect(0, 0, Sz, Sz);
    g = x.createRadialGradient(Sz * 0.45, Sz * 0.42, 2, Sz / 2, Sz / 2, Sz * 0.42);
    if (kind === 'on') { g.addColorStop(0, '#FBFFE0'); g.addColorStop(0.35, '#DDF86A'); g.addColorStop(0.8, '#A9D82C'); g.addColorStop(1, '#5E7A14'); }
    else { g.addColorStop(0, '#4A5040'); g.addColorStop(0.6, '#2E3328'); g.addColorStop(1, '#1C1F18'); }
    x.fillStyle = g; x.beginPath(); x.arc(Sz / 2, Sz / 2, Sz * 0.42, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#2A2C30'; x.lineWidth = 4; x.stroke();
  }
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace;
  return (lampTex[kind] = t);
}
function plateCanvas(text, bg = '#0A7A3E', w = 192, h = 64, size = 38) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.strokeStyle = '#FFFFFF'; x.lineWidth = 4; x.strokeRect(4, 4, w - 8, h - 8);
  x.fillStyle = '#FFFFFF'; x.font = '700 ' + size + 'px Arial,"Microsoft JhengHei",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, w / 2, h / 2 + 2);
  return c;
}
const steelMat = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.58, 0.61), metalness: 0.75, roughness: 0.38 });
const darkMat = new T.MeshStandardMaterial({ color: new T.Color(0.018, 0.02, 0.024), metalness: 0.3, roughness: 0.55 });
const texMat = (cv) => { const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return new T.MeshBasicMaterial({ map: t, toneMapped: false }); };

/** 門架本體 (鋼桁架): 回傳暫存群組，之後依材質合併 */
function trussGroup(XL, XR, H, TH) {
  const g = new T.Group(), UP = new T.Vector3(0, 1, 0), TZ = 0.42;
  const rod = (a, b, r) => {
    const A = new T.Vector3(...a), B = new T.Vector3(...b), d = B.clone().sub(A), len = d.length();
    const m = new T.Mesh(new T.CylinderGeometry(r, r, len, r > 0.1 ? 14 : 7), steelMat);
    m.position.copy(A).add(B).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(UP, d.normalize()); g.add(m);
  };
  for (const px of [XL, XR]) {
    rod([px, -0.2, 0], [px, H + TH + 0.3, 0], 0.26);
    const base = new T.Mesh(new T.CylinderGeometry(0.5, 0.55, 0.25, 16), steelMat); base.position.set(px, 0.12, 0); g.add(base);
    const cap = new T.Mesh(new T.CylinderGeometry(0.3, 0.26, 0.12, 16), steelMat); cap.position.set(px, H + TH + 0.36, 0); g.add(cap);
  }
  const nSeg = Math.max(4, Math.round((XR - XL) / 1.1)), step = (XR - XL) / nSeg;
  for (const z of [-TZ, TZ]) {
    rod([XL - 0.3, H, z], [XR + 0.3, H, z], 0.085);
    rod([XL - 0.3, H + TH, z], [XR + 0.3, H + TH, z], 0.085);
    for (let k = 0; k < nSeg; k++) {
      const x = XL + k * step;
      rod([x, H, z], [x, H + TH, z], 0.04);
      rod(k % 2 ? [x, H, z] : [x, H + TH, z], k % 2 ? [x + step, H + TH, z] : [x + step, H, z], 0.04);
    }
    rod([XR, H, z], [XR, H + TH, z], 0.04);
  }
  for (let k = 0; k <= nSeg; k += 2) { const x = XL + k * step; rod([x, H, -TZ], [x, H, TZ], 0.035); rod([x, H + TH, -TZ], [x, H + TH, TZ], 0.035); }
  return g;
}
function placeOnWay(obj, w, i) {
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2];
  const n3 = new T.Vector3(w.nx[i], 0, -w.ny[i]), t3 = new T.Vector3(w.ny[i], 0, w.nx[i]);
  const m = new T.Matrix4().makeBasis(n3.clone().negate(), new T.Vector3(0, 1, 0), t3.clone().negate()); // +x 右、+z 面向來車
  m.setPosition(x, z, -y);
  obj.matrixAutoUpdate = false; obj.matrix.copy(m); obj.updateMatrixWorld(true);
}
function mergedGroup(tmp) {
  const out = new T.Group();
  for (const [mat, geo] of bakeByMaterial(tmp, tmp)) { const m = new T.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; out.add(m); }
  return out;
}

// ---- CMS: 接近才建模型 (LED 貼圖較大)
const signs = LIVE.cms.map((c) => ({ ...c, pages: (c.pages || []).map((p) => ({ text: cleanText(p.text), type: String(p.type || '') })).filter((p) => p.text), model: null, page: 0 }));
function buildSign(sg) {
  const w = WAYS[sg.way], hw = w.hw;
  const XL = -(hw + 0.6), XR = hw + 0.9, H = 7, TH = 1.1;
  const root = new T.Group();
  const truss = trussGroup(XL, XR, H, TH);
  const BW = Math.min(8, XR - XL - 6), BH = 2.3, BY = H + TH + BH / 2 + 0.15, BX = (XL + XR) / 2;
  const box = (wd, ht, dp, mat, x, y, z) => { const m = new T.Mesh(new T.BoxGeometry(wd, ht, dp), mat); m.position.set(x, y, z); truss.add(m); };
  box(BW + 0.3, BH + 0.3, 0.6, darkMat, BX, BY, 0);
  const lampsY = BY + BH / 2 + 0.45, lampXs = [-BW / 2 + 1.2, BW / 2 - 1.2];
  for (const lx of lampXs) box(0.5, 0.45, 0.4, darkMat, BX + lx, lampsY, 0.05);
  box(2.5, 0.9, 0.08, darkMat, XL + 1.7, H + TH / 2, 0.49);
  root.add(mergedGroup(truss));
  const page = sg.pages[0] || { text: '', type: '1' };
  const faceMat = texMat(boardCanvas(page));
  const face = new T.Mesh(new T.PlaneGeometry(BW, BH), faceMat); face.position.set(BX, BY, 0.31); root.add(face);
  const lamps = lampXs.map((lx) => {
    const mat = new T.MeshBasicMaterial({ map: lampTexture('on'), toneMapped: false });
    const led = new T.Mesh(new T.PlaneGeometry(0.42, 0.42), mat); led.position.set(BX + lx, lampsY, 0.255); root.add(led);
    const halo = new T.Mesh(new T.PlaneGeometry(1.1, 1.1), new T.MeshBasicMaterial({ map: lampTexture('halo'), transparent: true, depthWrite: false, toneMapped: false }));
    halo.position.set(BX + lx, lampsY, 0.27); root.add(halo);
    return { mat, halo };
  });
  const mile = new T.Mesh(new T.PlaneGeometry(2.4, 0.8), texMat(plateCanvas((sg.m / 1000).toFixed(1).replace(/\.0$/, '') + 'K')));
  mile.position.set(XL + 1.7, H + TH / 2, 0.54); root.add(mile);
  placeOnWay(root, w, sg.idx);
  TW.scene.add(root);
  return { root, faceMat, lamps };
}
function disposeSign(sg) {
  const md = sg.model; if (!md) return;
  TW.scene.remove(md.root);
  md.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map && !Object.values(lampTex).includes(o.material.map)) o.material.map.dispose(); });
  sg.model = null;
}
let signClock = 0, pageClock = 0, blinkClock = 0, blinkOn = true;
function updateSigns(dt) {
  signClock -= dt; pageClock -= dt; blinkClock -= dt;
  if (signClock <= 0) {
    signClock = 0.5;
    let built = 0;
    for (const sg of signs) {
      const w = WAYS[sg.way], x = w.P[sg.idx * 3], y = w.P[sg.idx * 3 + 1];
      const d = Math.hypot(x - S.x, y - S.y);
      if (!sg.model && d < 1600 && sg.pages.length && built < 3) { sg.model = buildSign(sg); built++; }
      else if (sg.model && d > 2600) disposeSign(sg);
    }
  }
  if (pageClock <= 0) {
    pageClock = 5;
    for (const sg of signs) if (sg.model && sg.pages.length > 1) {
      sg.page = (sg.page + 1) % sg.pages.length;
      const t = sg.model.faceMat.map; t.image = boardCanvas(sg.pages[sg.page]); t.needsUpdate = true;
    }
  }
  if (blinkClock <= 0) {
    blinkClock = 0.6; blinkOn = !blinkOn;
    for (const sg of signs) if (sg.model) for (const lm of sg.model.lamps) { lm.mat.map = lampTexture(blinkOn ? 'on' : 'off'); lm.halo.visible = blinkOn; }
  }
}
async function pollCms() {
  let wait = 60000;
  try {
    const j = await fetchJson(API + '/cms', 8000);
    if (j && j.ok && j.data && Array.isArray(j.data.items)) {
      const byId = new Map(j.data.items.map((x) => [x.id, x]));
      for (const sg of signs) {
        const it = byId.get(sg.id); if (!it) continue;
        const pages = (it.messages || []).map((g) => ({ text: cleanText(g.text), type: String(g.type || '') })).filter((p) => p.text);
        if (pages.map((p) => p.text).join('|') !== sg.pages.map((p) => p.text).join('|')) {
          sg.pages = pages; sg.page = 0;
          if (sg.model && pages.length) { const t = sg.model.faceMat.map; t.image = boardCanvas(pages[0]); t.needsUpdate = true; }
        }
      }
      wait = (j.data.nextUpdateIn || 60000) + Math.random() * 1500;
    }
  } catch (e) { /* 沿用快照 */ }
  setTimeout(pollCms, wait);
}

// ---- ETC 門架: 全部建 (合併後每座 2~3 個繪製呼叫)
function buildEtc(g) {
  const w = WAYS[g.way], hw = w.hw;
  const XL = -(hw + 0.6), XR = hw + 0.9, H = 6.4, TH = 1.0;
  const truss = trussGroup(XL, XR, H, TH);
  // 每車道一組偵測器 (天線箱 + 攝影機)
  for (let ln = 0; ln < w.lanes; ln++) {
    const xc = -(laneLat(w, ln));  // 本地 +x 為右 = -左
    const ant = new T.Mesh(new T.BoxGeometry(0.9, 0.55, 0.35), darkMat); ant.position.set(xc, H - 0.35, 0.25); truss.add(ant);
    const cam = new T.Mesh(new T.BoxGeometry(0.28, 0.24, 0.5), steelMat); cam.position.set(xc + 0.7, H - 0.25, 0.35); truss.add(cam);
    const lens = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 0.05, 12).rotateX(Math.PI / 2), darkMat); lens.position.set(xc + 0.7, H - 0.25, 0.62); truss.add(lens);
  }
  const cab = new T.Mesh(new T.BoxGeometry(0.8, 1.6, 0.6), steelMat); cab.position.set(XR + 0.9, 1.0, 0); truss.add(cab);
  const root = new T.Group();
  root.add(mergedGroup(truss));
  const id = new T.Mesh(new T.PlaneGeometry(1.8, 0.45), texMat(plateCanvas(g.id, '#0A7A3E', 256, 64, 34)));
  id.position.set(XL + 1.4, H + TH / 2, 0.5); root.add(id);
  placeOnWay(root, w, g.idx);
  TW.scene.add(root);
}

// ======================================================================= 警廣電台 (hls.js)
const radio = (() => {
  const R = LIVE.radio, st = R.stations;
  let idx = 0, hls = null, playing = false, retry = null;
  const audio = new Audio(); audio.crossOrigin = 'anonymous'; audio.preload = 'none';
  const nameEl = $('radio-name'), freqEl = $('radio-freq'), statEl = $('radio-status'), btn = $('radio-play');
  const vol = $('radio-vol');
  audio.volume = +(vol ? vol.value : 0.8);
  const label = () => { nameEl.textContent = st[idx].name; freqEl.textContent = st[idx].freq + ' MHz'; };
  const status = (t) => { statEl.textContent = t; };
  const setPlaying = (v) => { playing = v; btn.textContent = v ? '❚❚' : '▶'; $('radio').classList.toggle('on', v); };
  function stop() { clearTimeout(retry); if (hls) { hls.destroy(); hls = null; } audio.pause(); audio.removeAttribute('src'); audio.load(); setPlaying(false); status('已暫停'); }
  function play() {
    clearTimeout(retry);
    const url = R.base + st[idx].code + '/playlist.m3u8';
    status('連線中…'); setPlaying(true);
    if (hls) { hls.destroy(); hls = null; }
    const start = () => audio.play().then(() => status('播放中')).catch(() => { status('點擊收聽'); setPlaying(false); });
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: false });
      hls.on(window.Hls.Events.MANIFEST_PARSED, start);
      hls.on(window.Hls.Events.ERROR, (e, d) => {
        if (!d.fatal) return;
        status('連線失敗，3 秒後重試');
        retry = setTimeout(() => { if (playing) play(); }, 3000);
      });
      hls.loadSource(url); hls.attachMedia(audio);
    } else if (audio.canPlayType('application/vnd.apple.mpegurl')) { audio.src = url; start(); }
    else status('瀏覽器不支援 HLS');
  }
  function toggle() { playing ? stop() : play(); }
  function sw(d) { idx = (idx + d + st.length) % st.length; label(); if (playing) play(); else status('按 F 或 ▶ 收聽'); }
  label(); status('按 F 或 ▶ 收聽');
  btn.addEventListener('click', toggle);
  $('radio-prev').addEventListener('click', () => sw(-1));
  $('radio-next').addEventListener('click', () => sw(1));
  if (vol) vol.addEventListener('input', () => { audio.volume = +vol.value; });
  return { toggle, sw };
})();

// ======================================================================= 引擎音效 (Web Audio 即時合成)
const sound = (() => {
  let ac = null, nodes = null, enabled = true, gear = 1, lastV = 0, shiftDip = 0;
  const RATIOS = [0, 3.6, 2.2, 1.5, 1.15, 0.92, 0.75], FINAL = 3.9, WHEEL_R = 0.33;
  function noiseBuffer() {
    const b = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5 + w * 0.15; }
    return b;
  }
  function init() {
    if (ac) return;
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const master = ac.createGain(); master.gain.value = 0.55; master.connect(ac.destination);
    const comp = ac.createDynamicsCompressor(); comp.connect(master);
    // 引擎: 點火頻率鋸齒波 + 半頻方波 + 二倍頻，經過失真與低通
    const o1 = ac.createOscillator(); o1.type = 'sawtooth';
    const o2 = ac.createOscillator(); o2.type = 'square';
    const o3 = ac.createOscillator(); o3.type = 'sine';
    const g1 = ac.createGain(); g1.gain.value = 0.5; const g2 = ac.createGain(); g2.gain.value = 0.32; const g3 = ac.createGain(); g3.gain.value = 0.25;
    const shaper = ac.createWaveShaper();
    const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
    const eng = ac.createGain(); eng.gain.value = 0;
    o1.connect(g1); o2.connect(g2); o3.connect(g3); g1.connect(shaper); g2.connect(shaper); g3.connect(shaper); shaper.connect(lp); lp.connect(eng); eng.connect(comp);
    // 進氣 / 排氣嘶聲
    const nb = noiseBuffer();
    const mkNoise = () => { const s = ac.createBufferSource(); s.buffer = nb; s.loop = true; s.start(); return s; };
    const intake = ac.createBiquadFilter(); intake.type = 'bandpass'; intake.Q.value = 1.2;
    const intakeG = ac.createGain(); intakeG.gain.value = 0;
    mkNoise().connect(intake); intake.connect(intakeG); intakeG.connect(comp);
    // 風切 + 胎噪
    const wind = ac.createBiquadFilter(); wind.type = 'lowpass'; wind.frequency.value = 650;
    const windG = ac.createGain(); windG.gain.value = 0;
    mkNoise().connect(wind); wind.connect(windG); windG.connect(comp);
    // 輪胎尖叫
    const sq = ac.createBiquadFilter(); sq.type = 'bandpass'; sq.frequency.value = 1900; sq.Q.value = 9;
    const sqG = ac.createGain(); sqG.gain.value = 0;
    mkNoise().connect(sq); sq.connect(sqG); sqG.connect(comp);
    [o1, o2, o3].forEach((o) => o.start());
    nodes = { o1, o2, o3, lp, eng, intake, intakeG, windG, sqG, master, nb, comp };
  }
  function update(dt) {
    if (!ac || !nodes) return;
    const v = Math.abs(S.v), t = ac.currentTime;
    const acc = (S.v - lastV) / Math.max(dt, 1e-3); lastV = S.v;
    const thr = Math.max(S.thr || 0, Math.min(1, Math.max(0, acc / 3.5)));
    // 自動變速
    const rpmOf = (g) => v / (2 * Math.PI * WHEEL_R) * 60 * RATIOS[g] * FINAL;
    let rpm = rpmOf(gear);
    const up = 3000 + thr * 3200;
    if (rpm > up && gear < 6) { gear++; shiftDip = 0.12; }
    else if (gear > 1 && rpmOf(gear - 1) < up * 0.62) { gear--; shiftDip = 0.08; }
    rpm = Math.max(800 + thr * 400, rpmOf(gear));
    shiftDip = Math.max(0, shiftDip - dt);
    const fire = rpm / 60 * 2; // 四缸四行程
    nodes.o1.frequency.setTargetAtTime(fire, t, 0.03);
    nodes.o2.frequency.setTargetAtTime(fire / 2, t, 0.03);
    nodes.o3.frequency.setTargetAtTime(fire * 2, t, 0.03);
    nodes.lp.frequency.setTargetAtTime(260 + thr * 2200 + rpm * 0.35, t, 0.05);
    const eg = enabled ? (0.10 + thr * 0.32) * (shiftDip > 0 ? 0.35 : 1) : 0;
    nodes.eng.gain.setTargetAtTime(eg, t, shiftDip > 0 ? 0.01 : 0.06);
    nodes.intake.frequency.setTargetAtTime(500 + rpm * 0.5, t, 0.05);
    nodes.intakeG.gain.setTargetAtTime(enabled ? thr * 0.05 * (rpm / 6000) : 0, t, 0.08);
    nodes.windG.gain.setTargetAtTime(enabled ? Math.min(0.5, (v / 40) ** 2 * 0.22) : 0, t, 0.2);
    const latAcc = Math.abs(S.v * S.v * Math.tan(S.steer || 0) / 2.8);
    nodes.sqG.gain.setTargetAtTime(enabled && latAcc > 6.5 ? Math.min(0.25, (latAcc - 6.5) * 0.05) : 0, t, 0.05);
    if (gearEl) gearEl.textContent = (S.v < -0.3 ? 'R' : gear) + ' 檔 · ' + Math.round(rpm) + ' rpm';
  }
  function bump() {
    if (!ac || !enabled) return;
    const s = ac.createBufferSource(); s.buffer = nodes.nb;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    const g = ac.createGain(); const t = ac.currentTime;
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(f); f.connect(g); g.connect(nodes.comp); s.start(t); s.stop(t + 0.4);
  }
  let lastBlink = false;
  function blinker() {   // 方向燈滴答聲
    const on = S.signal ? (performance.now() % 666) < 333 : false;
    if (!ac || !enabled || on === lastBlink) { lastBlink = on; return; }
    lastBlink = on;
    if (!S.signal && !on) return;
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = 'square'; o.frequency.value = on ? 1700 : 1150;
    g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.035);
    o.connect(g); g.connect(nodes.comp); o.start(t); o.stop(t + 0.04);
  }
  function toggle() { enabled = !enabled; init(); }
  const gearEl = $('gear');
  const unlock = () => { init(); if (ac.state === 'suspended') ac.resume(); };
  window.addEventListener('keydown', unlock, { once: false });
  window.addEventListener('pointerdown', unlock, { once: false });
  return { update, bump, blinker, toggle, get on() { return enabled; } };
})();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') radio.toggle();
  if (e.code === 'KeyZ') radio.sw(-1);
  if (e.code === 'KeyX') radio.sw(1);
  if (e.code === 'KeyN') sound.toggle();
});

// ======================================================================= HUD: 目前路段路況
const trafficEl = $('traffic');
const DIR_NAME = { N: '北上', S: '南下', E: '東向', W: '西向' };
let hudClock = 0;
function updateTrafficHud(dt) {
  hudClock -= dt;
  if (hudClock > 0) return;
  hudClock = 0.3;
  const w = S.road && S.road.w;
  const t = w ? wayTraffic[w.k] : null, mp = w ? WAYMAP[w.k] : null;
  if (!t) { trafficEl.textContent = w && w.link ? '匝道 · 路況 ' + trafficSource : '路況 ' + trafficSource; trafficEl.style.borderColor = LV_COLOR[0]; return; }
  const lv = levelOf(t);
  trafficEl.innerHTML = `<b style="color:${LV_COLOR[lv]}">${t.speed > 0 ? t.speed + ' km/h · ' : ''}${LV_NAME[lv]}</b>　${DIR_NAME[mp[1]] || ''} ${t.from} → ${t.to}　<small>${trafficSource}</small>`;
  trafficEl.style.borderColor = LV_COLOR[lv];
}

// ======================================================================= 掛上主程式
TW.HOOKS.init.push(() => {
  initTraffic();
  for (const g of LIVE.etc) buildEtc(g);
  pollSpeed(); pollCms();
  if (TW.params.get('radio') === 'auto') radio.toggle(); // 測試用
});
TW.HOOKS.update.push((dt) => { updateTraffic(dt); });
TW.HOOKS.frame.push((dt) => { updateSigns(dt); sound.update(dt); sound.blinker(); updateTrafficHud(dt); });
// 除錯/測試: AI 車之間互相重疊的對數
function overlaps() {
  let n = 0;
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (!a.alive || !b.alive || Math.abs(a.z - b.z) > 2) continue;
    const dx = b.x - a.x, dy = b.y - a.y, fx = Math.cos(a.h), fy = Math.sin(a.h);
    if (Math.abs(dx * fx + dy * fy) < (a.len + b.len) / 2 - 0.3 && Math.abs(-dx * fy + dy * fx) < 1.7) n++;
  }
  return n;
}
window.TWX = { cars, signs, wayTraffic, radio, sound, stats, overlaps };
})();
