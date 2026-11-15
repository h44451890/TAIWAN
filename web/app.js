/* 台灣 1:1 — 國道台北段 駕駛模擬
 * 材質與 Blender 版 (scripts/build_freeway_blender.py) 使用相同公式與顏色 (線性色彩空間)。
 * 座標: 資料 (x 東, y 北, z 上) 公尺 -> three.js (x, z, -y)
 */
(function () {
'use strict';
const T = window.THREE;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const setStatus = (s) => { const el = $('loading-msg'); if (el) el.textContent = s; };

// ======================================================================= 資料 (分區載入)
// tiles/index.json: 全域資訊；tiles/t/*.bin: 地形；tiles/d/*.bin: 路段 + 橋墩 + 建築 (scripts/tile_web.py)
// 單檔 台灣.html 把分區內嵌成 <script id="tile-d-x_y">；GitHub Pages 版 (index.html) 用到才下載
function b64buf(str) {
  const bin = atob(str.trim());
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
const INDEX = JSON.parse($('tile-index').textContent);
const TS = INDEX.ts, TC = INDEX.tc, TSTEP = INDEX.step, TN = TC + 3;   // 地形分區含 1 格外框
const TGI = INDEX.terrain;                                               // 全域地形格點範圍 (J = x / 30, I = y / 30)
const TILE_BASE = (params.get('tiles') || 'tiles/').replace(/\/?$/, '/');
const tkey = (tx, ty) => tx + '_' + ty;
/** 內嵌的分區直接解碼 (同步)，否則下載 (回傳 Promise) */
function tileBuf(kind, key) {
  const el = document.getElementById('tile-' + kind + '-' + key);
  if (el) { const b = b64buf(el.textContent); el.remove(); return b; }
  return limitedFetch(TILE_BASE + kind + '/' + key + '.bin');
}
// 同時最多 8 個下載 (一次要幾十區時，不會塞爆伺服器)
let fetching = 0;
const fetchQueue = [];
function limitedFetch(url) {
  return new Promise((resolve, reject) => {
    const run = () => {
      fetching++;
      fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(resolve, reject).finally(() => { fetching--; if (fetchQueue.length) fetchQueue.shift()(); });
    };
    if (fetching < 8) run(); else fetchQueue.push(run);
  });
}

const LANE_W = 3.75;
const WAYS = [];            // 依載入順序；w.k = 索引，w.gid = 全域編號 (live.json、傳送地點用)
const GID = new Map();
const wayByGid = (g) => { const k = GID.get(g); return k == null ? null : WAYS[k]; };
const ptKey = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
const PT_INDEX = new Map(); // 座標 -> [[way, idx], ...]
// 空間索引 (路段線段)
const CELL = 40;
const GRID = new Map();
const cellKey = (cx, cy) => cx * 100003 + cy;
function indexWay(w) {
  for (let i = 0; i < w.n; i++) {
    const key = ptKey(w.P[i * 3], w.P[i * 3 + 1]);
    let a = PT_INDEX.get(key); if (!a) PT_INDEX.set(key, a = []); a.push([w.k, i]);
  }
  for (let i = 0; i < w.n - 1; i++) {
    const ax = w.P[i * 3], ay = w.P[i * 3 + 1], bx = w.P[i * 3 + 3], by = w.P[i * 3 + 4];
    const r = w.hw + 2;
    const cx0 = Math.floor((Math.min(ax, bx) - r) / CELL), cx1 = Math.floor((Math.max(ax, bx) + r) / CELL);
    const cy0 = Math.floor((Math.min(ay, by) - r) / CELL), cy1 = Math.floor((Math.max(ay, by) + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const key = cellKey(cx, cy);
      let a = GRID.get(key); if (!a) GRID.set(key, a = []); a.push(w.k, i);
    }
  }
}
function makeWay(w) {
  const n = w.n = w.P.length / 3;
  w.k = WAYS.length; w.hw = w.width / 2;
  if (!w.U) w.U = new Float32Array(n);
  if (!w.M) w.M = new Uint8Array(n);
  // 左法向與累積距離
  w.nx = new Float32Array(n); w.ny = new Float32Array(n); w.s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
    const dx = w.P[b * 3] - w.P[a * 3], dy = w.P[b * 3 + 1] - w.P[a * 3 + 1];
    const L = Math.hypot(dx, dy) || 1;
    w.nx[i] = -dy / L; w.ny[i] = dx / L;
    if (i > 0) {
      const ex = w.P[i * 3] - w.P[i * 3 - 3], ey = w.P[i * 3 + 1] - w.P[i * 3 - 2], ez = w.P[i * 3 + 2] - w.P[i * 3 - 1];
      w.s[i] = w.s[i - 1] + Math.hypot(ex, ey, ez);
    }
  }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) {
    const x = w.P[i * 3], y = w.P[i * 3 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  w.bb = [x0 - w.hw, y0 - w.hw, x1 + w.hw, y1 + w.hw];
  WAYS.push(w);
  GID.set(w.gid, w.k);
  indexWay(w);
  return w;
}
/** 細節分區 -> 路段 (加入 WAYS)、橋墩、建築。格式見 scripts/tile_web.py pack_detail */
function ingestDetail(buf) {
  const jl = new DataView(buf).getUint32(0, true);
  const hd = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
  let o = 4 + jl;
  const f32 = (n) => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const i16 = (n) => { const a = new Int16Array(buf, o, n); o += n * 2; return a; };
  const ncw = hd.cw.length;
  const fP = f32(hd.np * 3), fU = f32(hd.np), piers = f32(hd.npier * 9), rxy0 = f32(ncw * 2);
  const bxy0 = f32(hd.nb * 2), bbase = f32(hd.nb), bh = f32(hd.nb);
  const roff = i16(hd.cnp * 2), rz = i16(hd.cnp), boff = i16(hd.nbv * 2);
  const bcnt = new Uint16Array(buf, o, hd.nb); o += hd.nb * 2;
  const emask = new Uint8Array(buf, o, hd.np); o += hd.np;   // bit0 左路緣、bit1 右路緣落在別條路面上
  const bcol = new Uint8Array(buf, o, hd.nb);
  const ways = [];
  let p = 0;
  for (let q = 0; q < hd.fw.length; q++) {   // 國道 / 快速道路
    const m = hd.fw[q], n = hd.fc[q];
    ways.push(makeWay({
      gid: m[0], ref: m[1], name: m[2], lanes: m[3], ls: m[4], rs: m[5], width: m[6],
      bridge: !!(m[7] & 1), tunnel: !!(m[7] & 2), link: !!(m[7] & 4), oneway: !!(m[7] & 8),
      maxspeed: m[8], trunk: !!m[9], cls: m[9] ? 1 : 0,
      P: fP.subarray(p * 3, (p + n) * 3), U: fU.subarray(p, p + n), M: emask.subarray(p, p + n),
    }).k);
    p += n;
  }
  // 一般道路: 第一點 + 0.1 m 相對座標
  const cp = new Float32Array(hd.cnp * 3);
  for (let k = 0, v = 0; k < ncw; k++) for (let i = 0; i < hd.cc[k]; i++, v++) {
    cp[v * 3] = rxy0[k * 2] + roff[v * 2] * 0.1; cp[v * 3 + 1] = rxy0[k * 2 + 1] + roff[v * 2 + 1] * 0.1; cp[v * 3 + 2] = rz[v] * 0.1;
  }
  p = 0;
  for (let q = 0; q < ncw; q++) {
    const m = hd.cw[q], n = hd.cc[q];
    ways.push(makeWay({ gid: m[0], ref: '', name: m[6], cls: m[1], lanes: m[2], oneway: !!m[3], width: m[4], bridge: !!m[5], tunnel: false,
      link: m[1] === 6, ls: 0.3, rs: 0.3, maxspeed: 0, city: true, P: cp.subarray(p * 3, (p + n) * 3) }).k);
    p += n;
  }
  // 建築頂點 (第一點 + 0.1 m 相對座標)
  const bxy = new Float32Array(hd.nbv * 2);
  for (let b = 0, v = 0; b < hd.nb; b++) for (let i = 0; i < bcnt[b]; i++, v++) {
    bxy[v * 2] = bxy0[b * 2] + boff[v * 2] * 0.1; bxy[v * 2 + 1] = bxy0[b * 2 + 1] + boff[v * 2 + 1] * 0.1;
  }
  return { ways, piers, bld: hd.nb ? { bxy, bbase, bh, bcnt, bcol, nb: hd.nb } : null };
}

/** 找 (x,y) 處、高度不高於 zRef+climb 的最高路面。margin: 距路緣保留寬度 */
function roadAt(x, y, zRef, margin, climb = 1.3) {
  const a = GRID.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!a) return null;
  let best = null;
  for (let q = 0; q < a.length; q += 2) {
    const w = WAYS[a[q]], i = a[q + 1], P = w.P;
    const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
    const bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L < 1e-3) continue;
    const t = ((x - ax) * dx + (y - ay) * dy) / (L * L);
    const ext = 1.5 / L;
    if (t < -ext || t > 1 + ext) continue;
    const lat = ((x - ax) * -dy + (y - ay) * dx) / L;
    if (Math.abs(lat) > w.hw - margin) continue;
    const tc = Math.min(Math.max(t, 0), 1);
    const z = az + (bz - az) * tc;
    if (z > zRef + climb) continue;
    if (!best || z > best.z) best = { z, w, i, t: tc, lat, tx: dx / L, ty: dy / L };
  }
  return best;
}

const TERR = new Map();       // 地形分區 key -> Int16Array (TN x TN, 0.1 m)
function terrainAt(x, y) {
  const J = Math.min(Math.max(x / TSTEP, TGI.J0), TGI.J0 + TGI.w - 1.001), I = Math.min(Math.max(y / TSTEP, TGI.I0), TGI.I0 + TGI.h - 1.001);
  const j = Math.floor(J), i = Math.floor(I), u = J - j, v = I - i;
  const tx = Math.floor(j / TC), ty = Math.floor(i / TC);
  const a = TERR.get(tkey(tx, ty));
  if (!a) return 0;
  const lj = j - tx * TC + 1, li = i - ty * TC + 1;
  const h = (ii, jj) => a[ii * TN + jj] * 0.1;
  return (1 - v) * ((1 - u) * h(li, lj) + u * h(li, lj + 1)) + v * ((1 - u) * h(li + 1, lj) + u * h(li + 1, lj + 1));
}

// ======================================================================= 渲染器
const renderer = new T.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
// 手機 (觸控裝置) 省電模式: 解析度、陰影降低，建築只畫附近
const MOBILE = params.get('touch') === '1' || (params.get('touch') !== '0' && window.matchMedia && matchMedia('(pointer: coarse)').matches);
renderer.setPixelRatio(MOBILE ? Math.min(window.devicePixelRatio, 1) : Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.AgXToneMapping;          // 與 Blender 相同的 AgX
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new T.Scene();
const camera = new T.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 45000);

// 太陽方向: 與 Blender 太陽 (rotation 58°, 0, 35°) 相同 -> 指向太陽的單位向量 (three 座標)
const SUN_DIR = new T.Vector3(0.486, 0.530, 0.695).normalize();
const HORIZON = new T.Color(0.62, 0.70, 0.80);

// ---- 天空 (方向漸層 + 太陽光暈) -> 背景與環境光
function buildSky() {
  const mat = new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false,
    uniforms: { sunDir: { value: SUN_DIR } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      varying vec3 vDir; uniform vec3 sunDir;
      void main(){
        vec3 d = normalize(vDir);
        float e = d.y;
        vec3 zenith = vec3(0.16, 0.30, 0.62);
        vec3 horizon = vec3(0.62, 0.70, 0.80);
        vec3 ground = vec3(0.10, 0.11, 0.10);
        vec3 col = e > 0.0 ? mix(horizon, zenith, pow(e, 0.45)) : mix(horizon, ground, pow(min(-e*4.0,1.0),0.6));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0,0.85,0.6) * pow(s, 8.0) * 0.25;   // 只有光暈、沒有太陽圓盤 (與 Blender sun_disc=False 相同)
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const skyScene = new T.Scene();
  skyScene.add(new T.Mesh(new T.SphereGeometry(10, 64, 32), mat));
  const rt = new T.WebGLCubeRenderTarget(512, { type: T.HalfFloatType });
  const cc = new T.CubeCamera(0.1, 100, rt);
  cc.update(renderer, skyScene);
  scene.background = rt.texture;
  const pm = new T.PMREMGenerator(renderer);
  scene.environment = pm.fromCubemap(rt.texture).texture;
  scene.environmentIntensity = 0.55;
}
buildSky();
scene.fog = new T.FogExp2(HORIZON.clone(), 0.000045);

const sun = new T.DirectionalLight(0xffffff, 3.2);   // 與 Blender 太陽強度相同
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
const SC = sun.shadow.camera; SC.left = -90; SC.right = 90; SC.top = 90; SC.bottom = -90; SC.near = 1; SC.far = 1500;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

// ======================================================================= 材質 (移植自 Blender)
const GLSL_NOISE = `
  float fwyHash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  float fwyVNoise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(fwyHash(i),fwyHash(i+vec3(1,0,0)),f.x), mix(fwyHash(i+vec3(0,1,0)),fwyHash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(fwyHash(i+vec3(0,0,1)),fwyHash(i+vec3(1,0,1)),f.x), mix(fwyHash(i+vec3(0,1,1)),fwyHash(i+vec3(1,1,1)),f.x),f.y), f.z); }
  float fwyFbm(vec3 p, int oct){ float a=0.5, s=0.0, t=0.0; for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*fwyVNoise(p); t+=a; p*=2.02; a*=0.5; } return s/t; }
`;

function patch(mat, { vert = '', vmain = '', frag = '', color = '' }) {
  // 每個材質注入的程式碼不同，必須有自己的快取 key；否則 three.js 會讓它們共用第一個編譯好的著色器
  const key = 'fwy:' + vert + '|' + vmain + '|' + frag + '|' + color;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\n' + vert)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = vec3(position.x, -position.z, position.y);\n' + vmain);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\n' + GLSL_NOISE + frag)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + color);
  };
  return mat;
}

// 瀝青路面 + 標線 (內側黃實線、外側白實線、車道白虛線 畫4m空6m, 線寬15cm)
const matAsphalt = patch(new T.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }), {
  vert: 'attribute vec2 aUv; attribute float aLs; attribute float aLanes; varying vec2 vRUv; varying float vLs; varying float vLanes;',
  vmain: 'vRUv = aUv; vLs = aLs; vLanes = aLanes;',
  frag: 'varying vec2 vRUv; varying float vLs; varying float vLanes;',
  color: `{
    float k = (vRUv.x - vLs) / ${LANE_W.toFixed(2)};
    float kr = floor(k + 0.5);
    float dist = abs(k - kr) * ${LANE_W.toFixed(2)};
    float fw = max(fwidth(dist), 1e-4);
    float onLine = 1.0 - smoothstep(0.075 - fw, 0.075 + fw, dist);
    float isLeft = step(abs(kr), 0.1);
    float isRight = step(abs(kr - vLanes), 0.1);
    float inner = step(0.5, kr) * (1.0 - step(vLanes - 0.5, kr));
    float ph = fract(vRUv.y / 10.0);
    float fv = max(fwidth(vRUv.y / 10.0), 1e-4);
    float dash = 1.0 - smoothstep(0.4 - fv, 0.4 + fv, ph);
    float white = onLine * max(isRight, inner * dash);
    float yellow = onLine * isLeft;
    vec3 base = mix(vec3(0.035,0.035,0.037), vec3(0.075,0.073,0.07), fwyFbm(vObj*0.8, 6));
    vec3 c = mix(base, vec3(0.8,0.8,0.78), white);
    c = mix(c, vec3(0.85,0.6,0.05), yellow);
    diffuseColor.rgb = c;
  }`,
});
function concreteLike(color, rough, amt, scale = 0.3) {
  const c = color.map((v) => v.toFixed(4)).join(',');
  return patch(new T.MeshStandardMaterial({ roughness: rough, metalness: 0, side: T.DoubleSide }), {
    color: `diffuseColor.rgb = mix(vec3(${c})*${(1 - amt).toFixed(3)}, vec3(${c}), fwyFbm(vObj*${scale}, 4));`,
  });
}
const matConcrete = concreteLike([0.5, 0.49, 0.46], 0.85, 0.25);
// 風化混凝土護欄 (照街景): 灰色帶斑駁、垂直雨痕、底部較髒、每 6 m 一道接縫、每 3 m 一個底部排水孔
const matBarrier = patch(new T.MeshStandardMaterial({ roughness: 0.92, metalness: 0, side: T.DoubleSide }), {
  vert: 'attribute vec2 aUv; varying vec2 vRUv;',
  vmain: 'vRUv = aUv;',
  frag: 'varying vec2 vRUv;',
  color: `{
    float s = vRUv.x, h = vRUv.y;
    float fw = max(fwidth(s), 1e-4);
    float n = fwyFbm(vec3(s * 0.9, h * 3.0, 0.0), 5);
    float streak = fwyFbm(vec3(s * 6.0, h * 0.35, 1.7), 3);
    vec3 c = vec3(0.18, 0.175, 0.165) * (0.78 + 0.35 * n);
    c *= mix(1.0, 0.72, smoothstep(0.55, 0.8, streak));
    c *= mix(0.62, 1.0, smoothstep(0.0, 0.35, h));
    float jd = abs(fract(s / 6.0 + 0.5) - 0.5) * 6.0;
    c *= mix(0.35, 1.0, smoothstep(0.012, 0.012 + fw * 1.5, jd));
    float dd = abs(fract(s / 3.0) - 0.5) * 3.0;
    float slot = (1.0 - smoothstep(0.15, 0.15 + fw, dd)) * (1.0 - smoothstep(0.085, 0.1, h));
    diffuseColor.rgb = mix(c, vec3(0.01), slot);
  }`,
});
// 市區道路: 路緣白實線、雙向中央雙黃線、同向車道白虛線；巷道 (代碼 0) 無標線
const matCityRoad = patch(new T.MeshStandardMaterial({ roughness: 0.88, metalness: 0 }), {
  vert: 'attribute vec2 aUv; attribute float aLs; attribute float aLanes; varying vec2 vRUv; varying float vW; varying float vCode;',
  vmain: 'vRUv = aUv; vW = aLs; vCode = aLanes;',
  frag: 'varying vec2 vRUv; varying float vW; varying float vCode;',
  color: `{
    float u = vRUv.x, W = vW, fw = max(fwidth(u), 1e-4);
    vec3 c = mix(vec3(0.05, 0.05, 0.052), vec3(0.095, 0.092, 0.088), fwyFbm(vObj * 0.7, 5));
    if (abs(vCode) > 0.5) {
      float two = step(vCode, -0.5), L = abs(vCode);
      float edge = min(abs(u - 0.3), abs(u - (W - 0.3)));
      float white = 1.0 - smoothstep(0.06, 0.06 + fw, edge);
      float yellow = 0.0;
      float ld = two > 0.5 ? max(1.0, floor(L / 2.0)) : L;
      float halfW = two > 0.5 ? (W * 0.5 - 0.3) : (W - 0.6);
      float pos = two > 0.5 ? (u < W * 0.5 ? (u - 0.3) : (W - 0.3 - u)) : (u - 0.3);
      float x = pos / (halfW / ld), kr = floor(x + 0.5), dd = abs(x - kr) * (halfW / ld);
      float dash = 1.0 - smoothstep(0.4, 0.4 + max(fwidth(vRUv.y / 10.0), 1e-4), fract(vRUv.y / 10.0));
      if (kr > 0.5 && kr < ld - 0.5) white = max(white, (1.0 - smoothstep(0.06, 0.06 + fw, dd)) * dash);
      if (two > 0.5) { float cd = abs(abs(u - W * 0.5) - 0.12); yellow = 1.0 - smoothstep(0.05, 0.05 + fw, cd); }
      c = mix(c, vec3(0.75, 0.75, 0.72), white);
      c = mix(c, vec3(0.85, 0.6, 0.05), yellow);
    }
    diffuseColor.rgb = c;
  }`,
});
// 建築牆面: 外牆色 + 每層窗戶 (樓高 3.2 m、窗距 2.6 m)，一樓是店面
const matWall = patch(new T.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05, side: T.DoubleSide }), {
  vert: 'attribute vec3 aUv3; attribute vec3 aCol; varying vec3 vB; varying vec3 vCol;',
  vmain: 'vB = aUv3; vCol = aCol;',
  frag: 'varying vec3 vB; varying vec3 vCol;',
  color: `{
    float u = vB.x, v = vB.y, h = vB.z;
    vec3 c = vCol * (0.85 + 0.3 * fwyFbm(vec3(u * 0.3, v * 0.5, 3.1), 4));
    float fl = fract(v / 3.2), wx = fract(u / 2.6);
    float win = step(0.3, fl) * step(fl, 0.82) * step(0.16, wx) * step(wx, 0.84) * step(3.4, v) * step(v, h - 0.8);
    float lit = step(0.82, fwyHash(vec3(floor(u / 2.6), floor(v / 3.2), floor(h))));
    vec3 glass = mix(vec3(0.03, 0.04, 0.05), vec3(0.08, 0.09, 0.1), lit);
    c = mix(c, glass, win);
    float shop = step(v, 3.2) * step(0.4, v) * step(0.06, wx) * step(wx, 0.94);
    c = mix(c, vec3(0.025, 0.03, 0.035), shop * 0.85);
    diffuseColor.rgb = c;
  }`,
});
const matRoof = patch(new T.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: T.DoubleSide }), {
  vert: 'attribute vec3 aCol; varying vec3 vCol;',
  vmain: 'vCol = aCol;',
  frag: 'varying vec3 vCol;',
  color: 'diffuseColor.rgb = vCol * (0.8 + 0.4 * fwyFbm(vObj * 0.2, 3));',
});
// 伸縮縫: 鋼板 + 橡膠縫
const matJointSteel = new T.MeshStandardMaterial({ color: new T.Color(0.32, 0.33, 0.34), metalness: 0.85, roughness: 0.38 });
const matJointRubber = new T.MeshStandardMaterial({ color: new T.Color(0.01, 0.01, 0.012), roughness: 0.9 });
const matReflR = new T.MeshBasicMaterial({ color: new T.Color(0.75, 0.02, 0.02), toneMapped: false });
const matReflY = new T.MeshBasicMaterial({ color: new T.Color(0.85, 0.55, 0.02), toneMapped: false });
const matTunnel = concreteLike([0.55, 0.53, 0.48], 0.6, 0.2, 1.5);
const matTunnelLight = new T.MeshStandardMaterial({ color: 0x000000, emissive: new T.Color(1.0, 0.82, 0.55), emissiveIntensity: 2.5 });
const matTerrain = patch(new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), {
  color: `{
    float t = clamp((vObj.z - 15.0) / (90.0 - 15.0), 0.0, 1.0);
    float n1 = fwyFbm(vObj*0.004, 5);
    vec3 low = mix(vec3(0.055,0.068,0.045), vec3(0.075,0.085,0.06), n1);     // 盆地: 灰綠 (都市+綠地)
    vec3 high = mix(vec3(0.016,0.042,0.014), vec3(0.032,0.068,0.024), n1);   // 山區: 闊葉林深綠
    diffuseColor.rgb = mix(low, high, t);
  }`,
});

