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
// 即時資料來源 (依序嘗試): 本機伺服器 scripts/phone_location.py -> Smart-Nav-Map 後端 -> 打包時的快照
const LOCAL = (TW.params.get('gps') || 'http://127.0.0.1:8765').replace(/\/$/, '');
const SOURCES = [[LOCAL, '本機'], [API, '後端']];
async function fetchLive(path) {
  for (const [base, label] of SOURCES) {
    try {
      const j = await fetchJson(base + path, 6000);
      if (j && j.ok && j.data && Array.isArray(j.data.items)) return [j, label];
    } catch (e) { /* 換下一個來源 */ }
  }
  return [null, ''];
}
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
  let wait = 30000;
  try {
    const [j, src] = await fetchLive('/freeway-speed');
    if (j && j.ok && j.data && Array.isArray(j.data.items)) {
      SECTIONS = j.data.items.filter((x) => ROADS.has(x.road));
      trafficSource = '即時 ' + fmtTime(j.data.updateTime) + '（' + src + '）';
      recomputeTraffic();
      for (const c of cars) if (c.alive) c.v0 = desiredSpeed(c);
      wait = Math.min(30000, (j.data.nextUpdateIn || 30000) + Math.random() * 1500);   // 國道路況時時更新: 最多 30 秒抓一次
    }
  } catch (e) { /* 連不到後端: 沿用快照 */ }
  setTimeout(pollSpeed, wait);
}

// ======================================================================= 共用: 合併幾何
function sliceGeo(g, start, count) {
  const out = new T.BufferGeometry();
  for (const [name, n] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const a = g.getAttribute(name);
    if (a) out.setAttribute(name, new T.Float32BufferAttribute(a.array.slice(start * n, (start + count) * n), n));
  }
  return out;
}
function mergeGeos(list) {
  let n = 0;
  for (const g of list) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    pos.set(g.getAttribute('position').array, o * 3);
    const na = g.getAttribute('normal'), ua = g.getAttribute('uv');
    if (na) nor.set(na.array, o * 3);
    if (ua) uv.set(ua.array, o * 2);
    o += g.getAttribute('position').count;
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.BufferAttribute(nor, 3));
  out.setAttribute('uv', new T.BufferAttribute(uv, 2));   // LED 看板等貼圖需要
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

// ======================================================================= AI 車流 (多車種、國道 + 一般道路)
const TV = window.TWV.TYPES;
const MAX_FWY = Math.max(0, Math.min(200, +(TW.params.get('cars') || (TW.MOBILE ? 45 : 90))));
const MAX_CITY = Math.max(0, Math.min(200, +(TW.params.get('citycars') || (TW.MOBILE ? 35 : 75))));
const COLORS = [ // 線性色彩；權重
  [[0.80, 0.80, 0.78], 24], [[0.45, 0.46, 0.48], 18], [[0.012, 0.012, 0.014], 14], [[0.09, 0.095, 0.10], 10],
  [[0.50, 0.02, 0.02], 7], [[0.03, 0.08, 0.36], 7], [[0.04, 0.17, 0.07], 4], [[0.48, 0.40, 0.28], 5], [[0.65, 0.66, 0.70], 3],
];
const pickW = (list) => { let s = 0; for (const it of list) s += it[1]; let r = Math.random() * s; for (const it of list) if ((r -= it[1]) <= 0) return it[0]; return list[0][0]; };
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const BODY_TYPES = [[[1, 1, 1], 50], [[1.0, 1.16, 1.04], 30], [[0.88, 1.03, 0.99], 20]]; // 轎車 / 休旅 / 掀背
// 每種車可同時存在的數量 (InstancedMesh 容量)
const CAP = { sedan: 150, taxi: 30, police: 4, citybus: 12, coach: 14, minibus: 8, boxtruck: 22, bigtruck: 16, semi: 12, semiTrailer: 12, scooter: 45 };
// 出現比例
const MIX_FWY = [['sedan', 60], ['taxi', 4], ['police', 1], ['coach', 7], ['boxtruck', 10], ['bigtruck', 9], ['semi', 9]];
const MIX_CITY = [['sedan', 40], ['taxi', 12], ['scooter', 28], ['citybus', 6], ['minibus', 4], ['boxtruck', 6], ['police', 0.5]];
const PAINTS = { citybus: [[0.8, 0.8, 0.78]], coach: [[0.8, 0.8, 0.78], [0.04, 0.05, 0.09], [0.8, 0.8, 0.78]], minibus: [[0.8, 0.8, 0.78]],
  police: [[0.85, 0.85, 0.83]], taxi: [[0.8, 0.52, 0.02]] };
const ACCENTS = {
  citybus: [[0.6, 0.02, 0.02], [0.03, 0.25, 0.08], [0.02, 0.12, 0.45], [0.8, 0.45, 0.02]],
  coach: [[0.02, 0.12, 0.45], [0.6, 0.02, 0.02], [0.8, 0.35, 0.02], [0.03, 0.25, 0.08], [0.45, 0.02, 0.3]],
  minibus: [[0.03, 0.25, 0.08], [0.6, 0.05, 0.02]],
  boxtruck: [[0.75, 0.75, 0.73], [0.55, 0.56, 0.58], [0.8, 0.8, 0.78], [0.6, 0.45, 0.05]],
  bigtruck: [[0.03, 0.12, 0.35], [0.25, 0.28, 0.2], [0.6, 0.55, 0.4], [0.5, 0.05, 0.03]],
  semi: [[0.55, 0.1, 0.05], [0.05, 0.2, 0.45], [0.15, 0.35, 0.15], [0.7, 0.5, 0.1], [0.6, 0.6, 0.62], [0.05, 0.4, 0.45]],
  scooter: [[0.05, 0.06, 0.15], [0.4, 0.02, 0.02], [0.1, 0.1, 0.1], [0.45, 0.45, 0.42], [0.03, 0.2, 0.1], [0.5, 0.3, 0.02]],
};
const BIG = new Set(['citybus', 'coach', 'minibus', 'boxtruck', 'bigtruck', 'semi']);
const HEAVY = new Set(['bigtruck', 'semi']);   // 國道限行外側兩車道