// ======================================================================= 幾何建構
class GB {
  // mode: '' 只有位置；'uv' 加 aUv；'road' 加 aUv + 車道屬性
  constructor(mode = '') { this.p = []; this.i = []; this.extra = mode === 'road'; if (mode) this.uv = []; if (this.extra) { this.ls = []; this.ln = []; } this.nrm = null; }
  get n() { return this.p.length / 3; }
  v(x, y, z) { this.p.push(x, z, -y); return this.n - 1; }  // 資料座標 -> three
  q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  mesh(mat, opts = {}) {
    if (!this.i.length) return null;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    if (this.uv) g.setAttribute('aUv', new T.Float32BufferAttribute(this.uv, 2));
    if (this.extra) {
      g.setAttribute('aLs', new T.Float32BufferAttribute(this.ls, 1));
      g.setAttribute('aLanes', new T.Float32BufferAttribute(this.ln, 1));
    }
    g.setIndex(this.n > 65535 ? new T.Uint32BufferAttribute(this.i, 1) : new T.Uint16BufferAttribute(this.i, 1));
    if (this.nrm) g.setAttribute('normal', new T.Float32BufferAttribute(this.nrm, 3)); else g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new T.Mesh(g, mat);
    m.castShadow = !!opts.cast; m.receiveShadow = opts.receive !== false;
    m.matrixAutoUpdate = false; m.updateMatrix();
    return m;
  }
}

// 混凝土護欄斷面 (照街景: 底部小斜趾、上半近乎垂直、平頂)；[橫向 m, 高 m]
const BARRIER = [[-0.32, 0], [-0.3, 0.07], [-0.2, 0.16], [-0.11, 0.84], [-0.08, 0.87], [0.08, 0.87], [0.11, 0.84], [0.2, 0.16], [0.3, 0.07], [0.32, 0]];
const BARRIER_INSET = 0.35;

function addRoad(c, w) {
  const { P, nx, ny, s, n, hw } = w;
  // 路面
  const r = c.road, b0 = r.n;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    r.v(x + nx[i] * hw, y + ny[i] * hw, z); r.uv.push(0, s[i]); r.ls.push(w.ls); r.ln.push(w.lanes);
    r.v(x - nx[i] * hw, y - ny[i] * hw, z); r.uv.push(w.width, s[i]); r.ls.push(w.ls); r.ln.push(w.lanes);
  }
  for (let i = 0; i < n - 1; i++) { const a = b0 + i * 2; r.q(a, a + 1, a + 3, a + 2); }
  // 側面 / 梁底
  const depth = w.bridge ? 2.2 : (w.tunnel ? 0.6 : 2.0);
  const k = c.skirt, s0 = k.n;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const lx = x + nx[i] * hw, ly = y + ny[i] * hw, rx = x - nx[i] * hw, ry = y - ny[i] * hw;
    k.v(lx, ly, z); k.v(rx, ry, z); k.v(lx, ly, z - depth); k.v(rx, ry, z - depth);
  }
  const M = w.M;
  for (let i = 0; i < n - 1; i++) {
    const a = s0 + i * 4, bb = a + 4;
    if (!((M[i] | M[i + 1]) & 1)) k.q(a, bb, bb + 2, a + 2);          // 左側 (落在別條路面上就不做)
    if (!((M[i] | M[i + 1]) & 2)) k.q(a + 1, a + 3, bb + 3, bb + 1);  // 右側
    if (w.bridge) k.q(a + 2, bb + 2, bb + 3, a + 3);                 // 梁底
  }
  // 紐澤西護欄 (左右；分合流處落在別條路面上的段落不放)
  for (const [edge, inward, bit] of [[hw, -1, 1], [-hw, 1, 2]]) {
    // 每個斷面線段各自一組頂點 (稜角分明)；UV: u = 沿線距離、v = 高度 (給接縫、排水孔、髒污用)
    const g = c.barrier, g0 = g.n, segs = BARRIER.length - 1, per = segs * 2;
    const o = edge + inward * BARRIER_INSET;
    for (let i = 0; i < n; i++) {
      const cx = P[i * 3] + nx[i] * o, cy = P[i * 3 + 1] + ny[i] * o, cz = P[i * 3 + 2];
      for (let j = 0; j < segs; j++) for (const [a, h] of [BARRIER[j], BARRIER[j + 1]]) {
        g.v(cx + nx[i] * a, cy + ny[i] * a, cz + h - 0.03); g.uv.push(s[i], h);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      if ((M[i] | M[i + 1]) & bit) continue;
      for (let j = 0; j < segs; j++) { const a = g0 + i * per + j * 2; g.q(a, a + 1, a + 1 + per, a + per); }
    }
    // 反光片: 每 24 m 一片，外側紅色、中央分隔黃色
    const R = bit === 1 ? c.reflY : c.reflR;
    for (let d = 12; d < s[n - 1]; d += 24) {
      let k = 0; while (k < n - 2 && s[k + 1] < d) k++;
      if ((M[k] | M[k + 1]) & bit) continue;
      const t = (d - s[k]) / ((s[k + 1] - s[k]) || 1);
      const x = P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t + nx[k] * o, y = P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t + ny[k] * o;
      const z = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t;
      box(R, x, y, ny[k], -nx[k], 0.05, 0.035, z + 0.84, z + 0.95);
    }
  }
  if (w.tunnel) addTunnel(c, w);
}

// ======================================================================= 伸縮縫 (橋梁接縫)
// 每座橋墩上方與橋頭各一道；車輪壓過時「叩」一聲 (前輪、後輪各一下)
const JOINTS = [], JGRID = new Map(), JCELL = 50;
function addJoint(x, y, tx, ty, hw, z) {
  const j = { x, y, tx, ty, hw, z };
  JOINTS.push(j);
  const r = hw + 2;
  for (let cx = Math.floor((x - r) / JCELL); cx <= Math.floor((x + r) / JCELL); cx++)
    for (let cy = Math.floor((y - r) / JCELL); cy <= Math.floor((y + r) / JCELL); cy++) {
      const k = cx * 100003 + cy;
      let a = JGRID.get(k); if (!a) JGRID.set(k, a = []); a.push(j);
    }
}
const JSEEN = new Set();
/** 分區的伸縮縫 (需要鄰區資料: 橋頭判斷、橋墩上方路面) -> [[x, y, z, tx, ty, hw]] */
function computeJoints(rec) {
  const out = [];
  const mk = (x, y, z, tx, ty, hw) => {
    const key = Math.round(x) + ',' + Math.round(y) + ',' + Math.round(z);
    if (JSEEN.has(key)) return;
    JSEEN.add(key);
    out.push([x, y, z, tx, ty, hw]);
    addJoint(x, y, tx, ty, hw, z);
  };
  const A = rec.piers;
  for (let k = 0; k < A.length / 9; k++) {   // 橋墩上方
    const x = A[k * 9], y = A[k * 9 + 1], tx = A[k * 9 + 2], ty = A[k * 9 + 3], top = A[k * 9 + 6];
    const r = roadAt(x, y, top + 2.5, 0, 1.0);
    if (r && Math.abs(r.z - (top + 2.2)) < 1.5) mk(x, y, r.z, tx, ty, r.w.hw);
  }
  for (const k of rec.ways) {             // 橋頭 (橋接地面路段處)
    const w = WAYS[k];
    if (!w.bridge || w.city) continue;
    for (const i of [0, w.n - 1]) {
      const others = PT_INDEX.get(ptKey(w.P[i * 3], w.P[i * 3 + 1])) || [];
      if (!others.some(([o]) => o !== w.k && !WAYS[o].bridge)) continue;
      mk(w.P[i * 3], w.P[i * 3 + 1], w.P[i * 3 + 2], w.ny[i], -w.nx[i], w.hw);
    }
  }
  return out;
}
function jointMeshes(list, group) {
  const steel = new GB(), rubber = new GB();
  for (const [x, y, z, tx, ty, hw] of list) {
    const span = hw - 0.25;
    box(steel, x + tx * 0.17, y + ty * 0.17, tx, ty, 0.12, span, z - 0.03, z + 0.012);
    box(steel, x - tx * 0.17, y - ty * 0.17, tx, ty, 0.12, span, z - 0.03, z + 0.012);
    box(rubber, x, y, tx, ty, 0.05, span, z - 0.03, z + 0.004);
  }
  for (const m of [steel.mesh(matJointSteel), rubber.mesh(matJointRubber)]) if (m) group.add(m);
}
/** 車軸從 (ax,ay) 移到 (bx,by) 時有沒有壓過伸縮縫 */
function crossedJoint(ax, ay, bx, by, z) {
  const a = JGRID.get(Math.floor(bx / JCELL) * 100003 + Math.floor(by / JCELL));
  if (!a) return false;
  for (const j of a) {
    if (Math.abs(z - j.z) > 1.5) continue;
    const d0 = (ax - j.x) * j.tx + (ay - j.y) * j.ty, d1 = (bx - j.x) * j.tx + (by - j.y) * j.ty;
    if (d0 * d1 > 0 || d0 === d1) continue;
    const lat = (bx - j.x) * -j.ty + (by - j.y) * j.tx;
    if (Math.abs(lat) <= j.hw) return true;
  }
  return false;
}

function box(g, cx, cy, tx, ty, hx, hy, z0, z1) {
  // tx,ty: 沿線方向；法向 = (-ty, tx)
  const nx = -ty, ny = tx;
  const corner = (sx, sy, z) => g.v(cx + tx * sx * hx + nx * sy * hy, cy + ty * sx * hx + ny * sy * hy, z);
  const faces = [
    [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]].reverse(),
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]],
    [[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]],
    [[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]],
    [[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]],
  ];
  for (const f of faces) {
    const idx = f.map(([sx, sy, zz]) => corner(sx, sy, zz ? z1 : z0));
    g.q(idx[0], idx[1], idx[2], idx[3]);
  }
}

/** 橋墩 (前處理已避開下層道路): 柱子可能往側邊偏移，帽梁延伸過去撐住橋面 */
function addPier(g, A, k) {
  const q = A.subarray(k * 9, k * 9 + 9);
  const [x, y, tx, ty, offL, zg, top, capL, capR] = q;
  const nx = -ty, ny = tx;
  box(g, x + nx * offL, y + ny * offL, tx, ty, 1.0, 1.25, zg - 1.0, top - 1.4);            // 柱
  const mid = (capL + capR) / 2;
  box(g, x + nx * mid, y + ny * mid, tx, ty, 0.9, (capR - capL) / 2, top - 1.4, top);      // 帽梁
}

/** 隧道口: 端點沒有接另一段隧道 */
const isTunnelEnd = (w, i) => !(PT_INDEX.get(ptKey(w.P[i * 3], w.P[i * 3 + 1])) || []).some(([k]) => k !== w.k && WAYS[k].tunnel);

function addTunnel(c, w) {
  const { P, nx, ny, n, hw } = w;
  const R = hw + 0.8, H = 6.8, M = 18;
  const g = c.tunnel, g0 = g.n;
  for (let i = 0; i < n; i++) for (let j = 0; j <= M; j++) {
    const ph = Math.PI * j / M, lat = -Math.cos(ph) * R, up = Math.sin(ph) * H;
    g.v(P[i * 3] + nx[i] * lat, P[i * 3 + 1] + ny[i] * lat, P[i * 3 + 2] + up - 0.3);
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < M; j++) {
    const a = g0 + i * (M + 1) + j; g.q(a, a + M + 1, a + M + 2, a + 1);
  }
  const L = c.tlight, l0 = L.n;
  for (let i = 0; i < n; i++) for (const o of [0.25, -0.25]) L.v(P[i * 3] + nx[i] * o, P[i * 3 + 1] + ny[i] * o, P[i * 3 + 2] + H - 0.45);
  for (let i = 0; i < n - 1; i++) { const a = l0 + i * 2; L.q(a, a + 2, a + 3, a + 1); }
  for (const i of [0, n - 1]) if (isTunnelEnd(w, i)) c.portals.push([w, i]);
}

function portalMesh(w, i) {
  const R = w.hw + 0.8, H = 6.8;
  const sh = new T.Shape();
  sh.moveTo(-R - 4, -2.5); sh.lineTo(R + 4, -2.5); sh.lineTo(R + 4, H + 3.5); sh.lineTo(-R - 4, H + 3.5); sh.lineTo(-R - 4, -2.5);
  const hole = new T.Path();
  hole.moveTo(-R, -0.3);
  for (let j = 0; j <= 24; j++) { const ph = Math.PI * j / 24; hole.lineTo(-Math.cos(ph) * R, Math.sin(ph) * H - 0.3); }
  hole.lineTo(-R, -0.3);
  sh.holes.push(hole);
  const geo = new T.ExtrudeGeometry(sh, { depth: 1.6, bevelEnabled: false, curveSegments: 4 });
  geo.translate(0, 0, -0.8);
  const m = new T.Mesh(geo, matConcrete);
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2];
  const nX = new T.Vector3(w.nx[i], 0, -w.ny[i]);          // 左 (three)
  const tZ = new T.Vector3(w.ny[i], 0, w.nx[i]);           // 切線 (three)
  const mtx = new T.Matrix4().makeBasis(nX, new T.Vector3(0, 1, 0), tZ);
  mtx.setPosition(x, z, -y);
  m.applyMatrix4(mtx);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

const newChunk = () => ({ road: new GB('road'), city: new GB('road'), skirt: new GB(), barrier: new GB('uv'), reflR: new GB(), reflY: new GB(),
  pier: new GB(), tunnel: new GB(), tlight: new GB(), portals: [] });

/** 一般道路: 鋪在地形上的路面 (市區標線由材質依 aLs=路寬、aLanes=車道代碼 算出)；橋梁加梁身與橋墩 */
function addCityRoad(c, w) {
  const { P, nx, ny, s, n, hw } = w;
  const code = w.cls === 5 ? 0 : (w.oneway ? w.lanes : -w.lanes);   // 0: 巷道無標線；負: 雙向 (中央雙黃線)
  const r = c.city, b0 = r.n;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    r.v(x + nx[i] * hw, y + ny[i] * hw, z); r.uv.push(0, s[i]); r.ls.push(w.width); r.ln.push(code);
    r.v(x - nx[i] * hw, y - ny[i] * hw, z); r.uv.push(w.width, s[i]); r.ls.push(w.width); r.ln.push(code);
  }
  for (let i = 0; i < n - 1; i++) { const a = b0 + i * 2; r.q(a, a + 1, a + 3, a + 2); }
  if (!w.bridge) return;
  const k = c.skirt, s0 = k.n, depth = 1.6;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    k.v(x + nx[i] * hw, y + ny[i] * hw, z); k.v(x - nx[i] * hw, y - ny[i] * hw, z);
    k.v(x + nx[i] * hw, y + ny[i] * hw, z - depth); k.v(x - nx[i] * hw, y - ny[i] * hw, z - depth);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = s0 + i * 4, bb = a + 4;
    k.q(a, bb, bb + 2, a + 2); k.q(a + 1, a + 3, bb + 3, bb + 1); k.q(a + 2, bb + 2, bb + 3, a + 3);
  }
  for (let d = 15; d < s[n - 1] - 5; d += 30) {
    let i = 0; while (i < n - 2 && s[i + 1] < d) i++;
    const x = P[i * 3], y = P[i * 3 + 1], top = P[i * 3 + 2] - depth, g = terrainAt(x, y);
    if (top - g > 3) box(c.pier, x, y, ny[i], -nx[i], 0.7, Math.min(hw * 0.6, 3), g - 1, top);
  }
}