const cars = [];
let INST = null;
function buildInstances() {
  INST = {};
  for (const [name, cap] of Object.entries(CAP)) {
    const r = window.TWV.build(name), ud = r.ud;
    const kindOf = new Map([[ud.paint, 'paint'], [ud.accent, 'accent'], [ud.tailMat, 'tail'], [ud.sigLMat, 'sigL'], [ud.sigRMat, 'sigR'], [ud.flashA, 'flashA'], [ud.flashB, 'flashB']]);
    const conv = (m) => {
      const k = kindOf.get(m);
      if (k === 'paint' || k === 'accent') { const c = m.clone(); c.color.setRGB(1, 1, 1); c.userData.kind = k; return c; }
      if (k) { const c = new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }); c.userData.kind = k; return c; }
      if (m === ud.headMat) return new T.MeshBasicMaterial({ color: new T.Color(1.6, 1.55, 1.4) });
      return m.clone();
    };
    const meshes = bakeByMaterial(r.group, r.group).map(([m, g]) => {
      const im = new T.InstancedMesh(g, conv(m), cap);
      im.instanceMatrix.setUsage(T.DynamicDrawUsage);
      im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true; im.count = 0;
      if (im.material.userData.kind) for (let i = 0; i < cap; i++) im.setColorAt(i, new T.Color(1, 1, 1));
      TW.scene.add(im);
      return im;
    });
    INST[name] = { meshes, n: 0, cap };
  }
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
const wayLen = (w) => w.s[w.n - 1];
/** 車道中心 (相對路線左法向)；機車靠行進方向右側路邊 */
function laneLatC(c, lane) {
  if (c.type === 'scooter' && c.w.city) {
    const e = c.w.oneway ? c.w.width / 2 - 1.0 : c.w.width / 2 - 1.05;
    return c.w.oneway ? -e : (c.dir > 0 ? -e : e);
  }
  return TW.laneOffDir(c.w, lane, c.dir);
}
const laneOK = (c, lane) => lane >= 0 && lane < TW.laneCount(c.w) && !(HEAVY.has(c.type) && !c.w.city && lane < TW.laneCount(c.w) - 2);
const distToEnd = (c) => c.dir > 0 ? wayLen(c.w) - c.s : c.s;

function desiredSpeed(c) {
  const w = c.w;
  let lim = TW.speedLimit(w) / 3.6;
  if (!w.city) { const t = wayTraffic[w.k]; if (t && t.speed > 0) lim = t.speed / 3.6; }
  let v = Math.min(lim * c.pers * c.mood, c.T.vmax * (HEAVY.has(c.type) ? 0.92 : 1));
  if (c.plan && c.plan.vturn < 50) {   // 路口轉彎前減速
    const d = Math.max(0, distToEnd(c) - 4);
    v = Math.min(v, Math.sqrt(c.plan.vturn * c.plan.vturn + 2 * 1.6 * d));
  }
  return Math.max(2, v);
}
function densityWeight(w) {
  if (w.city) return w.cls === 5 ? 0.5 : (w.cls === 2 ? 3 : w.cls === 3 ? 2.4 : 1.6);
  return [1, 1, 1.8, 2.6, 3.6, 4.5][levelOf(wayTraffic[w.k])];
}

/** 下一段路: 國道走主線；一般道路在路口隨機轉彎 (直行機率較高)，不會迴轉 */
function choosePlan(c) {
  const w = c.w, node = c.dir > 0 ? w.n - 1 : 0;
  const hx = c.dir > 0 ? w.ny[node] : -w.ny[node], hy = c.dir > 0 ? -w.nx[node] : w.nx[node];
  const opts = TW.nextOptions(w, node).filter((o) => (c.pool === 'city') === !!o.o.city && !(c.pool === 'city' && BIG.has(c.type) && o.o.cls === 5));
  let best = null;
  if (c.pool === 'fwy') {
    let bs = -1e9;
    for (const o of opts) {
      const dot = hx * o.hx + hy * o.hy;
      if (dot < 0.5) continue;
      const sc = dot + (o.o.ref === w.ref && o.o.ref ? 2 : 0) + (o.o.link ? -3 : 0) + (w.link && !o.o.link ? 3 : 0);
      if (sc > bs) { bs = sc; best = o; }
    }
  } else {
    const cand = [];
    for (const o of opts) {
      const dot = hx * o.hx + hy * o.hy;
      if (dot < -0.2) continue;
      cand.push([o, (dot > 0.9 ? 3 : 1) * (o.o.cls === 5 ? 0.35 : o.o.cls <= 3 ? 1.6 : 1)]);
    }
    if (cand.length) best = pickW(cand);
  }
  if (!best) return null;
  const dot = hx * best.hx + hy * best.hy, cross = hx * best.hy - hy * best.hx;
  return { ...best, vturn: dot > 0.94 ? 99 : dot > 0.5 ? 9 : 6, turn: dot > 0.94 ? 0 : (cross > 0 ? -1 : 1) };
}