// ======================================================================= 分區串流
// 車子附近: 先下載資料 (DATA_R)，鄰近 8 區的資料都到了才建模型 (MESH_R)，遠了丟掉模型 (資料留著，回來不用重下載)
const MESH_R = +(params.get('meshr') || (MOBILE ? 4200 : 7000));
const DATA_R = MESH_R + TS * 1.45;            // 模型區的鄰區一定已經有資料
const TERR_R = +(params.get('terrr') || (MOBILE ? 9000 : 18000));
const TILES = new Map();                       // 細節分區 key -> { key, tx, ty, state, ways, piers, bld, linked, joints, group, bldChunks }
const TERR_REC = new Map();                    // 地形分區 key -> { state, mesh }
let inflight = 0;
const worldGroup = new T.Group();
scene.add(worldGroup);
function tileDist(tx, ty, x, y) {
  const cx = Math.min(Math.max(x, tx * TS), (tx + 1) * TS), cy = Math.min(Math.max(y, ty * TS), (ty + 1) * TS);
  return Math.hypot(x - cx, y - cy);
}
/** 半徑 R 內的分區 [[key, tx, ty, 距離]]，由近到遠 */
function tilesNear(x, y, R) {
  const out = [];
  for (let tx = Math.floor((x - R) / TS); tx <= Math.floor((x + R) / TS); tx++)
    for (let ty = Math.floor((y - R) / TS); ty <= Math.floor((y + R) / TS); ty++) {
      const d = tileDist(tx, ty, x, y);
      if (d <= R) out.push([tkey(tx, ty), tx, ty, d]);
    }
  return out.sort((a, b) => a[3] - b[3]);
}
function whenBuf(kind, key, onOk, onErr) {
  let b;
  try { b = tileBuf(kind, key); } catch (e) { onErr(e); return null; }
  if (b instanceof ArrayBuffer) { onOk(b); return null; }
  inflight++;
  return b.then(onOk, onErr).finally(() => { inflight--; });
}
function requestDetail(key, tx, ty) {
  if (TILES.has(key) || !INDEX.detail[key]) return null;
  const rec = { key, tx, ty, state: 'loading', ways: [], piers: new Float32Array(0), bld: null, linked: false, joints: [], group: null, bldChunks: [] };
  TILES.set(key, rec);
  return whenBuf('d', key, (buf) => {
    Object.assign(rec, ingestDetail(buf));
    rec.state = 'data';
    for (const f of HOOKS.tile) f(rec);
  }, (e) => { console.warn('分區載入失敗', key, e); setTimeout(() => TILES.delete(key), 3000); });
}
function requestTerrain(key) {
  if (TERR_REC.has(key) || !INDEX.tiles_t[key]) return null;
  const rec = { state: 'loading', mesh: null };
  TERR_REC.set(key, rec);
  return whenBuf('t', key, (buf) => { TERR.set(key, new Int16Array(buf)); rec.state = 'data'; },
    (e) => { console.warn('地形載入失敗', key, e); setTimeout(() => TERR_REC.delete(key), 3000); });
}
function neighborsReady(rec) {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const k = tkey(rec.tx + dx, rec.ty + dy);
    if (!INDEX.detail[k]) continue;
    const r = TILES.get(k);
    if (!r || r.state !== 'data') return false;
  }
  return true;
}
function buildTile(rec) {
  const c = newChunk(), g = new T.Group();
  for (const k of rec.ways) { const w = WAYS[k]; if (w.city) addCityRoad(c, w); else addRoad(c, w); }
  for (let k = 0; k < rec.piers.length / 9; k++) addPier(c.pier, rec.piers, k);
  for (const m of [c.road.mesh(matAsphalt, { cast: true }), (params.has('nocr') ? null : c.city.mesh(matCityRoad)), c.skirt.mesh(matConcrete, { cast: true }),
                   c.barrier.mesh(matBarrier, { cast: true }), c.pier.mesh(matConcrete, { cast: true }),
                   c.tunnel.mesh(matTunnel, { cast: true }), c.tlight.mesh(matTunnelLight, { receive: false }),
                   c.reflR.mesh(matReflR, { receive: false }), c.reflY.mesh(matReflY, { receive: false })]) if (m) g.add(m);
  for (const [w, i] of c.portals) g.add(portalMesh(w, i));
  jointMeshes(rec.joints, g);
  rec.bldChunks = (rec.bld && !params.has('nobld')) ? buildBuildings(rec.bld, g) : [];   // nobld: 測試用，不建建築
  worldGroup.add(g);
  rec.group = g;
}
function disposeGroup(g) {
  if (g.parent) g.parent.remove(g);
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
}
/** 地形分區 (法向由含外框的高度場計算，分區之間沒有接縫) */
function buildTerrainMesh(key, tx, ty) {
  const a = TERR.get(key);
  const ja = Math.max(tx * TC, TGI.J0), jb = Math.min(tx * TC + TC, TGI.J0 + TGI.w - 1);
  const ia = Math.max(ty * TC, TGI.I0), ib = Math.min(ty * TC + TC, TGI.I0 + TGI.h - 1);
  if (!a || jb <= ja || ib <= ia) return null;
  const hh = (I, J) => a[(I - ty * TC + 1) * TN + (J - tx * TC + 1)] * 0.1;
  const g = new GB(); g.nrm = [];
  const cols = jb - ja + 1;
  for (let I = ia; I <= ib; I++) for (let J = ja; J <= jb; J++) {
    g.v(J * TSTEP, I * TSTEP, hh(I, J));
    const hx = (hh(I, J + 1) - hh(I, J - 1)) / (2 * TSTEP), hy = (hh(I + 1, J) - hh(I - 1, J)) / (2 * TSTEP);
    const L = Math.hypot(hx, hy, 1);
    g.nrm.push(-hx / L, 1 / L, hy / L);
  }
  for (let i = 0; i < ib - ia; i++) for (let j = 0; j < jb - ja; j++) {
    const q = i * cols + j; g.q(q, q + 1, q + cols + 1, q + cols);
  }
  return g.mesh(matTerrain);
}
/** opts: x,y (預設車子位置)；all: 不限同時下載數；build: 'all' 全部建 / false 不建 / 預設每次 1 區 */
function streamTick(opts = {}) {
  const x = opts.x != null ? opts.x : S.x, y = opts.y != null ? opts.y : S.y;
  const proms = [];
  const near = tilesNear(x, y, DATA_R);
  for (const [key, tx, ty] of near) {
    if (inflight >= 6 && !opts.all) break;
    const pr = requestDetail(key, tx, ty); if (pr) proms.push(pr);
  }
  const nearT = tilesNear(x, y, TERR_R);
  for (const [key] of nearT) {
    if (inflight >= 8 && !opts.all) break;
    const pr = requestTerrain(key); if (pr) proms.push(pr);
  }
  let budget = opts.build === 'all' ? 1e9 : opts.build === false ? 0 : 1;
  for (const [key, , , d] of near) {
    const rec = TILES.get(key);
    if (!rec || rec.state !== 'data') continue;
    if (!rec.linked && neighborsReady(rec)) { rec.joints = computeJoints(rec); rec.linked = true; }
    if (budget > 0 && rec.linked && !rec.group && d <= MESH_R) { buildTile(rec); budget--; }
  }
  let tb = opts.build === 'all' ? 1e9 : opts.build === false ? 0 : 3;
  for (const [key, tx, ty] of nearT) {
    const r = TERR_REC.get(key);
    if (tb > 0 && r && r.state === 'data' && !r.mesh) {
      const m = buildTerrainMesh(key, tx, ty);
      r.mesh = m || 'none'; if (m) worldGroup.add(m);
      tb--;
    }
  }
  // 丟掉遠處的模型
  for (const rec of TILES.values()) if (rec.group && tileDist(rec.tx, rec.ty, x, y) > MESH_R + 1500) { disposeGroup(rec.group); rec.group = null; rec.bldChunks = []; }
  for (const [key, r] of TERR_REC) if (r.mesh && r.mesh !== 'none') {
    const [tx, ty] = key.split('_').map(Number);
    if (tileDist(tx, ty, x, y) > TERR_R + 2500) { disposeGroup(r.mesh); r.mesh = null; }
  }
  return proms;
}
/** 等 (x,y) 附近的資料到齊、模型建好 (起點與傳送用) */
async function ensureArea(x, y, msg) {
  for (let guard = 0; guard < 10; guard++) {
    const proms = streamTick({ x, y, all: true, build: false });
    if (!proms.length) break;
    if (msg) setStatus(msg);
    await Promise.all(proms);
  }
  streamTick({ x, y, build: 'all' });
}
let streamClock = 0;
function streamFrame(dt) { streamClock -= dt; if (streamClock > 0) return; streamClock = 0.25; streamTick(); }

// ---- 3D 建築: 依 OSM 高度 / 樓層擠出；牆面 UV (沿周長 m, 高度 m, 總高) 給窗戶材質用
const FACADE = [[0.45, 0.40, 0.32], [0.42, 0.42, 0.40], [0.55, 0.54, 0.50], [0.28, 0.19, 0.13], [0.30, 0.30, 0.29], [0.48, 0.37, 0.33], [0.25, 0.29, 0.33]];
// 建築依距離顯示 (手機 1.6 km、電腦 4.5 km)；遠處被霧氣蓋住，不畫可以省很多效能
let bldClock = 0;
function cullBuildings(dt) {
  bldClock -= dt;
  if (bldClock > 0) return;
  bldClock = 0.5;
  const R = (MOBILE ? 1600 : 4500) + 700;
  for (const rec of TILES.values()) for (const ch of rec.bldChunks) { const vis = Math.hypot(ch.x - S.x, ch.y - S.y) < R; for (const m of ch.meshes) m.visible = vis; }
}
function buildBuildings(bld, world) {
  const { bxy, bbase, bh, bcnt, bcol, nb } = bld;
  const out = [];
  const chunks = new Map(), CHB = 1000;
  let o = 0;
  for (let b = 0; b < nb; b++) {
    const n = bcnt[b], base = bbase[b], top = base + bh[b], col = FACADE[bcol[b]];
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += bxy[(o + i) * 2]; cy += bxy[(o + i) * 2 + 1]; }
    cx /= n; cy /= n;
    const key = Math.floor(cx / CHB) + ',' + Math.floor(cy / CHB);
    let c = chunks.get(key);
    if (!c) chunks.set(key, c = { wp: [], wuv: [], wcol: [], wi: [], rp: [], rcol: [], ri: [] });
    let per = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = bxy[(o + i) * 2], ay = bxy[(o + i) * 2 + 1], bx = bxy[(o + j) * 2], by = bxy[(o + j) * 2 + 1];
      const L = Math.hypot(bx - ax, by - ay);
      const v0 = c.wp.length / 3;
      c.wp.push(ax, base, -ay, bx, base, -by, bx, top, -by, ax, top, -ay);
      c.wuv.push(per, 0, bh[b], per + L, 0, bh[b], per + L, bh[b], bh[b], per, bh[b], bh[b]);
      for (let q = 0; q < 4; q++) c.wcol.push(col[0], col[1], col[2]);
      c.wi.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      per += L;
    }
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new T.Vector2(bxy[(o + i) * 2], bxy[(o + i) * 2 + 1]));
    const tris = T.ShapeUtils.triangulateShape(contour.slice(), []);   // 會就地刪除重複端點，傳複本
    const r0 = c.rp.length / 3;
    for (let i = 0; i < n; i++) { c.rp.push(contour[i].x, top, -contour[i].y); c.rcol.push(col[0] * 0.6, col[1] * 0.6, col[2] * 0.6); }
    for (const t of tris) c.ri.push(r0 + t[0], r0 + t[2], r0 + t[1]);
    o += n;
  }
  for (const c of chunks.values()) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(c.wp, 3));
    g.setAttribute('aUv3', new T.Float32BufferAttribute(c.wuv, 3));
    g.setAttribute('aCol', new T.Float32BufferAttribute(c.wcol, 3));
    g.setIndex(c.wp.length / 3 > 65535 ? new T.Uint32BufferAttribute(c.wi, 1) : new T.Uint16BufferAttribute(c.wi, 1));
    g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new T.Mesh(g, matWall); m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; world.add(m);
    const r = new T.BufferGeometry();
    r.setAttribute('position', new T.Float32BufferAttribute(c.rp, 3));
    r.setAttribute('aCol', new T.Float32BufferAttribute(c.rcol, 3));
    r.setIndex(c.rp.length / 3 > 65535 ? new T.Uint32BufferAttribute(c.ri, 1) : new T.Uint16BufferAttribute(c.ri, 1));
    r.computeVertexNormals(); r.computeBoundingSphere();
    const rm = new T.Mesh(r, matRoof); rm.castShadow = true; rm.receiveShadow = true; rm.matrixAutoUpdate = false; world.add(rm);
    out.push({ x: c.wp[0], y: -c.wp[2], meshes: [m, rm] });
  }
  return out;
}

// ======================================================================= 精細車輛
function plateTexture(text) {
  const cv = document.createElement('canvas'); cv.width = 380; cv.height = 160;
  const x = cv.getContext('2d');
  x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, 380, 160);
  x.strokeStyle = '#111'; x.lineWidth = 8; x.strokeRect(6, 6, 368, 148);
  x.fillStyle = '#111'; x.font = 'bold 104px "Arial Narrow", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 190, 88);
  x.font = 'bold 20px sans-serif'; x.fillText('臺灣省', 190, 24);
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// 方向燈: 琥珀色，每秒閃 1.5 次
const SIG_ON = new T.Color(1.0, 0.42, 0.0), SIG_OFF = new T.Color(0.18, 0.07, 0.0);
const blinkPhase = () => (performance.now() % 666) < 333;

function cosInterp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (x <= x1) { const t = (x - x0) / (x1 - x0), u = (1 - Math.cos(Math.PI * t)) / 2; return y0 + (y1 - y0) * u; }
  }
  return table[table.length - 1][1];
}