// 生成點
const SAMPLES_FWY = [], SAMPLES_CITY = [];
for (const w of WAYS) {
  if (w.n < 2 || wayLen(w) < 20) continue;
  if (w.city) { if (w.cls <= 5) for (let s = 8; s < wayLen(w) - 5; s += w.cls === 5 ? 60 : 30) { poseAt(w, s, 0); SAMPLES_CITY.push([w.k, s, POSE.x, POSE.y]); } }
  else if (!w.link) for (let s = 10; s < wayLen(w) - 5; s += 40) { poseAt(w, s, 0); SAMPLES_FWY.push([w.k, s, POSE.x, POSE.y]); }
}
const typeCount = {};
let nextId = 1;

function trySpawn(c, pool, minR, maxR) {
  const SAMP = pool === 'city' ? SAMPLES_CITY : SAMPLES_FWY;
  const cand = [];
  for (const sm of SAMP) {
    const d2 = (sm[2] - S.x) ** 2 + (sm[3] - S.y) ** 2;
    if (d2 > minR * minR && d2 < maxR * maxR) cand.push(sm);
  }
  if (!cand.length) return false;
  for (let attempt = 0; attempt < 16; attempt++) {
    const sm = cand[(Math.random() * cand.length) | 0];
    const w = WAYS[sm[0]];
    if (Math.random() > densityWeight(w) / 4.5) continue;
    let type = pickW(pool === 'city' ? MIX_CITY : MIX_FWY);
    if ((typeCount[type] || 0) >= CAP[type] || (type === 'semi' && (typeCount.semiTrailer || 0) >= CAP.semiTrailer)) type = 'sedan';
    if ((typeCount[type] || 0) >= CAP[type]) return false;
    if (BIG.has(type) && w.city && w.cls === 5) type = 'sedan';
    const dir = (w.city && !w.oneway && Math.random() < 0.5) ? -1 : 1;
    const tc = { w, dir, type };
    const lc = TW.laneCount(w);
    let lane = (Math.random() * lc) | 0;
    if (HEAVY.has(type) && !w.city) lane = Math.max(lane, lc - 2, 0);
    const lat = laneLatC(tc, lane);
    poseAt(w, sm[1], lat);
    let ok = Math.hypot(POSE.x - S.x, POSE.y - S.y) > Math.min(minR, 40);
    const gapNeed = pool === 'city' ? 14 : 28;
    for (const o of cars) if (ok && o.alive && o !== c && (o.x - POSE.x) ** 2 + (o.y - POSE.y) ** 2 < gapNeed * gapNeed && Math.abs(o.z - POSE.z) < 3) ok = false;
    if (!ok) continue;
    const TT = TV[type];
    const scale = type === 'sedan' ? pickW(BODY_TYPES) : [1, 1, 1];
    Object.assign(c, {
      id: nextId++, alive: true, pool, type, T: TT, w, s: sm[1], dir, lane, lat, prevLat: lat, pers: rand(0.88, 1.1), mood: 1, moodT: 1, moodTimer: rand(10, 40),
      color: pick(PAINTS[type] || COLORS.map((x) => x[0])), accent: pick(ACCENTS[type] || [[0.6, 0.6, 0.6]]),
      sx: scale[0], sy: scale[1], sz: scale[2], front: TT.front * scale[0], rear: TT.rear * scale[0], wid: TT.wid * scale[2],
      lcCool: rand(2, 8), brake: false, deadEnd: false, pending: null, signal: 0, sigT: 0, plan: null, roll: 0, trail: [],
      x: POSE.x, y: POSE.y, z: POSE.z, h: Math.atan2(POSE.ty, POSE.tx) + (dir < 0 ? Math.PI : 0), pitch: 0,
    });
    if (TT.trailer) for (let k = 0; k <= 30; k++) c.trail.push([POSE.x - Math.cos(c.h) * k * 0.5, POSE.y - Math.sin(c.h) * k * 0.5, POSE.z]);
    typeCount[type] = (typeCount[type] || 0) + 1;
    if (TT.trailer) typeCount.semiTrailer = (typeCount.semiTrailer || 0) + 1;
    c.v0 = desiredSpeed(c); c.v = c.v0 * rand(0.7, 1);
    return true;
  }
  return false;
}
function kill(c) {
  if (!c.alive) return;
  c.alive = false;
  typeCount[c.type]--;
  if (c.T.trailer) typeCount.semiTrailer--;
}

function initTraffic() {
  buildInstances();
  for (let i = 0; i < MAX_FWY; i++) { const c = { alive: false, pool: 'fwy' }; cars.push(c); trySpawn(c, 'fwy', 60, 1500); }
  for (let i = 0; i < MAX_CITY; i++) { const c = { alive: false, pool: 'city' }; cars.push(c); trySpawn(c, 'city', 40, 550); }
}

// 玩家也算一台車 (給 AI 跟車、換道、路口讓車判斷用)
const PLAYER = { isPlayer: true, id: 0 };
function syncPlayer() {
  const vt = S.vt || TV.sedan;
  PLAYER.x = S.x; PLAYER.y = S.y; PLAYER.z = S.z; PLAYER.h = S.h; PLAYER.v = S.v;
  PLAYER.front = vt.front; PLAYER.rear = vt.rear; PLAYER.wid = vt.wid;
  PLAYER.changing = !!S.signal; PLAYER.w = S.road && S.road.w;
  return PLAYER;
}
const isChanging = (o) => o.isPlayer ? o.changing : (o.pending != null || Math.abs(o.lat - laneLatC(o, o.lane)) > 0.3);
function eachOther(me, fn) {
  for (const o of cars) if (o !== me && o.alive) fn(o);
  if (me !== PLAYER) fn(syncPlayer());
}
/** 前車: shift = 目標車道相對目前位置的橫向位移 (行進方向左正)；一般道路另外檢查路口橫向來車 */
function leaderFor(me, shift) {
  const fx = Math.cos(me.h), fy = Math.sin(me.h);
  const lo = Math.min(0, shift), hi = Math.max(0, shift);
  const inCity = me.w && me.w.city;
  let gap = 1e9, vl = 40;
  eachOther(me, (o) => {
    if (Math.abs(o.z - me.z) > 3) return;
    const dx = o.x - me.x, dy = o.y - me.y;
    if (dx * dx + dy * dy > 40000) return;
    const d = dx * fx + dy * fy, lat = -dx * fy + dy * fx, cs = Math.cos(o.h - me.h);
    const oCity = o.isPlayer ? !!(o.w && o.w.city) : o.pool === 'city', meCity = me.isPlayer ? !!(me.w && me.w.city) : me.pool === 'city';
    if (oCity !== meCity && Math.abs(cs) < 0.7) return;   // 不同路網的交叉 (上下穿越) 互不影響
    if (cs >= 0.3) {
      if (d <= 0 || d > 160) return;
      const hw = (me.wid + o.wid) / 2 + 0.05;
      if (lat < lo - hw || lat > hi + hw) return;
      const g = d - me.front - o.rear;
      if (g < gap) { gap = g; vl = Math.max(0, o.v * cs); }
    } else if (inCity && Math.abs(cs) < 0.75 && d > 1 && d < 22 && Math.abs(lat) < 7) {
      // 路口: 橫向來車在前方，對方在動 (或編號較小) 就讓
      if (o.v > 1.5 || o.id < me.id) { const g = d - me.front - 2; if (g < gap) { gap = g; vl = 0; } }
    }
  });
  return { gap, v: vl };
}
/** 目標車道安全嗎: 前後留距離；附近有車要切進同一車道也先不切 */
function laneSafeFor(me, shift) {
  const fx = Math.cos(me.h), fy = Math.sin(me.h);
  let safe = true;
  eachOther(me, (o) => {
    if (!safe || Math.abs(o.z - me.z) > 3 || Math.cos(o.h - me.h) < 0.3) return;
    const dx = o.x - me.x, dy = o.y - me.y, d = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
    const hw = (me.wid + o.wid) / 2 + 0.25;
    if (Math.abs(lat - shift) < hw && d > -(o.front + me.rear + 8 + Math.max(0, o.v - me.v) * 2.8) && d < me.front + o.rear + 10 + Math.max(0, me.v - o.v) * 2.2) { safe = false; return; }
    if (Math.abs(d) >= 34 || !isChanging(o)) return;
    if (o.isPlayer) { if (Math.abs(lat - shift) < 5.8) safe = false; return; }
    const tl = o.dir * (laneLatC(o, o.pending != null ? o.pending : o.lane) - o.lat);
    if (Math.abs(lat + tl - shift) < hw + 0.2) safe = false;
  });
  return safe;
}
TW.HOOKS.leader = (shift) => leaderFor(syncPlayer(), shift);
TW.HOOKS.laneFree = (shift) => laneSafeFor(syncPlayer(), shift);