/** 沿 x 放樣：ring(x) 回傳 [[z(側), y(上)], ...] (閉合)；faceGroup(i,j) 回傳材質群組 */
function loft(xs, ring, faceGroup, caps = true) {
  const pos = [], groups = {};
  const N = ring(xs[0]).length;
  for (const x of xs) for (const [z, y] of ring(x)) pos.push(x, y, z);
  const add = (gid, a, b, c) => (groups[gid] = groups[gid] || []).push(a, b, c);
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < N; j++) {
    const a = i * N + j, b = i * N + (j + 1) % N, c = (i + 1) * N + (j + 1) % N, d = (i + 1) * N + j;
    const gid = faceGroup ? faceGroup(i, j) : 0;
    add(gid, a, d, c); add(gid, a, c, b);
  }
  if (caps) for (const [i, flip] of [[0, true], [xs.length - 1, false]]) {
    const ci = pos.length / 3; let cy = 0, cz = 0;
    for (let j = 0; j < N; j++) { cz += pos[(i * N + j) * 3 + 2]; cy += pos[(i * N + j) * 3 + 1]; }
    pos.push(xs[i], cy / N, cz / N);
    for (let j = 0; j < N; j++) { const a = i * N + j, b = i * N + (j + 1) % N; flip ? add(0, ci, b, a) : add(0, ci, a, b); }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  const idx = []; let start = 0;
  for (const gid of Object.keys(groups).sort()) { const arr = groups[gid]; idx.push(...arr); g.addGroup(start, arr.length, +gid); start += arr.length; }
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function superRing(hw, yb, yt, nexp, N, taperTop = 1) {
  const pts = [], yc = (yb + yt) / 2, hy = (yt - yb) / 2;
  for (let j = 0; j < N; j++) {
    const th = 2 * Math.PI * j / N, c = Math.cos(th), s = Math.sin(th);
    const zz = Math.sign(c) * Math.pow(Math.abs(c), 2 / nexp), yy = Math.sign(s) * Math.pow(Math.abs(s), 2 / nexp);
    const h = (yy + 1) / 2;
    pts.push([zz * hw * (1 + (taperTop - 1) * h), yc + yy * hy]);
  }
  return pts;
}

function buildCar() {
  const car = new T.Group();
  const paint = new T.MeshPhysicalMaterial({ color: new T.Color(0.55, 0.012, 0.018), metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  const glass = new T.MeshPhysicalMaterial({ color: new T.Color(0.01, 0.012, 0.015), metalness: 0.1, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.0, envMapIntensity: 1.6 });
  const black = new T.MeshStandardMaterial({ color: new T.Color(0.012, 0.012, 0.013), roughness: 0.55 });
  const gloss = new T.MeshPhysicalMaterial({ color: new T.Color(0.01, 0.01, 0.01), roughness: 0.15, clearcoat: 1 });
  const chrome = new T.MeshStandardMaterial({ color: new T.Color(0.9, 0.9, 0.92), metalness: 1, roughness: 0.12 });
  const rimMat = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.56, 0.58), metalness: 1, roughness: 0.25 });
  const tireMat = new T.MeshStandardMaterial({ color: new T.Color(0.02, 0.02, 0.02), roughness: 0.92 });
  const discMat = new T.MeshStandardMaterial({ color: new T.Color(0.3, 0.3, 0.3), metalness: 0.9, roughness: 0.45 });
  const caliper = new T.MeshStandardMaterial({ color: new T.Color(0.7, 0.04, 0.02), roughness: 0.4 });
  const headMat = new T.MeshStandardMaterial({ color: 0xffffff, emissive: new T.Color(1, 0.97, 0.9), emissiveIntensity: 1.6, roughness: 0.1 });
  const tailMat = new T.MeshBasicMaterial({ color: new T.Color(0.5, 0.005, 0.005), toneMapped: false }); // 不經色調映射，保持純紅
  const sigLMat = new T.MeshBasicMaterial({ color: SIG_OFF.clone(), toneMapped: false });   // 左方向燈
  const sigRMat = new T.MeshBasicMaterial({ color: SIG_OFF.clone(), toneMapped: false });   // 右方向燈
  const add = (geo, mat, x = 0, y = 0, z = 0, cast = true) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; car.add(m); return m; };

  const L2 = 2.35, AX = 1.4, WR = 0.33;
  // ---- 車身下半部 (含輪拱)
  const top = [[-L2, 0.60], [-2.30, 0.78], [-2.18, 0.93], [-1.9, 0.965], [-1.3, 0.975], [0.9, 0.955], [1.25, 0.93], [1.7, 0.86], [2.15, 0.76], [2.3, 0.66], [L2, 0.52]];
  const bot = [[-L2, 0.30], [-2.2, 0.22], [-1.9, 0.20], [1.9, 0.20], [2.25, 0.24], [L2, 0.30]];
  const half = [[-L2, 0.74], [-2.25, 0.86], [-2.0, 0.905], [-1.4, 0.915], [1.5, 0.915], [2.05, 0.885], [2.28, 0.80], [L2, 0.70]];
  const xs = []; for (let i = 0; i <= 90; i++) { const t = i / 90; xs.push(-L2 + 2 * L2 * (0.5 - 0.5 * Math.cos(Math.PI * t))); }
  const arch = (x) => { let yb = cosInterp(bot, x); for (const ax of [AX, -AX]) { const d = x - ax, r = 0.43; if (Math.abs(d) < r) yb = Math.max(yb, WR + Math.sqrt(r * r - d * d)); } return yb; };
  const bodyGeo = loft(xs, (x) => superRing(cosInterp(half, x), arch(x), cosInterp(top, x), 5.5, 40), null);
  add(bodyGeo, paint);
  // 輪拱內襯 (避免看穿車身)
  for (const ax of [AX, -AX]) add(new T.BoxGeometry(0.95, 0.62, 1.2), black, ax, 0.5, 0);
  // ---- 車艙 (玻璃 + 車頂)
  const roof = [[-1.36, 0.95], [-1.05, 1.27], [-0.65, 1.42], [0.15, 1.45], [0.55, 1.37], [1.06, 0.95]];
  const gHalf = [[-1.36, 0.70], [-1.0, 0.75], [0.6, 0.76], [1.06, 0.72]];
  const gx = []; for (let i = 0; i <= 50; i++) gx.push(-1.36 + 2.42 * i / 50);
  const NR = 32;
  const cabinGeo = loft(gx, (x) => superRing(cosInterp(gHalf, x), 0.9, cosInterp(roof, x), 4, NR, 0.8), (i, j) => {
    const x = gx[i], th = 2 * Math.PI * (j + 0.5) / NR;
    const roofF = x > -0.98 && x < 0.52 && Math.abs(th - Math.PI / 2) < 0.95;
    const side = Math.abs(Math.cos(th)) > 0.5;
    const pillar = side && (x < -0.98 || Math.abs(x + 0.18) < 0.06 || x > 0.66); // C / B / A 柱與車身同色
    return (roofF || pillar) ? 0 : 1;
  });
  const cabin = new T.Mesh(cabinGeo, [paint, glass]); cabin.castShadow = true; car.add(cabin);
  // 柱子
  const tube = (a, b, r, mat) => {
    const va = new T.Vector3(...a), vb = new T.Vector3(...b), len = va.distanceTo(vb);
    const m = add(new T.CylinderGeometry(r, r, len, 10), mat);
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    return m;
  };
  for (const s of [1, -1]) {
    tube([-1.3, 0.958, s * 0.735], [1.0, 0.958, s * 0.74], 0.012, chrome); // 窗框飾條
    for (const dx of [0.98, -0.18, -1.28]) tube([dx, 0.3, s * 0.912], [dx, 0.93, s * 0.905], 0.005, black); // 車門縫
    for (const dx of [0.2, -0.82]) add(new T.BoxGeometry(0.14, 0.025, 0.03), chrome, dx, 0.86, s * 0.925);  // 門把
    // 後照鏡
    const mir = add(new T.BoxGeometry(0.16, 0.11, 0.2), paint, 0.92, 1.0, s * 0.97);
    add(new T.BoxGeometry(0.01, 0.085, 0.16), chrome, 0.835, 1.0, s * 0.975);
    tube([0.96, 0.96, s * 0.80], [0.94, 0.98, s * 0.88], 0.02, black);
    // 側裙
    add(new T.BoxGeometry(2.0, 0.07, 0.05), black, 0, 0.25, s * 0.9);
  }
  // ---- 車頭
  for (const s of [1, -1]) {
    const hl = add(new T.BoxGeometry(0.34, 0.085, 0.3), headMat, 2.13, 0.775, s * 0.6, false);
    hl.rotation.y = s * 0.28; hl.rotation.z = -0.25;
    add(new T.BoxGeometry(0.3, 0.02, 0.26), chrome, 2.12, 0.735, s * 0.6).rotation.set(0, s * 0.28, -0.25);
    add(new T.BoxGeometry(0.03, 0.03, 0.22), headMat, 2.31, 0.47, s * 0.55, false); // 日行燈
  }
  add(new T.BoxGeometry(0.06, 0.15, 0.78), gloss, 2.29, 0.6, 0);            // 水箱罩
  for (let k = 0; k < 4; k++) add(new T.BoxGeometry(0.065, 0.008, 0.76), chrome, 2.295, 0.54 + k * 0.04, 0);
  add(new T.BoxGeometry(0.08, 0.13, 1.15), black, 2.31, 0.33, 0);           // 下進氣口
  const pf = add(new T.PlaneGeometry(0.38, 0.16), new T.MeshStandardMaterial({ map: plateTexture('ABC-1234'), roughness: 0.4 }), 2.358, 0.44, 0);
  pf.rotation.y = Math.PI / 2;
  // ---- 車尾 (紅色尾燈組 + 白色倒車燈 + 後擋風玻璃上方第三煞車燈)
  add(new T.BoxGeometry(0.05, 0.06, 1.2), tailMat, -2.31, 0.86, 0, false);
  for (const s of [1, -1]) {
    add(new T.BoxGeometry(0.14, 0.17, 0.34), tailMat, -2.25, 0.84, s * 0.64, false).rotation.y = -s * 0.25;
    add(new T.BoxGeometry(0.03, 0.05, 0.12), headMat, -2.335, 0.74, s * 0.5, false);
  }
  add(new T.BoxGeometry(0.04, 0.03, 0.4), tailMat, -1.2, 1.25, 0, false);
  add(new T.BoxGeometry(0.12, 0.03, 1.3), paint, -2.2, 0.975, 0).rotation.z = 0.12;   // 尾翼唇
  add(new T.BoxGeometry(0.06, 0.12, 1.3), black, -2.32, 0.32, 0);           // 後下擾流
  const pr = add(new T.PlaneGeometry(0.38, 0.16), new T.MeshStandardMaterial({ map: plateTexture('ABC-1234'), roughness: 0.4 }), -2.335, 0.6, 0);
  pr.rotation.y = -Math.PI / 2;
  for (const s of [1, -1]) {
    const ex = add(new T.CylinderGeometry(0.045, 0.045, 0.16, 16), chrome, -2.3, 0.25, s * 0.45);
    ex.rotation.z = Math.PI / 2;
  }
  add(new T.BoxGeometry(0.22, 0.06, 0.07), paint, -0.85, 1.43, 0).rotation.z = 0.25; // 鯊魚鰭天線
  add(new T.BoxGeometry(4.0, 0.05, 1.5), black, 0, 0.2, 0, false);          // 底盤
  // ---- 方向燈 (+z 為右側): 前角、後角、後照鏡側燈
  for (const [s, mat] of [[-1, sigLMat], [1, sigRMat]]) {
    add(new T.BoxGeometry(0.1, 0.05, 0.16), mat, 2.2, 0.69, s * 0.74, false).rotation.y = -s * 0.5;
    add(new T.BoxGeometry(0.06, 0.07, 0.15), mat, -2.29, 0.7, s * 0.7, false);
    add(new T.BoxGeometry(0.1, 0.022, 0.05), mat, 0.9, 0.955, s * 1.07, false);
  }

  // ---- 輪胎 / 輪框 / 卡鉗
  const tireProfile = [[0.215, -0.112], [0.30, -0.112], [0.322, -0.098], [0.33, -0.065], [0.33, 0.065], [0.322, 0.098], [0.30, 0.112], [0.215, 0.112]]
    .map(([r, y]) => new T.Vector2(r, y));
  const tireGeo = new T.LatheGeometry(tireProfile, 56); tireGeo.rotateX(Math.PI / 2);
  const rimGeo = new T.CylinderGeometry(0.218, 0.218, 0.19, 48); rimGeo.rotateX(Math.PI / 2);
  const barrelGeo = new T.CylinderGeometry(0.2, 0.2, 0.2, 32, 1, true); barrelGeo.rotateX(Math.PI / 2);
  const discGeo = new T.CylinderGeometry(0.17, 0.17, 0.025, 40); discGeo.rotateX(Math.PI / 2);
  const hubGeo = new T.CylinderGeometry(0.045, 0.05, 0.04, 20); hubGeo.rotateX(Math.PI / 2);
  const wheels = [];
  for (const ax of [AX, -AX]) for (const s of [1, -1]) {
    const pivot = new T.Group(); pivot.position.set(ax, WR, s * 0.79); car.add(pivot);
    const spin = new T.Group(); pivot.add(spin);
    const out = s; // 外側方向 (+z 右側)
    const tire = new T.Mesh(tireGeo, tireMat); tire.castShadow = true; spin.add(tire);
    const barrel = new T.Mesh(barrelGeo, black); spin.add(barrel);
    const face = new T.Mesh(new T.CylinderGeometry(0.205, 0.205, 0.012, 48).rotateX(Math.PI / 2), rimMat);
    face.position.z = out * 0.075; spin.add(face);
    for (let k = 0; k < 5; k++) {
      const sp = new T.Mesh(new T.BoxGeometry(0.17, 0.045, 0.03), rimMat);
      const a = k * 2 * Math.PI / 5;
      sp.position.set(Math.cos(a) * 0.105, Math.sin(a) * 0.105, out * 0.09); sp.rotation.z = a; spin.add(sp);
      const hole = new T.Mesh(new T.BoxGeometry(0.06, 0.05, 0.02), black);
      hole.position.set(Math.cos(a + Math.PI / 5) * 0.15, Math.sin(a + Math.PI / 5) * 0.15, out * 0.083); hole.rotation.z = a + Math.PI / 5; spin.add(hole);
    }
    const hub = new T.Mesh(hubGeo, chrome); hub.position.z = out * 0.1; spin.add(hub);
    const disc = new T.Mesh(discGeo, discMat); disc.position.z = -out * 0.01; pivot.add(disc);
    const cal = new T.Mesh(new T.BoxGeometry(0.12, 0.08, 0.06), caliper); cal.position.set(-0.05, 0.13, out * 0.02); pivot.add(cal);
    wheels.push({ pivot, spin, front: ax > 0 });
  }
  car.userData = { wheels, tailMat, headMat, paint, sigLMat, sigRMat };
  return car;
}

// ======================================================================= 車輛狀態與物理
const PLAYER_TYPES = ['sedan', 'taxi', 'police', 'scooter', 'minibus', 'citybus', 'coach', 'boxtruck', 'bigtruck', 'semi'];
const PLAYER_PAINT = { taxi: [0.8, 0.52, 0.02], police: [0.85, 0.85, 0.83], citybus: [0.8, 0.8, 0.78], coach: [0.8, 0.8, 0.78], minibus: [0.8, 0.8, 0.78] };
let car = buildCar();
let trailer = null;
scene.add(car);
const S = { x: 0, y: 0, z: 0, vz: 0, h: 0, v: 0, steer: 0, road: null, pitch: 0, roll: 0, braking: false, vtype: 'sedan', vt: null };
let WB = 2.8, MARGIN = 1.25;