const stats = { bumps: 0, laneChanges: 0, turns: 0, nan: 0 };
function stepCar(c, dt) {
  const w = c.w, lc = TW.laneCount(w);
  if (c.lane >= lc) c.lane = lc - 1;
  const shift = c.dir * (laneLatC(c, c.lane) - c.lat);
  const ld = leaderFor(c, c.pending != null ? c.dir * (laneLatC(c, c.pending) - c.lat) : shift);
  const gap = ld.gap, vl = ld.gap < 1e8 ? ld.v : c.v0;
  // 個性: 偶爾想快一點或慢一點
  c.moodTimer -= dt;
  if (c.moodTimer <= 0) { c.moodT = rand(0.88, 1.12); c.moodTimer = rand(15, 50); }
  c.mood += (c.moodT - c.mood) * Math.min(1, dt * 0.3);
  if (!c.plan && distToEnd(c) < 55) c.plan = choosePlan(c) || { none: true, vturn: 3 };
  c.v0 = desiredSpeed(c);
  // IDM 跟車
  const A = c.T.acc, Bd = BIG.has(c.type) ? 1.8 : 2.3, S0 = c.type === 'scooter' ? 1.2 : 2.5, TH = BIG.has(c.type) ? 1.6 : 1.3;
  let a = A * (1 - Math.pow(c.v / c.v0, 4));
  if (gap < 1e8) {
    const ss = S0 + Math.max(0, c.v * TH + c.v * (c.v - vl) / (2 * Math.sqrt(A * Bd)));
    a -= A * (ss / Math.max(gap, 0.1)) ** 2;
  }
  a = Math.max(-9, Math.min(A, a));
  c.v = Math.max(0, c.v + a * dt);
  if (gap < 0.6) c.v = Math.min(c.v, vl * 0.9);
  let ds = c.v * dt;
  if (gap < 1e8) ds = Math.min(ds, Math.max(0, gap - 0.4));
  c.brake = a < -0.9 || (c.v < 0.8 && gap < 25);
  // 換車道: 先打方向燈 1.2 秒，再確認一次安全才切
  c.lcCool -= dt;
  if (c.pending != null) {
    c.sigT -= dt;
    if (c.sigT <= 0) {
      if (laneOK(c, c.pending) && laneSafeFor(c, c.dir * (laneLatC(c, c.pending) - c.lat))) { c.lane = c.pending; stats.laneChanges++; }
      else c.signal = 0;
      c.pending = null;
    }
  } else if (c.lcCool <= 0 && Math.abs(shift) < 0.3 && lc > 1 && !w.link && c.type !== 'scooter' && distToEnd(c) > 40) {
    const blocked = gap < 50 && vl < c.v0 - 2.5;
    const keepRight = BIG.has(c.type) ? 0.25 : 0.08;
    const tries = blocked ? [c.lane - 1, c.lane + 1] : (gap > 90 && Math.random() < dt * keepRight ? [c.lane + 1] : []);
    for (const ln of tries) {
      if (!laneOK(c, ln)) continue;
      if (laneSafeFor(c, c.dir * (laneLatC(c, ln) - c.lat))) { c.pending = ln; c.sigT = 1.2; c.signal = ln < c.lane ? -1 : 1; c.lcCool = rand(6, 14); break; }
    }
    if (tries.length && c.lcCool <= 0) c.lcCool = 1.5;
  }
  // 路口轉彎打方向燈
  if (c.pending == null && c.plan && c.plan.turn && distToEnd(c) < 35) c.signal = c.plan.turn;
  else if (c.pending == null && c.signal && Math.abs(laneLatC(c, c.lane) - c.lat) < 0.3 && !(c.plan && c.plan.turn)) c.signal = 0;
  // 前進 (跨路段 / 路口)
  c.s += c.dir * ds;
  let guard = 0;
  while ((c.dir > 0 ? c.s > wayLen(c.w) : c.s < 0) && guard++ < 8) {
    const over = c.dir > 0 ? c.s - wayLen(c.w) : -c.s;
    const plan = c.plan && !c.plan.none ? c.plan : choosePlan(c);
    if (!plan) {
      if (c.w.city && !c.w.oneway) { c.dir = -c.dir; c.s = c.dir > 0 ? over : wayLen(c.w) - over; c.plan = null; c.signal = 0; break; }   // 死巷迴轉
      c.s = c.dir > 0 ? wayLen(c.w) : 0; c.v = 0; c.deadEnd = true; break;
    }
    const wasLink = c.w.link;
    c.w = plan.o; c.dir = plan.dir;
    c.s = plan.o.s[plan.i] + c.dir * over;
    const nl = TW.laneCount(c.w);
    if (c.lane >= nl) c.lane = nl - 1;
    if (wasLink && !c.w.link) c.lane = nl - 1;
    if (plan.turn) { stats.turns++; c.lane = plan.turn > 0 ? nl - 1 : 0; }
    if (HEAVY.has(c.type) && !c.w.city) c.lane = Math.max(c.lane, nl - 2, 0);
    c.plan = null; c.signal = 0; c.pending = null;
  }
  // 橫向 (平滑換道 / 轉彎後回到車道)
  const tgt = laneLatC(c, c.lane);
  c.prevLat = c.lat;
  const rate = c.type === 'scooter' ? 0.9 : 1.15;
  c.lat += Math.max(-rate * dt, Math.min(rate * dt, tgt - c.lat));
  poseAt(c.w, c.s, c.lat);
  c.x = POSE.x; c.y = POSE.y; c.z = POSE.z;
  const latVel = (c.lat - c.prevLat) / Math.max(dt, 1e-3);
  const h0 = c.h;
  c.h = Math.atan2(POSE.ty, POSE.tx) + (c.dir < 0 ? Math.PI : 0) + Math.atan2(c.dir * latVel, Math.max(c.v, 3));
  const z1 = poseAt(c.w, c.s + c.dir * 1.4, c.lat, {}).z, z0 = poseAt(c.w, c.s - c.dir * 1.4, c.lat, {}).z;
  c.pitch = Math.atan2(z1 - z0, 2.8);
  if (c.T.lean) {   // 機車轉彎壓車
    const yr = Math.atan2(Math.sin(c.h - h0), Math.cos(c.h - h0)) / Math.max(dt, 1e-3);
    const tgtRoll = Math.max(-0.5, Math.min(0.5, Math.atan(c.v * yr / 9.81)));
    c.roll += (tgtRoll - c.roll) * Math.min(1, dt * 4);
  }
  if (c.T.trailer) {   // 聯結車拖車沿著曳引車走過的軌跡
    const tr = c.trail, last = tr[0];
    if (!last || (last[0] - c.x) ** 2 + (last[1] - c.y) ** 2 > 0.25) { tr.unshift([c.x, c.y, c.z]); if (tr.length > 60) tr.pop(); }
  }
}
/** 沿軌跡往回 dist 公尺的點 */
function trailPoint(tr, x, y, dist) {
  let px = x, py = y, pz = tr.length ? tr[0][2] : 0;
  for (const p of tr) {
    const d = Math.hypot(p[0] - px, p[1] - py);
    if (d >= dist) { const t = dist / (d || 1); return [px + (p[0] - px) * t, py + (p[1] - py) * t, pz + (p[2] - pz) * t]; }
    dist -= d; px = p[0]; py = p[1]; pz = p[2];
  }
  return [px, py, pz];
}