/** 換車: 依車種重建玩家車模型與物理參數 (聯結車另建拖車) */
function setVehicle(type) {
  const TV = window.TWV && window.TWV.TYPES;
  if (!TV || !TV[type]) return;
  scene.remove(car);
  if (trailer) { scene.remove(trailer.group); trailer = null; }
  const r = window.TWV.build(type);
  car = r.group;
  car.userData = Object.assign({}, car.userData, r.ud);
  const ud = car.userData;
  ud.paint.color.setRGB(...(PLAYER_PAINT[type] || [0.55, 0.012, 0.018]));
  if (ud.accent) ud.accent.color.setRGB(...(type === 'scooter' ? [0.05, 0.06, 0.15] : [0.6, 0.02, 0.02]));
  scene.add(car);
  const t = TV[type];
  if (t.trailer) {
    const tr = window.TWV.build(t.trailer.type);
    tr.ud.accent.color.setRGB(0.05, 0.2, 0.45);
    trailer = { group: tr.group, ud: tr.ud, h: S.h, cfg: t.trailer };
    scene.add(tr.group);
  }
  S.vtype = type; S.vt = t; WB = t.wb; MARGIN = t.wid / 2 + 0.35;
  camInit = false;
}

// ---- 車道 / 路網 (國道、快速道路、一般道路共用)
/** 行進方向的車道數 (雙向一般道路只算一半) */
const laneCount = (w) => (w.city && !w.oneway) ? Math.max(1, Math.floor(w.lanes / 2)) : w.lanes;
/** 車道中心相對路線左法向的偏移。lane 0 = 最內側；雙向一般道路靠行進方向右側 */
function laneOffDir(w, lane, dir = 1) {
  const lc = laneCount(w);
  lane = Math.min(Math.max(lane, 0), lc - 1);
  if (w.city) {
    if (!w.oneway) { const off = (lane + 0.5) * (w.width / 2 - 0.3) / lc; return dir > 0 ? -off : off; }
    return (w.width / 2 - 0.3) - (lane + 0.5) * (w.width - 0.6) / w.lanes;
  }
  if (w.link && w.lanes === 1) return 0;
  return w.hw - w.ls - LANE_W * (lane + 0.5);
}
/** 速限: OSM maxspeed，沒有就依道路等級 */
const speedLimit = (w) => w.maxspeed || (w.city ? (w.cls === 5 ? 30 : 50) : w.trunk ? (w.link ? 50 : 80) : (w.link ? 60 : 100));
/** 路口 (路段端點 node) 可以接續的路段與方向；雙向一般道路兩個方向都能走 */
function nextOptions(w, node) {
  const res = [];
  for (const [k, i] of PT_INDEX.get(ptKey(w.P[node * 3], w.P[node * 3 + 1])) || []) {
    if (k === w.k) continue;
    const o = WAYS[k];
    if (i < o.n - 1) res.push({ o, i, dir: 1, hx: o.ny[i], hy: -o.nx[i] });
    if (o.city && !o.oneway && i > 0) res.push({ o, i, dir: -1, hx: -o.ny[i], hy: o.nx[i] });
  }
  return res.sort((a, b) => a.o.gid - b.o.gid);   // 依全域編號排序: 選路結果不受分區載入順序影響
}
/** 玩家自動駕駛選路: 國道優先同一條主線；一般道路直行，打方向燈就在路口轉彎 */
function chooseNext(w, node, dir, signal) {
  const hx = dir > 0 ? w.ny[node] : -w.ny[node], hy = dir > 0 ? -w.nx[node] : w.nx[node];
  let best = null, bs = -1e9;
  for (const o of nextOptions(w, node)) {
    const dot = hx * o.hx + hy * o.hy, cross = hx * o.hy - hy * o.hx;
    if (dot < (w.city || o.o.city ? -0.2 : 0.3)) continue;
    let sc = dot * 2 + (o.o.ref && o.o.ref === w.ref ? 3 : 0) + (o.o.link && !w.link ? -2 : 0) + (w.link && !o.o.link ? 2 : 0)
      + (!!o.o.city !== !!w.city ? -1 : 0) + (o.o.city && o.o.cls === 5 ? -1 : 0);
    if (signal < 0 && cross > 0.3) sc += 6;
    if (signal > 0 && cross < -0.3) sc += 6;
    if (sc > bs) { bs = sc; best = o; }
  }
  return best;
}
const nextWay = (w) => { const o = chooseNext(w, w.n - 1, 1, 0); return o ? [o.o, o.i] : null; };

function spawn(wayIdx, idx, dir = 1, lane = null) {
  const w = WAYS[wayIdx];
  if (!w) return;
  if (!w.city || w.oneway) dir = 1;
  idx = Math.min(Math.max(idx, 0), w.n - 2);
  const ax = w.P[idx * 3], ay = w.P[idx * 3 + 1], bx = w.P[idx * 3 + 3], by = w.P[idx * 3 + 4];
  const lc = laneCount(w);
  const off = laneOffDir(w, lane != null ? lane : (w.city ? lc - 1 : Math.floor(lc / 2)), dir);
  S.x = ax + w.nx[idx] * off; S.y = ay + w.ny[idx] * off; S.z = w.P[idx * 3 + 2] + 0.5;
  S.h = Math.atan2(by - ay, bx - ax) + (dir < 0 ? Math.PI : 0); S.v = 0; S.vz = 0; S.steer = 0;
  S.road = roadAt(S.x, S.y, S.z, 0, 2); S.zVis = null;
  S.rt = null; S.apLane = null; S.apPending = null;
  if (trailer) trailer.h = S.h;
  if (typeof camInit !== 'undefined') camInit = false;
}
function defaultSpawn() {
  let best = null;
  for (const w of WAYS) if (w.ref === '1' && !w.link && !w.bridge && !w.tunnel && !w.city && (!best || w.s[w.n - 1] > best.s[best.n - 1])) best = w;
  spawn(best.k, Math.floor(best.n * 0.2));
}
function respawnNearest() {
  let best = null, bd = 1e18;
  for (const w of WAYS) {
    if (w.link) continue;
    for (let i = 0; i < w.n - 1; i++) {
      const d = (w.P[i * 3] - S.x) ** 2 + (w.P[i * 3 + 1] - S.y) ** 2 + ((w.P[i * 3 + 2] - S.z) * 3) ** 2;
      if (d < bd) { bd = d; best = [w.k, i]; }
    }
  }
  const w = WAYS[best[0]], i = best[1];
  const dir = (w.city && !w.oneway && Math.cos(S.h) * w.ny[i] + Math.sin(S.h) * -w.nx[i] < 0) ? -1 : 1;
  spawn(best[0], best[1], dir);
}

const keys = {};
let camMode = params.get('cam') === '1' ? 1 : params.get('cam') === '2' ? 2 : 3, autopilot = params.has('demo'), mapScaleIdx = 0;
const MAP_SCALES = [0.11, 0.055, 0.025];
window.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (e.code === 'KeyV') camMode = camMode === 3 ? 1 : 3;
  if (e.code === 'KeyC') camMode = camMode === 2 ? 3 : 2;   // 空拍視角
  if (e.code === 'Digit1') camMode = 1;
  if (e.code === 'Digit3') camMode = 3;
  if (e.code === 'KeyP') autopilot = !autopilot;
  if (e.code === 'KeyM') mapScaleIdx = (mapScaleIdx + 1) % MAP_SCALES.length;
  if (e.code === 'KeyR') respawnNearest();
  if (e.code === 'KeyH') $('help').classList.toggle('hidden');
  if (e.code === 'KeyG') setVehicle(PLAYER_TYPES[(PLAYER_TYPES.indexOf(S.vtype) + 1) % PLAYER_TYPES.length]);   // 換車
  if (e.code === 'KeyT') toggleMenu();
  if (e.code === 'KeyQ' || e.code === 'KeyE') {   // 手動方向燈 Q 左、E 右 (再按一次關)；自動駕駛時路口依方向燈轉彎
    const d = e.code === 'KeyQ' ? -1 : 1;
    S.signal = S.signal === d ? 0 : d; S.signalAuto = false; S.sigArmed = false;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

// ---- 自動駕駛路線: { w 路段, i 線段, dir 行進方向 }，沿路網推進，雙向道路可反向行駛
function updateRoute() {
  if (!S.rt) {
    if (!S.road) return null;
    const w = S.road.w;
    const dir = (w.city && !w.oneway && Math.cos(S.h) * S.road.tx + Math.sin(S.h) * S.road.ty < 0) ? -1 : 1;
    S.rt = { w, i: S.road.i, dir };
  }
  let { w, i, dir } = S.rt, guard = 0;
  while (guard++ < 60) {
    if (i < 0 || i > w.n - 2) {
      const node = dir > 0 ? w.n - 1 : 0;
      const nx = chooseNext(w, node, dir, S.signal || 0);
      if (!nx) { i = Math.min(Math.max(i, 0), w.n - 2); break; }
      w = nx.o; dir = nx.dir; i = dir > 0 ? nx.i : nx.i - 1;
      if (S.signal && !S.signalAuto) { S.signal = 0; S.sigArmed = false; }   // 轉完彎熄燈
      continue;
    }
    const ax = w.P[i * 3], ay = w.P[i * 3 + 1], dx = w.P[i * 3 + 3] - ax, dy = w.P[i * 3 + 4] - ay;
    const t = ((S.x - ax) * dx + (S.y - ay) * dy) / (dx * dx + dy * dy || 1);
    if (dir > 0 && t > 1) { i++; continue; }
    if (dir < 0 && t < 0) { i--; continue; }
    const L = Math.hypot(dx, dy) || 1;
    const lat = ((S.x - ax) * -dy + (S.y - ay) * dx) / L;
    if (Math.abs(lat) > w.hw + 6) { S.rt = null; return null; }
    S.rt = { w, i, dir, t: Math.min(Math.max(t, 0), 1), lat };
    return S.rt;
  }
  S.rt = { w, i, dir, t: dir > 0 ? 1 : 0, lat: 0 };
  return S.rt;
}
/** 自動駕駛路線上的下一段路: 距離路段終點 dist 以內才回傳 { w, dir, d } */
function routeNext(dist) {
  const rt = S.rt;
  if (!rt) return null;
  const w = rt.w, dir = rt.dir, i = rt.i;
  const sNow = w.s[i] + (w.s[i + 1] - w.s[i]) * (rt.t || 0);
  const d = dir > 0 ? w.s[w.n - 1] - sNow : sNow;
  if (d > dist) return null;
  const nx = chooseNext(w, dir > 0 ? w.n - 1 : 0, dir, S.signal || 0);
  return nx ? { w: nx.o, dir: nx.dir, d } : null;
}
function lookAhead(dist) {
  const rt = S.rt;
  if (!rt) return null;
  let w = rt.w, dir = rt.dir, guard = 0;
  const i0 = rt.i, t = rt.t || 0;
  let px = w.P[i0 * 3] + (w.P[i0 * 3 + 3] - w.P[i0 * 3]) * t, py = w.P[i0 * 3 + 1] + (w.P[i0 * 3 + 4] - w.P[i0 * 3 + 1]) * t;
  let v = dir > 0 ? i0 + 1 : i0, k = v;
  while (dist > 0 && guard++ < 800) {
    if (v < 0 || v > w.n - 1) {
      const node = dir > 0 ? w.n - 1 : 0;
      const nx = chooseNext(w, node, dir, S.signal || 0);
      if (!nx) break;
      w = nx.o; dir = nx.dir; v = nx.i + dir; continue;
    }
    const bx = w.P[v * 3], by = w.P[v * 3 + 1], d = Math.hypot(bx - px, by - py);
    k = v;
    if (d >= dist) { px += (bx - px) / d * dist; py += (by - py) / d * dist; dist = 0; break; }
    dist -= d; px = bx; py = by; v += dir;
  }
  k = Math.min(Math.max(k, 0), w.n - 1);
  const lc = laneCount(w);
  const lane = S.apLane == null ? (w.city ? lc - 1 : Math.floor(lc / 2)) : Math.min(S.apLane, lc - 1);
  const off = laneOffDir(w, lane, dir);
  return { x: px + w.nx[k] * off, y: py + w.ny[k] * off, w, dir };
}

function update(dt) {
  const vt = S.vt || (window.TWV && window.TWV.TYPES.sedan) || { acc: 1.5, vmax: 45, wb: 2.8, wid: 1.85 };
  const big = vt.len > 6.5;
  let thr = 0, brk = 0, str = 0;
  if (keys.KeyW || keys.ArrowUp) thr = 1;
  if (keys.KeyS || keys.ArrowDown) brk = 1;
  if (keys.KeyA || keys.ArrowLeft) str += 1;
  if (keys.KeyD || keys.ArrowRight) str -= 1;
  const boost = keys.ShiftLeft || keys.ShiftRight;
  if (thr || brk || str) autopilot = autopilot && !(thr || brk || str) ? false : autopilot;
  const maxSteer = (big ? 0.6 : 0.55) / (1 + Math.abs(S.v) / 14);
  if (autopilot) {
    const rt = updateRoute();
    const w0 = rt ? rt.w : (S.road && S.road.w);
    const dir = rt ? rt.dir : 1;
    const curLat = rt ? rt.lat : (S.road ? S.road.lat : 0);
    if (w0 && (S.apLane == null || S.apWay !== w0.k)) {
      const lc = laneCount(w0);
      if (S.apLane == null) S.apLane = w0.city ? lc - 1 : Math.round((w0.hw - w0.ls - curLat) / LANE_W - 0.5);
      else if (!w0.city) {
        let b = 0, bd = 1e9;
        for (let ln = 0; ln < lc; ln++) { const d = Math.abs(laneOffDir(w0, ln, dir) - curLat); if (d < bd) { bd = d; b = ln; } }
        S.apLane = b;
        if (S.apPending != null) { S.apPending = null; if (S.signalAuto) { S.signal = 0; S.signalAuto = false; } }
      }
      S.apLane = Math.min(Math.max(S.apLane, 0), lc - 1);
      if ((vt.len > 9) && !w0.city) S.apLane = Math.max(S.apLane, lc - 2, 0);   // 大型車走外側
      S.apWay = w0.k;
    }
    const la = lookAhead(10 + Math.abs(S.v) * 1.1 + (big ? 4 : 0));
    if (la && w0) {
      const dx = la.x - S.x, dy = la.y - S.y, Ld = Math.hypot(dx, dy) || 1;
      const alpha = Math.atan2(dy, dx) - S.h;
      const sa = Math.atan2(Math.sin(alpha), Math.cos(alpha));
      str = Math.max(-1, Math.min(1, Math.atan2(2 * WB * Math.sin(sa), Ld) / maxSteer));
      const lim = (speedLimit(la.w) / 3.6) * (la.w.link ? 0.9 : 1);
      const curv = Math.abs(sa) / Ld; const vc = Math.sqrt(3.5 / Math.max(curv * 2, 1e-4));
      const vtg = Math.max(3, Math.min(lim, vc, vt.vmax));
      // IDM 跟車 (含路口讓車)
      const lc = laneCount(w0);
      const shift = dir * (laneOffDir(w0, S.apLane, dir) - curLat);
      const ld = HOOKS.leader ? HOOKS.leader(shift) : { gap: 1e9, v: vtg };
      const v = Math.max(S.v, 0), A = Math.min(1.6, vt.acc * 1.1);
      let acc = A * (1 - Math.pow(v / vtg, 4));
      if (ld.gap < 1e8) {
        const ss = 3 + Math.max(0, v * 1.4 + v * (v - ld.v) / (2 * Math.sqrt(A * 2.5)));
        acc -= A * (ss / Math.max(ld.gap, 0.1)) ** 2;
      }
      if (ld.gap < 2.5) acc = -10;
      if (acc >= 0) thr = Math.min(1, acc / 2.2); else brk = Math.min(1, -acc / 8);
      // 換車道
      S.apCool = (S.apCool || 0) - dt;
      const laneOkP = (ln) => ln >= 0 && ln < lc && !(vt.len > 9 && !w0.city && ln < lc - 2);
      // 前方路段的車道對不上 (車道縮減、主線分岔): 提早往接得上的車道併，等不到空檔就減速
      const nxt = (!w0.city && !w0.link) ? routeNext(Math.max(150, v * 8)) : null;
      let fitsNext = () => true, must = null;
      if (nxt && !nxt.w.city) {
        const lcN = laneCount(nxt.w);
        fitsNext = (ln) => {
          const off = laneOffDir(w0, ln, dir);
          for (let q = 0; q < lcN; q++) if (Math.abs(laneOffDir(nxt.w, q, nxt.dir) - off) < 1.2) return true;
          return false;
        };
        if (!fitsNext(S.apLane)) {
          let best = null;
          for (let ln = 0; ln < lc; ln++) if (fitsNext(ln) && laneOkP(ln) && (best == null || Math.abs(ln - S.apLane) < Math.abs(best - S.apLane))) best = ln;
          if (best != null) must = S.apLane + Math.sign(best - S.apLane);
        }
      }
      if (must != null && S.apPending == null && Math.abs(shift) < 0.4) {
        if (!HOOKS.laneFree || HOOKS.laneFree(dir * (laneOffDir(w0, must, dir) - curLat))) {
          S.apPending = must; S.apSigT = 0.8; S.signal = must < S.apLane ? -1 : 1; S.signalAuto = true; S.apCool = 3;
        } else if (nxt.d < 90) { thr = 0; brk = Math.max(brk, 0.35); }
      }
      if (S.apPending != null) {
        S.apSigT -= dt;
        if (S.apSigT <= 0) {
          const ok = laneOkP(S.apPending) && (!HOOKS.laneFree || HOOKS.laneFree(dir * (laneOffDir(w0, S.apPending, dir) - curLat)));
          if (ok) { S.apLane = S.apPending; S.apChanges = (S.apChanges || 0) + 1; } else S.signal = 0;
          S.apPending = null;
        }
      } else if (S.apCool <= 0 && lc > 1 && Math.abs(shift) < 0.4 && !w0.link && S.vtype !== 'scooter') {
        const blocked = ld.gap < 70 && ld.v < vtg - 2;
        const tries = blocked ? [S.apLane - 1, S.apLane + 1] : (ld.gap > 100 && Math.random() < dt * 0.1 ? [S.apLane + 1] : []);
        for (const ln of tries) {
          if (!laneOkP(ln) || !fitsNext(ln)) continue;
          if (!HOOKS.laneFree || HOOKS.laneFree(dir * (laneOffDir(w0, ln, dir) - curLat))) {
            S.apPending = ln; S.apSigT = 1.3; S.signal = ln < S.apLane ? -1 : 1; S.signalAuto = true; S.apCool = 5;
            break;
          }
        }
        if (tries.length && S.apCool <= 0) S.apCool = 1.5;
      }
      const shiftNow = laneOffDir(w0, S.apLane, dir) - curLat;
      if (S.signalAuto && S.apPending == null) {
        if (Math.abs(shiftNow) < 0.3) { S.sigHold = (S.sigHold || 0) + dt; if (S.sigHold > 0.4) { S.signal = 0; S.signalAuto = false; S.sigHold = 0; } }
        else S.sigHold = 0;
      }
    }
  } else {
    S.apLane = null; S.apPending = null; S.rt = null;
    if (S.signalAuto) { S.signal = 0; S.signalAuto = false; }
  }
  // 手動方向燈: 方向盤轉過再回正後自動熄燈 (自動駕駛時保留到路口轉彎)
  if (S.signal && !S.signalAuto && !autopilot) {
    if (Math.abs(S.steer) > 0.1) S.sigArmed = true;
    else if (S.sigArmed && Math.abs(S.steer) < 0.02) { S.signal = 0; S.sigArmed = false; }
  }
  S.thr = thr; S.brk = brk;
  // 縱向 (依車種: 加速度、極速、煞車)
  let a = 0;
  const vmax = vt.vmax * 1.2 * (boost ? 1.3 : 1);
  if (thr) a += 5.5 * (vt.acc / 1.5) * thr * (1 - Math.max(S.v, 0) / vmax);
  if (brk) a += S.v > 0.5 ? -(big ? 7 : 10) * brk : -3.5 * brk;
  if (keys.Space) a += S.v > 0 ? -8 : (S.v < 0 ? 8 : 0);
  a -= 0.00042 * S.v * Math.abs(S.v) + 0.12 * Math.sign(S.v);
  a -= 9.81 * Math.sin(S.pitch) * 0.9;
  S.v += a * dt;
  if (!thr && !brk && Math.abs(S.v) < 0.15) S.v = 0;
  S.braking = !!(brk && S.v > 0.5) || !!keys.Space;
  // 轉向
  const tgt = str * maxSteer;
  S.steer += Math.max(-2.5 * dt, Math.min(2.5 * dt, tgt - S.steer));
  const yawRate = S.v * Math.tan(S.steer) / WB;
  S.h += yawRate * dt;
  // 平面移動 + 路緣碰撞
  let nx = S.x + Math.cos(S.h) * S.v * dt, ny = S.y + Math.sin(S.h) * S.v * dt;
  let r = roadAt(nx, ny, S.z, MARGIN);
  if (!r && S.road && S.road.w.city) r = roadAt(nx, ny, S.z, 0.3);   // 一般道路沒有護欄: 大車可以壓到路緣
  if (!r && S.road) {
    const tx = S.road.tx, ty = S.road.ty;
    const sgn = Math.cos(S.h) * tx + Math.sin(S.h) * ty >= 0 ? 1 : -1;
    const vtan = S.v * (Math.cos(S.h) * tx * sgn + Math.sin(S.h) * ty * sgn);
    S.v = vtan * 0.92;
    const th = Math.atan2(ty * sgn, tx * sgn);
    S.h += Math.atan2(Math.sin(th - S.h), Math.cos(th - S.h)) * 0.25;
    const lat = S.road.lat, push = -Math.sign(lat) * 0.05;
    nx = S.x + tx * sgn * S.v * dt + (-ty) * push; ny = S.y + ty * sgn * S.v * dt + tx * push;
    r = roadAt(nx, ny, S.z, MARGIN);
    if (!r) { nx = S.x; ny = S.y; r = S.road; S.v *= 0.5; }
  }
  if (r) { S.x = nx; S.y = ny; S.road = r; }
  // 伸縮縫: 前輪、後輪各自壓過時「叩」一聲，車身輕彈
  {
    const hb = WB / 2, cx = Math.cos(S.h), cy = Math.sin(S.h);
    const fx1 = S.x + cx * hb, fy1 = S.y + cy * hb, rx1 = S.x - cx * hb, ry1 = S.y - cy * hb;
    if (S.axF && Math.abs(S.v) > 1) {
      if (crossedJoint(S.axF[0], S.axF[1], fx1, fy1, S.z)) { if (HOOKS.joint) HOOKS.joint(Math.abs(S.v), 0); S.jolt = 0.025; }
      if (crossedJoint(S.axR[0], S.axR[1], rx1, ry1, S.z)) { if (HOOKS.joint) HOOKS.joint(Math.abs(S.v), 1); S.jolt = 0.02; }
    }
    S.axF = [fx1, fy1]; S.axR = [rx1, ry1];
  }
  // 垂直
  const g = S.road ? S.road.z : terrainAt(S.x, S.y);
  if (S.z > g + 0.4) { S.vz -= 9.81 * dt; S.z += S.vz * dt; if (S.z < g) { S.z = g; S.vz = 0; } }
  else { S.z = g; S.vz = 0; }
  if (S.zVis == null || Math.abs(S.zVis - S.z) > 3) S.zVis = S.z;
  S.zVis += (S.z - S.zVis) * (1 - Math.exp(-dt * 14));
  if (S.jolt) { S.zVis += S.jolt; S.jolt = 0; }   // 壓過伸縮縫的小彈跳 (會被平滑濾掉)
  // 車身姿態 (機車轉彎壓車)
  const fx = Math.cos(S.h), fy = Math.sin(S.h);
  const zs = (dx, dy) => { const q = roadAt(S.x + dx, S.y + dy, S.z + 0.5, 0, 1.0); return q ? q.z : S.z; };
  const hl = Math.min(WB / 2, 3);
  const pitchT = Math.atan2(zs(fx * hl, fy * hl) - zs(-fx * hl, -fy * hl), 2 * hl);
  const rollT = vt.lean ? Math.max(-0.5, Math.min(0.5, Math.atan(S.v * yawRate / 9.81)))
    : Math.atan2(zs(-fy * 0.8, fx * 0.8) - zs(fy * 0.8, -fx * 0.8), 1.6);
  const k = 1 - Math.exp(-dt * 5);
  const clampA = (v) => Math.max(-0.2, Math.min(0.2, v));
  S.pitch += (clampA(pitchT) - S.pitch) * k;
  S.roll += ((vt.lean ? rollT : clampA(rollT)) - S.roll) * k;
  // 聯結車拖車 (拖車方向往牽引點收斂)
  if (trailer) {
    const c = trailer.cfg;
    trailer.h += S.v * Math.sin(S.h - trailer.h) / c.kingpin * dt;
  }
}

function syncCar(dt) {
  car.position.set(S.x, S.zVis != null ? S.zVis : S.z, -S.y);
  car.rotation.set(S.roll, S.h, S.pitch, 'YZX');
  for (const wh of car.userData.wheels || []) {
    wh.spin.rotation.z -= S.v * dt / (wh.r || 0.33);
    if (wh.front) wh.pivot.rotation.y = S.steer;
  }
  car.userData.tailMat.color.setRGB(S.braking ? 1 : 0.5, S.braking ? 0.02 : 0.005, S.braking ? 0.01 : 0.005);
  const on = blinkPhase();
  car.userData.sigLMat.color.copy(S.signal === -1 && on ? SIG_ON : SIG_OFF);
  car.userData.sigRMat.color.copy(S.signal === 1 && on ? SIG_ON : SIG_OFF);
  if (car.userData.flashA && S.vtype === 'police') {
    const f = (performance.now() % 500) < 250;
    car.userData.flashA.color.setRGB(f ? 1 : 0.05, f ? 0.02 : 0.02, f ? 0.02 : 0.02);
    car.userData.flashB.color.setRGB(f ? 0.05 : 0.05, f ? 0.02 : 0.15, f ? 0.02 : 1);
  }
  if (trailer) {
    const c = trailer.cfg;
    const hx = S.x - Math.cos(S.h) * c.hitch, hy = S.y - Math.sin(S.h) * c.hitch;
    const tx = hx - Math.cos(trailer.h) * c.kingpin, ty = hy - Math.sin(trailer.h) * c.kingpin;
    const q = roadAt(tx, ty, S.z + 1, 0, 2);
    trailer.group.position.set(tx, q ? q.z : (S.zVis != null ? S.zVis : S.z), -ty);
    trailer.group.rotation.set(0, trailer.h, S.pitch, 'YZX');
    trailer.ud.tailMat.color.copy(car.userData.tailMat.color);
    trailer.ud.sigLMat.color.copy(car.userData.sigLMat.color);
    trailer.ud.sigRMat.color.copy(car.userData.sigRMat.color);
  }
}

// ======================================================================= 攝影機
const camPos = new T.Vector3(), camLook = new T.Vector3();
let camInit = false, orbitYaw = 0, dragging = false, lastX = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => { if (dragging) { orbitYaw -= (e.clientX - lastX) * 0.006; lastX = e.clientX; } });