let bumpCooldown = 0;
function collidePlayer(dt) {
  bumpCooldown -= dt;
  const pl = syncPlayer();
  const fx = Math.cos(S.h), fy = Math.sin(S.h);
  const pOff = (pl.front - pl.rear) / 2, pHalf = (pl.front + pl.rear) / 2;
  const pcx = S.x + fx * pOff, pcy = S.y + fy * pOff;
  for (const c of cars) {
    if (!c.alive || Math.abs(c.z - S.z) > 2) continue;
    // 國道車與市區車垂直交會 (不同路網的立體交叉) 不算碰撞
    if (S.road && (c.pool === 'city') !== !!S.road.w.city && Math.abs(Math.cos(c.h - S.h)) < 0.7) continue;
    const cOff = (c.front - c.rear) / 2, cHalf = (c.front + c.rear) / 2;
    const ccx = c.x + Math.cos(c.h) * cOff, ccy = c.y + Math.sin(c.h) * cOff;
    const dx = ccx - pcx, dy = ccy - pcy;
    const lim = pHalf + cHalf + 2;
    if (dx * dx + dy * dy > lim * lim) continue;
    const ax = dx * fx + dy * fy, ay = -dx * fy + dy * fx;
    const hl = pHalf + cHalf * Math.abs(Math.cos(c.h - S.h)) + c.wid / 2 * Math.abs(Math.sin(c.h - S.h)) - 0.15;
    const hw = pl.wid / 2 + c.wid / 2 * Math.abs(Math.cos(c.h - S.h)) + cHalf * Math.abs(Math.sin(c.h - S.h)) - 0.05;
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
    if (TW.roadAt(nx, ny, S.z, 0.5)) { S.x = nx; S.y = ny; }
    if (bumpCooldown <= 0) { bumpCooldown = 0.6; stats.bumps++; sound.bump(); }
  }
}