function updateCamera(dt) {
  const vt = S.vt || { cam: 1, eye: [0.1, 1.2, -0.37] };
  const fwd = new T.Vector3(Math.cos(S.h), 0, -Math.sin(S.h));
  const carP = new T.Vector3(S.x, S.zVis != null ? S.zVis : S.z, -S.y);
  if (trailer) trailer.group.visible = camMode !== 1;
  if (camMode === 2) {   // 空拍
    car.visible = true;
    const back = fwd.clone().applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const want = carP.clone().addScaledVector(back, -150).add(new T.Vector3(0, 140, 0));
    if (!camInit) { camPos.copy(want); camInit = true; }
    camPos.lerp(want, 1 - Math.exp(-dt * 3));
    camera.position.copy(camPos); camera.lookAt(carP.clone().addScaledVector(fwd, 60));
  } else if (camMode === 1) {   // 第一人稱: 只看到前方的路
    car.visible = false;
    camera.near = 0.1;
    const eye = new T.Vector3(...vt.eye).applyEuler(car.rotation).add(carP);
    const dir = new T.Vector3(1, -0.03, 0).applyEuler(new T.Euler(0, S.h, S.pitch, 'YZX'));
    camera.position.copy(eye);
    camera.lookAt(eye.clone().add(dir));
    camInit = false;
  } else {
    car.visible = true;
    if (!dragging) orbitYaw *= Math.exp(-dt * 1.5);
    const cm = vt.cam || 1;
    const back = fwd.clone().applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const want = carP.clone().addScaledVector(back, -8.5 * cm - (trailer ? 8 : 0)).add(new T.Vector3(0, 3.0 * Math.pow(cm, 0.8), 0));
    const look = carP.clone().addScaledVector(fwd, 2.5 * cm).add(new T.Vector3(0, 1.0 * Math.pow(cm, 0.8), 0));
    if (!camInit) { camPos.copy(want); camLook.copy(look); camInit = true; }
    camPos.lerp(want, 1 - Math.exp(-dt * 7)); camLook.lerp(look, 1 - Math.exp(-dt * 12));
    camera.position.copy(camPos); camera.lookAt(camLook);
  }
  camera.updateProjectionMatrix();
  sun.target.position.copy(carP);
  sun.position.copy(carP).addScaledVector(SUN_DIR, 600);
}

// ======================================================================= 選單: 傳送 / 換車 (T)
let SPAWNS = [];
function toggleMenu(force) {
  const el = $('menu');
  if (!el) return;
  const show = force != null ? force : el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  if (show) {
    const list = $('menu-places'), cars = $('menu-cars');
    list.innerHTML = ''; cars.innerHTML = '';
    for (const sp of SPAWNS) {
      const b = document.createElement('button'); b.textContent = sp.name;
      b.onclick = () => { toggleMenu(false); goTo(sp); };
      list.appendChild(b);
    }
    for (const t of PLAYER_TYPES) {
      const b = document.createElement('button'); b.textContent = window.TWV ? window.TWV.TYPES[t].name : t;
      if (t === S.vtype) b.classList.add('on');
      b.onclick = () => { setVehicle(t); toggleMenu(false); };
      cars.appendChild(b);
    }
  }
}

async function goTo(sp) {
  $('loading').classList.remove('hidden');
  await ensureArea(sp.x, sp.y, '傳送中…');
  const w = wayByGid(sp.gid);
  if (w) spawn(w.k, sp.idx, sp.dir || 1);
  $('loading').classList.add('hidden');
}

// ======================================================================= 小地圖 (左上圓形)
const mcv = $('minimap'), mctx = mcv.getContext('2d');
const MAP_PX = 200, DPR = Math.min(window.devicePixelRatio || 1, 2);
mcv.width = MAP_PX * DPR; mcv.height = MAP_PX * DPR;
const REF_COLOR = { '1': '#3fbf5f', '3': '#f2b632', '3甲': '#4fc3f7', '5': '#b48cff' };
function drawMinimap() {
  const s = MAP_SCALES[mapScaleIdx], R = MAP_PX / 2, rad = R / s;
  const c = mctx;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, MAP_PX, MAP_PX);
  c.save();
  c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.clip();
  c.fillStyle = 'rgba(14,22,18,0.88)'; c.fillRect(0, 0, MAP_PX, MAP_PX);
  const sh = Math.sin(S.h), ch = Math.cos(S.h);
  // 世界座標 -> 螢幕 (車頭朝上)
  c.setTransform(DPR * sh * s, DPR * -ch * s, DPR * -ch * s, DPR * -sh * s, DPR * R, DPR * R);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const order = [];
  for (const [key] of tilesNear(S.x, S.y, rad + 2600)) {
    const rec = TILES.get(key);
    if (rec) for (const k of rec.ways) { const w = WAYS[k]; if (w.bb[2] > S.x - rad && w.bb[0] < S.x + rad && w.bb[3] > S.y - rad && w.bb[1] < S.y + rad) order.push(w); }
  }
  order.sort((a, b) => (!!b.city - !!a.city) || (a.link - b.link) || (a.bridge - b.bridge));
  for (const pass of [0, 1]) for (const w of order) {
    c.beginPath();
    for (let i = 0; i < w.n; i++) { const x = w.P[i * 3] - S.x, y = w.P[i * 3 + 1] - S.y; i ? c.lineTo(x, y) : c.moveTo(x, y); }
    if (pass === 0) { c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = Math.max(w.width, 3.2 / s) + 2 / s; }
    else { c.strokeStyle = (HOOKS.wayColor && HOOKS.wayColor(w)) || (w.city ? (w.cls === 5 ? '#454e55' : '#66717a') : w.trunk ? (w.link ? '#c98a5a' : '#ff8c42') : w.link ? '#a7b0b8' : (REF_COLOR[w.ref] || '#ddd')); c.lineWidth = Math.max(w.width, (w.city ? (w.cls === 5 ? 1 : 1.6) : w.link ? 2 : 3.2) / s); if (w.tunnel) c.setLineDash([6 / s, 4 / s]); }
    c.stroke(); c.setLineDash([]);
  }
  for (const f of HOOKS.minimap) f(c, s, rad);
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  // 車
  c.fillStyle = '#fff'; c.strokeStyle = '#e0302a'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(R, R - 9); c.lineTo(R + 6.5, R + 7); c.lineTo(R, R + 3.5); c.lineTo(R - 6.5, R + 7); c.closePath(); c.fill(); c.stroke();
  c.restore();
  // 外框與北方
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 3; c.stroke();
  const nxs = -ch, nys = -sh; // 北方在螢幕上的方向
  const px = R + nxs * (R - 13), py = R + nys * (R - 13);
  c.fillStyle = '#e0302a'; c.beginPath(); c.arc(px, py, 9, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff'; c.font = 'bold 12px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('N', px, py + 0.5);
  c.fillStyle = 'rgba(255,255,255,0.8)'; c.font = '11px sans-serif';
  c.fillText(rad >= 1000 ? (rad / 1000).toFixed(1) + ' km' : Math.round(rad) + ' m', R, MAP_PX - 14);
}

// ======================================================================= HUD
const hudSpeed = $('speed'), hudLimit = $('limit'), hudRoad = $('road'), hudMode = $('mode');
function roadLabel(w) {
  if (!w) return '';
  if (w.city) return w.name || ['', '', '主要道路', '次要道路', '一般道路', '巷道', '匝道'][w.cls] + (w.bridge ? '（橋）' : '');
  if (w.trunk) return (w.ref ? `台${w.ref.replace(/^台|線$/g, '')}線` : '快速道路') + (w.name ? ' · ' + w.name : '') + (w.link ? ' 匝道' : '') + (w.bridge ? '（高架）' : '');
  const ref = w.ref ? `國道${w.ref}${/甲$/.test(w.ref) ? '' : '號'}` : '';
  if (w.link) return `${w.name || '交流道'}${w.name && !/匝道|交流道/.test(w.name) ? ' 匝道' : ''}`;
  return [ref, w.name].filter(Boolean).join(' · ') + (w.bridge ? '（高架）' : '') + (w.tunnel ? '（隧道）' : '');
}
function updateHud() {
  hudSpeed.textContent = Math.round(Math.abs(S.v) * 3.6);
  const w = S.road && S.road.w;
  const lim = w ? speedLimit(w) : 100;
  hudLimit.textContent = lim;
  hudRoad.textContent = roadLabel(w);
  hudMode.textContent = (S.vt ? S.vt.name + ' · ' : '') + (camMode === 1 ? '第一人稱' : camMode === 2 ? '空拍' : '第三人稱') + (autopilot ? ' · 自動駕駛' : '');
  if (S.vtype === 'scooter' && w && !w.city) hudRoad.textContent = '⚠ 機車禁止行駛國道 / 快速道路';
}

// ======================================================================= 主迴圈
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- 給擴充模組 (features.js: 車流、電台、看板) 用的介面
const HOOKS = { init: [], update: [], frame: [], minimap: [], tile: [], wayColor: null };
window.TW = { T, scene, camera, renderer, WAYS, wayByGid, TILES, TS, tilesNear, PT_INDEX, ptKey, S, LANE_W, roadAt, terrainAt, nextWay, buildCar, HOOKS, params,
  laneCount, laneOffDir, nextOptions, speedLimit, setVehicle, spawn, ORIGIN: INDEX.origin_twd97, MOBILE,
  get camMode() { return camMode; } };

setStatus('載入地圖分區…');
setTimeout(async () => {
  HOOKS.frame.push(streamFrame, cullBuildings);
  // 傳送地點 (tile_web.py 依 live.json 起點與 city_web.py SPOTS 產生，附座標)
  for (const [name, gid, idx, dir, x, y] of INDEX.spawns || []) SPAWNS.push({ name, gid, idx, dir, x, y });
  // 起點: 國1 南下 0K (基隆端)；網址 ?spawn=路段gid,點 或 ?at=x,y 可覆寫
  let sp0 = SPAWNS[0] || { x: 0, y: 0 };
  if (params.has('at')) { const [x, y] = params.get('at').split(',').map(Number); sp0 = { x, y }; }
  await ensureArea(sp0.x, sp0.y, '載入地圖分區…');
  const want = params.has('spawn') ? params.get('spawn').split(',').map(Number) : sp0.gid != null ? [sp0.gid, sp0.idx, sp0.dir] : null;
  const w0 = want && wayByGid(want[0]);
  if (w0) spawn(w0.k, want[1], want[2] || 1, params.has('lane') ? +params.get('lane') : null);   // ?lane=: 測試用
  else if (params.has('at')) { S.x = sp0.x; S.y = sp0.y; S.z = terrainAt(sp0.x, sp0.y); respawnNearest(); }
  else defaultSpawn();
  if (params.has('vehicle')) setVehicle(params.get('vehicle'));
  for (const f of HOOKS.init) f();
  if (params.has('t')) { // 測試用: 先跑幾秒
    autopilot = true; S.v = 25;
    const n = +params.get('t') * 30;
    for (let i = 0; i < n; i++) {
      if (i % 15 === 0) streamTick({ build: false });   // 內嵌分區: 同步載入資料 (不建模型)
      update(1 / 30); for (const f of HOOKS.update) f(1 / 30);
      if (params.has('trace') && i % 150 === 0 && S.rt) console.log('[trace]', (i / 30).toFixed(0) + 's', S.rt.w.k, S.rt.w.ref, S.rt.w.name, S.rt.w.link ? 'link' : '', 'dir', S.rt.dir, 'i', S.rt.i, '/', S.rt.w.n, 'v', (S.v * 3.6).toFixed(0),
        window.TWX ? (() => { let b = null, bd = 1e9; for (const c of TWX.cars) if (c.alive) { const d = Math.hypot(c.x - S.x, c.y - S.y); if (d < bd) { bd = d; b = c; } }
          return b ? `| nearest AI ${b.type} d=${bd.toFixed(1)} v=${(b.v * 3.6).toFixed(0)} w=${b.w.k} s=${b.s.toFixed(0)}/${b.w.s[b.w.n - 1].toFixed(0)} dir=${b.dir} dead=${b.deadEnd} plan=${b.plan ? (b.plan.none ? 'none' : b.plan.o.k) : '-'} dh=${(((b.h - S.h) * 180 / Math.PI) % 360).toFixed(0)}` : ''; })() : '');
    }
    autopilot = params.has('demo') || params.has('keep');
    console.log('[test] simulated', params.get('t'), 's; speed', (S.v * 3.6).toFixed(0), 'km/h; lane', S.apLane,
      '; player bumps', window.TWX ? TWX.stats.bumps : '-', '; AI overlaps', window.TWX ? TWX.overlaps() : '-',
      '; AI lane changes', window.TWX ? TWX.stats.laneChanges : '-', '; player lane changes', S.apChanges || 0,
      '; pos', S.x.toFixed(1), S.y.toFixed(1), S.z.toFixed(1), 'zVis', S.zVis, '; road', S.road ? (S.road.w.name || S.road.w.k) : null,
      '; lead', HOOKS.leader ? JSON.stringify(HOOKS.leader(0)) : '-', '; city turns', window.TWX ? TWX.stats.turns : '-', '; nan', window.TWX ? TWX.stats.nan : '-', '; joints', window.TWX ? (TWX.stats.joints || 0) : '-');
  }
  if (params.has('t')) await ensureArea(S.x, S.y);
  syncCar(0); updateCamera(1);
  $('loading').classList.add('hidden');
  let last = performance.now(), frame = 0;
  function loop(now) {
    const dt = Math.min((now - last) / 1000, params.has("realtime") ? 1.0 : 0.05); last = now;   // realtime: 背景展示用，依真實時間推進
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < sub; i++) update(dt / sub);
    for (const f of HOOKS.update) f(dt);
    syncCar(dt); updateCamera(dt);
    for (const f of HOOKS.frame) f(dt);
    renderer.render(scene, camera);
    if ((frame++ & 1) === 0) drawMinimap();
    updateHud();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}, 30);
})();