const _m = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler(), _p = new T.Vector3(), _s = new T.Vector3(), _col = new T.Color();
const TAIL_ON = new T.Color(1, 0.02, 0.01), TAIL_OFF = new T.Color(0.45, 0.004, 0.004);
const SIG_ON = new T.Color(1.0, 0.42, 0.0), SIG_OFF = new T.Color(0.18, 0.07, 0.0);
const FL_R = new T.Color(1, 0.02, 0.02), FL_B = new T.Color(0.05, 0.15, 1), FL_OFF = new T.Color(0.05, 0.02, 0.02);
let respawnClock = 0;
function drawInstance(name, c, x, y, z, h, pitch, roll, sx, sy, sz, blink, flash) {
  const ins = INST[name];
  if (!ins || ins.n >= ins.cap || !Number.isFinite(x + y + z + h + pitch + roll)) return;
  const i = ins.n++;
  _e.set(roll, h, pitch, 'YZX');
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, z, -y), _q, _s.set(sx, sy, sz));
  for (const im of ins.meshes) {
    im.setMatrixAt(i, _m);
    const kind = im.material.userData.kind;
    if (!kind) continue;
    if (kind === 'paint') im.setColorAt(i, _col.setRGB(c.color[0], c.color[1], c.color[2]));
    else if (kind === 'accent') im.setColorAt(i, _col.setRGB(c.accent[0], c.accent[1], c.accent[2]));
    else if (kind === 'tail') im.setColorAt(i, c.brake ? TAIL_ON : TAIL_OFF);
    else if (kind === 'sigL') im.setColorAt(i, c.signal === -1 && blink ? SIG_ON : SIG_OFF);
    else if (kind === 'sigR') im.setColorAt(i, c.signal === 1 && blink ? SIG_ON : SIG_OFF);
    else if (kind === 'flashA') im.setColorAt(i, flash ? FL_R : FL_OFF);
    else if (kind === 'flashB') im.setColorAt(i, flash ? FL_OFF : FL_B);
  }
}
function updateTraffic(dt) {
  if (!INST) return;
  const sub = dt > 1 / 45 ? 2 : 1;
  for (let k = 0; k < sub; k++) for (const c of cars) if (c.alive) {
    stepCar(c, dt / sub);
    if (!Number.isFinite(c.x + c.y + c.z + c.h + c.s + c.v)) { stats.nan++; kill(c); }   // 防護: 座標算壞就回收
  }
  collidePlayer(dt);
  // 回收: 國道 1.8 km、一般道路 650 m 外才回收並在遠處重新生成 (不會在眼前消失)
  respawnClock -= dt;
  if (respawnClock <= 0) {
    respawnClock = 0.25;
    let n = 0;
    for (const c of cars) {
      const d = c.alive ? Math.hypot(c.x - S.x, c.y - S.y) : 1e9;
      const far = c.pool === 'city' ? (d > 650 || (c.deadEnd && d > 250)) : (d > 1800 || (c.deadEnd && d > 700));
      if (far && n++ < 4) {
        kill(c);
        if (c.pool === 'city') trySpawn(c, 'city', 280, 550); else trySpawn(c, 'fwy', 750, 1500);
      }
    }
  }
  // 繪製
  const now = performance.now(), blink = (now % 666) < 333, flash = (now % 500) < 250;
  for (const k in INST) INST[k].n = 0;
  for (const c of cars) {
    if (!c.alive) continue;
    drawInstance(c.type, c, c.x, c.y, c.z, c.h, c.pitch, c.roll, c.sx, c.sy, c.sz, blink, flash);
    if (c.T.trailer) {
      const tr = c.T.trailer;
      const hx = c.x - Math.cos(c.h) * tr.hitch, hy = c.y - Math.sin(c.h) * tr.hitch;
      const tp = trailPoint(c.trail, hx, hy, tr.kingpin);
      const th = Math.atan2(hy - tp[1], hx - tp[0]);
      drawInstance('semiTrailer', c, tp[0], tp[1], tp[2], th, c.pitch, 0, 1, 1, 1, blink, flash);
    }
  }
  for (const k in INST) for (const im of INST[k].meshes) {
    im.count = INST[k].n; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
}
TW.HOOKS.minimap.push((ctx, s) => {
  for (const c of cars) {
    if (!c.alive) continue;
    ctx.beginPath(); ctx.arc(c.x - S.x, c.y - S.y, (c.type === 'scooter' ? 1.4 : BIG.has(c.type) ? 3.2 : 2.4) / s, 0, Math.PI * 2);
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
  let wait = 30000;
  try {
    const [j] = await fetchLive('/cms');
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
      wait = Math.min(30000, (j.data.nextUpdateIn || 30000) + Math.random() * 1500);
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
    const xc = -(TW.laneOffDir(w, ln, 1));  // 本地 +x 為右 = -左
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
    const master = ac.createGain(); master.gain.value = 0.45; master.connect(ac.destination);
    const comp = ac.createDynamicsCompressor(); comp.connect(master);
    // 引擎: 點火頻率正弦 + 半頻三角波 (低沉) + 少量二倍頻，輕微飽和後經柔和低通
    const o1 = ac.createOscillator(); o1.type = 'sine';
    const o2 = ac.createOscillator(); o2.type = 'triangle';
    const o3 = ac.createOscillator(); o3.type = 'sine';
    const g1 = ac.createGain(); g1.gain.value = 0.55; const g2 = ac.createGain(); g2.gain.value = 0.45; const g3 = ac.createGain(); g3.gain.value = 0.08;
    const shaper = ac.createWaveShaper();
    const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 1.2); }
    shaper.curve = curve;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    const eng = ac.createGain(); eng.gain.value = 0;
    o1.connect(g1); o2.connect(g2); o3.connect(g3); g1.connect(shaper); g2.connect(shaper); g3.connect(shaper); shaper.connect(lp); lp.connect(eng); eng.connect(comp);
    // 進氣 / 排氣嘶聲
    const nb = noiseBuffer();
    const mkNoise = () => { const s = ac.createBufferSource(); s.buffer = nb; s.loop = true; s.start(); return s; };
    const intake = ac.createBiquadFilter(); intake.type = 'bandpass'; intake.Q.value = 0.8;
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
    const up = 2600 + thr * 2400;
    if (rpm > up && gear < 6) { gear++; shiftDip = 0.12; }
    else if (gear > 1 && rpmOf(gear - 1) < up * 0.62) { gear--; shiftDip = 0.08; }
    rpm = Math.max(800 + thr * 400, rpmOf(gear));
    shiftDip = Math.max(0, shiftDip - dt);
    const fire = rpm / 60 * 2; // 四缸四行程
    nodes.o1.frequency.setTargetAtTime(fire, t, 0.03);
    nodes.o2.frequency.setTargetAtTime(fire / 2, t, 0.03);
    nodes.o3.frequency.setTargetAtTime(fire * 2, t, 0.03);
    nodes.lp.frequency.setTargetAtTime(180 + thr * 700 + rpm * 0.08, t, 0.08);
    const eg = enabled ? (0.07 + thr * 0.13) * (shiftDip > 0 ? 0.55 : 1) : 0;
    nodes.eng.gain.setTargetAtTime(eg, t, shiftDip > 0 ? 0.03 : 0.12);
    nodes.intake.frequency.setTargetAtTime(300 + rpm * 0.12, t, 0.08);
    nodes.intakeG.gain.setTargetAtTime(enabled ? thr * 0.015 * (rpm / 6000) : 0, t, 0.08);
    nodes.windG.gain.setTargetAtTime(enabled ? Math.min(0.5, (v / 40) ** 2 * 0.22) : 0, t, 0.2);
    const latAcc = Math.abs(S.v * S.v * Math.tan(S.steer || 0) / 2.8);
    nodes.sqG.gain.setTargetAtTime(enabled && latAcc > 6.5 ? Math.min(0.12, (latAcc - 6.5) * 0.03) : 0, t, 0.05);
    if (gearEl) gearEl.textContent = (S.v < -0.3 ? 'R' : gear) + ' 檔 · ' + Math.round(rpm) + ' rpm';
  }
  function knock(v, axle) {   // 伸縮縫「叩」: 低沉撞擊 + 金屬聲，車速越快越大聲
    if (!ac || !enabled) return;
    const t = ac.currentTime, k = Math.min(1, 0.25 + v / 28) * (axle ? 0.85 : 1);
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    og.gain.setValueAtTime(0.9 * k, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(og); og.connect(nodes.comp); o.start(t); o.stop(t + 0.14);
    const s = ac.createBufferSource(); s.buffer = nodes.nb;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 260; f.Q.value = 1.4;
    const g = ac.createGain(); g.gain.setValueAtTime(0.7 * k, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    s.connect(f); f.connect(g); g.connect(nodes.comp); s.start(t); s.stop(t + 0.08);
    const m = ac.createOscillator(), mg = ac.createGain();
    m.type = 'triangle'; m.frequency.value = 1350;
    mg.gain.setValueAtTime(0.05 * k, t); mg.gain.exponentialRampToValueAtTime(0.0005, t + 0.035);
    m.connect(mg); mg.connect(nodes.comp); m.start(t); m.stop(t + 0.05);
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
  return { update, bump, knock, blinker, toggle, get on() { return enabled; } };
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

// ======================================================================= 手機定位同步 (透過電腦上的 scripts/phone_location.py)
// 遊戲每秒把車子的經緯度送到橋接程式，橋接程式再透過 Wi-Fi 設成手機的「模擬定位」(Android adb / iPhone)。
const gpsSync = (() => {
  const url = (TW.params.get('gps') || 'http://127.0.0.1:8765').replace(/\/$/, '');
  const el = $('gps');
  let on = false, clock = 0, busy = false, status = '';
  // TWD97 TM2 (EPSG:3826) 正算，與 prep_freeway.py 相同公式
  const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F), EP2 = E2 / (1 - E2), K0 = 0.9999, LON0 = 121, FE = 250000;
  function tm2(lat, lon) {
    const phi = lat * Math.PI / 180, lam = (lon - LON0) * Math.PI / 180;
    const s = Math.sin(phi), c = Math.cos(phi), N = A / Math.sqrt(1 - E2 * s * s), Tn = Math.tan(phi) ** 2, C = EP2 * c * c, Aa = c * lam;
    const e4 = E2 * E2, e6 = e4 * E2;
    const M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
    const x = FE + K0 * N * (Aa + (1 - Tn + C) * Aa ** 3 / 6 + (5 - 18 * Tn + Tn * Tn + 72 * C - 58 * EP2) * Aa ** 5 / 120);
    const y = K0 * (M + N * Math.tan(phi) * (Aa * Aa / 2 + (5 - Tn + 9 * C + 4 * C * C) * Aa ** 4 / 24 + (61 - 58 * Tn + Tn * Tn + 600 * C - 330 * EP2) * Aa ** 6 / 720));
    return [x, y];
  }
  /** 遊戲座標 (公尺) -> 經緯度 (牛頓法反算) */
  function toLatLon(x, y) {
    const X = x + TW.ORIGIN[0], Y = y + TW.ORIGIN[1];
    let lat = 25.03, lon = 121.55;
    for (let k = 0; k < 6; k++) {
      const [fx, fy] = tm2(lat, lon), h = 1e-6;
      const [ax, ay] = tm2(lat + h, lon), [bx, by] = tm2(lat, lon + h);
      const j11 = (ax - fx) / h, j21 = (ay - fy) / h, j12 = (bx - fx) / h, j22 = (by - fy) / h;
      const rx = X - fx, ry = Y - fy, det = j11 * j22 - j12 * j21;
      lat += (j22 * rx - j12 * ry) / det; lon += (-j21 * rx + j11 * ry) / det;
    }
    return [lat, lon];
  }
  const show = () => { el.textContent = on ? '📱 ' + status : ''; };
  async function post(path, body) {
    const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }
  async function send() {
    if (busy) return;
    busy = true;
    const [lat, lon] = toLatLon(S.x, S.y);
    const course = ((90 - S.h * 180 / Math.PI) % 360 + 360) % 360;   // 正北 0°、順時針
    try {
      const j = await post('/loc', { lat, lon, speed: Math.max(0, S.v), course });
      status = j.ok ? `同步中 ${lat.toFixed(5)}, ${lon.toFixed(5)}${j.device ? '' : '（找不到手機）'}` : ('橋接程式錯誤: ' + (j.error || ''));
    } catch (e) {
      status = '連不到電腦上的橋接程式';
    }
    busy = false; show();
  }
  function toggle() {
    on = !on; clock = 0; status = on ? '連線中…' : '';
    if (!on) post('/clear').catch(() => {});
    show();
  }
  function frame(dt) { if (!on) return; clock -= dt; if (clock <= 0) { clock = 0.5; send(); } }   // 每秒 2 次，手機 App 才會判定「正在移動」並用行進方向
  const btn = $('menu-gps');
  if (btn) btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (e) => { if (e.code === 'KeyL') toggle(); });
  return { toggle, frame, toLatLon, get on() { return on; } };
})();

// ======================================================================= 手機觸控按鍵 (模擬鍵盤)
(() => {
  if (!TW.MOBILE) return;
  document.body.classList.add('touch');
  const pad = $('touch');
  if (!pad) return;
  pad.classList.remove('hidden');
  const send = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
  // 按住型: 方向、油門、煞車 (可多指同時按)
  for (const el of pad.querySelectorAll('[data-key]')) {
    const code = el.dataset.key;
    let held = false;
    const down = (e) => { e.preventDefault(); if (el.setPointerCapture) el.setPointerCapture(e.pointerId); held = true; el.classList.add('on'); send('keydown', code); };
    const up = (e) => { e.preventDefault(); if (!held) return; held = false; el.classList.remove('on'); send('keyup', code); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
  // 點一下型: 方向燈、視角、自動駕駛、換車、選單
  for (const el of pad.querySelectorAll('[data-tap]')) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); send('keydown', el.dataset.tap); setTimeout(() => send('keyup', el.dataset.tap), 80); });
  }
  // 切到背景時放開所有按鍵 (避免車子自己一直開)
  document.addEventListener('visibilitychange', () => { for (const el of pad.querySelectorAll('[data-key]')) { el.classList.remove('on'); send('keyup', el.dataset.key); } });
})();

// ======================================================================= 掛上主程式
TW.HOOKS.init.push(() => {
  initTraffic();
  for (const g of LIVE.etc) buildEtc(g);
  pollSpeed(); pollCms();
  if (TW.params.get('radio') === 'auto') radio.toggle(); // 測試用
  if (TW.params.has('gpsauto')) gpsSync.toggle();      // 測試用
});
TW.HOOKS.update.push((dt) => { updateTraffic(dt); });
TW.HOOKS.joint = (v, axle) => { stats.joints = (stats.joints || 0) + 1; sound.knock(v, axle); };
TW.HOOKS.frame.push((dt) => { updateSigns(dt); sound.update(dt); sound.blinker(); updateTrafficHud(dt); gpsSync.frame(dt); });
// 除錯/測試: AI 車之間互相重疊的對數
function overlaps() {
  let n = 0;
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (!a.alive || !b.alive || Math.abs(a.z - b.z) > 2) continue;
    const dx = b.x - a.x, dy = b.y - a.y, fx = Math.cos(a.h), fy = Math.sin(a.h);
    if (Math.cos(a.h - b.h) < 0.5) continue;   // 路口交會不算
    if (Math.abs(dx * fx + dy * fy) < (a.front + a.rear + b.front + b.rear) / 4 - 0.3 && Math.abs(-dx * fy + dy * fx) < (a.wid + b.wid) / 2 - 0.15) n++;
  }
  return n;
}
window.TWX = { cars, signs, wayTraffic, radio, sound, stats, overlaps, gpsSync };
})();
