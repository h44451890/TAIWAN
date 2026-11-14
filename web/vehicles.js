/* 台灣 1:1 — 車輛模型庫 (程序化建模)
 * 座標: +x 車頭、+y 上、+z 右側；地面 y = 0；原點在車身長度中心。
 * 每個 build() 回傳 { group, ud }，ud 標記可依車輛換色的材質 (paint 車色、accent 第二色、tail 尾燈、
 * sigL/sigR 方向燈、flashA/flashB 警示燈) 與 wheels (給玩家車轉動輪胎)。
 */
(function () {
'use strict';
const T = window.THREE;

function mats() {
  return {
    paint: new T.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 }),
    accent: new T.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.45, clearcoat: 0.5 }),
    white: new T.MeshStandardMaterial({ color: new T.Color(0.75, 0.75, 0.73), roughness: 0.5 }),
    glass: new T.MeshPhysicalMaterial({ color: new T.Color(0.012, 0.016, 0.02), metalness: 0.1, roughness: 0.04, clearcoat: 1 }),
    black: new T.MeshStandardMaterial({ color: new T.Color(0.012, 0.012, 0.013), roughness: 0.6 }),
    plastic: new T.MeshStandardMaterial({ color: new T.Color(0.035, 0.035, 0.04), roughness: 0.55 }),
    chrome: new T.MeshStandardMaterial({ color: new T.Color(0.85, 0.85, 0.88), metalness: 1, roughness: 0.15 }),
    steel: new T.MeshStandardMaterial({ color: new T.Color(0.3, 0.31, 0.33), metalness: 0.8, roughness: 0.45 }),
    tire: new T.MeshStandardMaterial({ color: new T.Color(0.02, 0.02, 0.02), roughness: 0.92 }),
    rim: new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.56, 0.58), metalness: 1, roughness: 0.3 }),
    jeans: new T.MeshStandardMaterial({ color: new T.Color(0.03, 0.05, 0.1), roughness: 0.9 }),
    skin: new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.36, 0.25), roughness: 0.8 }),
    head: new T.MeshStandardMaterial({ color: 0xffffff, emissive: new T.Color(1, 0.97, 0.9), emissiveIntensity: 1.4 }),
    tail: new T.MeshBasicMaterial({ color: new T.Color(0.5, 0.005, 0.005), toneMapped: false }),
    sigL: new T.MeshBasicMaterial({ color: new T.Color(0.18, 0.07, 0), toneMapped: false }),
    sigR: new T.MeshBasicMaterial({ color: new T.Color(0.18, 0.07, 0), toneMapped: false }),
    flashA: new T.MeshBasicMaterial({ color: new T.Color(0.3, 0, 0), toneMapped: false }),
    flashB: new T.MeshBasicMaterial({ color: new T.Color(0, 0, 0.3), toneMapped: false }),
  };
}

function ledTexture(lines, w = 512, h = 96, color = '#ffb21a') {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const x = cv.getContext('2d');
  x.fillStyle = '#050505'; x.fillRect(0, 0, w, h);
  x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle';
  const fs = lines.length > 1 ? h * 0.38 : h * 0.62;
  x.font = `700 ${fs}px "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif`;
  lines.forEach((l, i) => x.fillText(l, w / 2, lines.length > 1 ? h * (0.28 + i * 0.46) : h / 2));
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return new T.MeshBasicMaterial({ map: t, toneMapped: false });
}

class Kit {
  constructor() { this.g = new T.Group(); this.m = mats(); this.wheels = []; }
  add(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const me = new T.Mesh(geo, mat);
    me.position.set(x, y, z); me.rotation.set(rx, ry, rz);
    me.castShadow = true; me.receiveShadow = true;
    this.g.add(me); return me;
  }
  box(lx, ly, lz, mat, x, y, z, rx, ry, rz) { return this.add(new T.BoxGeometry(lx, ly, lz), mat, x, y, z, rx, ry, rz); }
  /** 圓角方塊 (長 lx 沿 x、高 ly、寬 lz)，r 為倒角 */
  rbox(lx, ly, lz, r, mat, x, y, z) {
    r = Math.min(r, lx / 2 - 0.01, ly / 2 - 0.01, lz / 2 - 0.01);
    const w = lx / 2 - r, h = ly / 2 - r, s = new T.Shape();
    const c = Math.min(r, w, h) * 0.6;
    s.moveTo(-w + c, -h); s.lineTo(w - c, -h); s.quadraticCurveTo(w, -h, w, -h + c); s.lineTo(w, h - c);
    s.quadraticCurveTo(w, h, w - c, h); s.lineTo(-w + c, h); s.quadraticCurveTo(-w, h, -w, h - c); s.lineTo(-w, -h + c);
    s.quadraticCurveTo(-w, -h, -w + c, -h);
    const geo = new T.ExtrudeGeometry(s, { depth: Math.max(lz - 2 * r, 0.01), bevelEnabled: true, bevelSize: r, bevelThickness: r, bevelSegments: 2, curveSegments: 3 });
    geo.translate(0, 0, -Math.max(lz - 2 * r, 0.01) / 2);
    geo.computeVertexNormals();
    return this.add(geo, mat, x, y, z);
  }
  cyl(r, len, mat, x, y, z, axis = 'z', seg = 20) {
    const g = new T.CylinderGeometry(r, r, len, seg);
    if (axis === 'z') g.rotateX(Math.PI / 2); else if (axis === 'x') g.rotateZ(Math.PI / 2);
    return this.add(g, mat, x, y, z);
  }
  /** 車輪: 輪胎 + 輪框 + 輪轂，dual = 雙輪 (貨車後輪) */
  wheel(x, z, r, width, front, dual = false) {
    const pivot = new T.Group(); pivot.position.set(x, r, z); this.g.add(pivot);
    const spin = new T.Group(); pivot.add(spin);
    const out = Math.sign(z) || 1, m = this.m;
    const prof = [[r * 0.62, -width / 2], [r * 0.92, -width / 2], [r, -width * 0.32], [r, width * 0.32], [r * 0.92, width / 2], [r * 0.62, width / 2]]
      .map(([a, b]) => new T.Vector2(a, b));
    const tg = new T.LatheGeometry(prof, 28); tg.rotateX(Math.PI / 2);
    const tire = new T.Mesh(tg, m.tire); tire.castShadow = true; spin.add(tire);
    const rim = new T.Mesh(new T.CylinderGeometry(r * 0.62, r * 0.62, width * 0.9, 24).rotateX(Math.PI / 2), m.rim); spin.add(rim);
    const hub = new T.Mesh(new T.CylinderGeometry(r * 0.18, r * 0.2, width * 0.3, 12).rotateX(Math.PI / 2), m.chrome);
    hub.position.z = out * width * 0.5; spin.add(hub);
    for (let k = 0; k < 6; k++) {
      const nut = new T.Mesh(new T.CylinderGeometry(r * 0.04, r * 0.04, width * 0.2, 6).rotateX(Math.PI / 2), m.steel);
      const a = k * Math.PI / 3; nut.position.set(Math.cos(a) * r * 0.32, Math.sin(a) * r * 0.32, out * width * 0.48); spin.add(nut);
    }
    if (dual) { const t2 = new T.Mesh(tg, m.tire); t2.position.z = -out * width * 0.95; spin.add(t2); }
    this.wheels.push({ pivot, spin, front, r });
    return pivot;
  }
  /** 頭燈、尾燈、方向燈 (車頭在 xf、車尾在 xr、半寬 hz) */
  lights(xf, xr, hz, yh, yt, opt = {}) {
    const m = this.m, s = opt.size || 1;
    for (const z of [-1, 1]) {
      this.box(0.06, 0.18 * s, 0.38 * s, m.head, xf, yh, z * (hz - 0.3 * s));
      this.box(0.06, 0.12 * s, 0.14 * s, z < 0 ? m.sigL : m.sigR, xf, yh - 0.17 * s, z * (hz - 0.15 * s));
      this.box(0.06, 0.32 * s, 0.22 * s, m.tail, xr, yt, z * (hz - 0.2 * s));
      this.box(0.06, 0.14 * s, 0.22 * s, z < 0 ? m.sigL : m.sigR, xr, yt + 0.25 * s, z * (hz - 0.2 * s));
      if (opt.side) this.box(0.18, 0.06, 0.02, z < 0 ? m.sigL : m.sigR, opt.side, opt.sideY || yh + 0.3, z * (hz + 0.012));
    }
  }
  mirrors(x, y, hz, arm = 0.4) {
    const m = this.m;
    for (const z of [-1, 1]) {
      this.box(0.05, 0.05, arm, m.black, x, y + 0.1, z * (hz + arm / 2));
      this.box(0.1, 0.42, 0.16, m.black, x - 0.02, y - 0.05, z * (hz + arm));
      this.box(0.01, 0.36, 0.13, m.chrome, x - 0.08, y - 0.05, z * (hz + arm));
    }
  }
  done(extra = {}) {
    const m = this.m;
    return { group: this.g, ud: Object.assign({ wheels: this.wheels, paint: m.paint, accent: m.accent, tailMat: m.tail, headMat: m.head,
      sigLMat: m.sigL, sigRMat: m.sigR, flashA: m.flashA, flashB: m.flashB }, extra) };
  }
}

// ======================================================================= 車種
const B = {};

/** 轎車 / 休旅 / 掀背: 沿用主程式的精細轎車 */
B.sedan = () => {
  const car = window.TW.buildCar();
  return { group: car, ud: car.userData };
};
/** 計程車: 黃色轎車 + 車頂燈箱 */
B.taxi = () => {
  const r = B.sedan(), g = r.group;
  const sign = new T.Mesh(new T.BoxGeometry(0.5, 0.22, 0.32), new T.MeshStandardMaterial({ color: 0xffffff, emissive: new T.Color(0.9, 0.85, 0.5), emissiveIntensity: 0.6 }));
  sign.position.set(-0.25, 1.56, 0); sign.castShadow = true; g.add(sign);
  const base = new T.Mesh(new T.BoxGeometry(0.56, 0.05, 0.36), new T.MeshStandardMaterial({ color: 0x111111 }));
  base.position.set(-0.25, 1.44, 0); g.add(base);
  return r;
};
/** 國道警察: 白色轎車 + 紅藍警示燈 + 車身藍色線條 */
B.police = () => {
  const r = B.sedan(), g = r.group, m = mats();
  const bar = new T.Mesh(new T.BoxGeometry(0.35, 0.1, 1.2), new T.MeshStandardMaterial({ color: 0x151515 }));
  bar.position.set(-0.2, 1.5, 0); g.add(bar);
  const a = new T.Mesh(new T.BoxGeometry(0.3, 0.11, 0.5), m.flashA); a.position.set(-0.2, 1.56, -0.3); g.add(a);
  const b = new T.Mesh(new T.BoxGeometry(0.3, 0.11, 0.5), m.flashB); b.position.set(-0.2, 1.56, 0.3); g.add(b);
  const stripe = new T.MeshStandardMaterial({ color: new T.Color(0.02, 0.06, 0.3), roughness: 0.4 });
  for (const z of [-1, 1]) { const s = new T.Mesh(new T.BoxGeometry(3.6, 0.12, 0.02), stripe); s.position.set(0, 0.72, z * 0.925); g.add(s); }
  r.ud.flashA = m.flashA; r.ud.flashB = m.flashB;
  return r;
};

/** 市區公車 12 m: 低地板、大片側窗、前/側 LED 路線看板、右側兩個車門 */
B.citybus = () => {
  const k = new Kit(), m = k.m, L = 12, H = 2.85, Wd = 2.5, y0 = 0.32;
  k.rbox(L, H, Wd, 0.14, m.paint, 0, y0 + H / 2, 0);
  k.box(L - 0.4, 0.42, Wd + 0.01, m.accent, -0.1, y0 + 0.75, 0);                 // 車身下緣色帶
  k.box(L - 0.6, 0.12, Wd + 0.01, m.accent, -0.2, y0 + H - 0.55, 0);             // 窗上色帶
  k.box(9.4, 1.1, Wd + 0.02, m.glass, -0.6, y0 + 1.75, 0);                       // 側窗
  for (let x = -5; x < 4.3; x += 1.25) k.box(0.06, 1.1, Wd + 0.03, m.black, x, y0 + 1.75, 0);   // 窗柱
  k.box(0.06, 1.55, Wd - 0.18, m.glass, L / 2 + 0.005, y0 + 1.5, 0);              // 前擋
  k.box(0.05, 0.7, Wd - 0.5, m.glass, -L / 2 - 0.005, y0 + 1.9, 0);              // 後窗
  const led = ledTexture(['307  台北車站']), led2 = ledTexture(['307'], 256, 96);
  k.box(0.04, 0.36, Wd - 0.4, led, L / 2 + 0.01, y0 + H - 0.28, 0);
  k.box(1.9, 0.3, 0.02, led, 3.8, y0 + H - 0.35, Wd / 2 + 0.015);
  k.box(0.02, 0.32, 0.7, led2, -L / 2 - 0.01, y0 + H - 0.35, 0);
  for (const x of [4.75, 0.3]) k.box(1.15, 2.2, 0.03, m.glass, x, y0 + 1.25, Wd / 2 + 0.012);                // 車門 (右側)
  k.rbox(3.2, 0.32, 1.7, 0.08, m.white, -1.6, y0 + H + 0.16, 0);                 // 冷氣機
  k.box(0.25, 0.4, Wd - 0.1, m.plastic, L / 2 - 0.05, y0 + 0.3, 0);              // 保險桿
  k.box(0.25, 0.4, Wd - 0.1, m.plastic, -L / 2 + 0.05, y0 + 0.3, 0);
  k.mirrors(L / 2 + 0.2, y0 + 2.3, Wd / 2, 0.35);
  k.lights(L / 2 + 0.03, -L / 2 - 0.03, Wd / 2, y0 + 0.62, y0 + 0.9, { size: 1.2, side: 4.1 });
  for (const z of [-1, 1]) { k.wheel(3.7, z * 1.03, 0.5, 0.3, true); k.wheel(-2.4, z * 0.98, 0.5, 0.3, false, true); }
  return k.done();
};
/** 國道客運 12.2 m: 高底盤、深色車窗、行李艙、斜線塗裝 */
B.coach = () => {
  const k = new Kit(), m = k.m, L = 12.2, H = 3.45, Wd = 2.5, y0 = 0.38;
  k.rbox(L, H, Wd, 0.18, m.paint, 0, y0 + H / 2, 0);
  k.box(L - 0.3, 0.5, Wd + 0.01, m.accent, -0.1, y0 + 1.25, 0);
  k.box(7, 0.18, Wd + 0.01, m.accent, -1.8, y0 + 1.75, 0);
  k.box(10.4, 1.0, Wd + 0.02, m.glass, -0.7, y0 + 2.55, 0);
  k.box(0.06, 1.75, Wd - 0.15, m.glass, L / 2 + 0.005, y0 + 2.35, 0);
  for (let x = -4.6; x < 3.4; x += 1.6) k.box(1.4, 0.75, Wd + 0.015, m.plastic, x, y0 + 0.55, 0);   // 行李艙門
  k.box(0.9, 2.1, 0.03, m.glass, 5.2, y0 + 1.5, Wd / 2 + 0.012);
  k.box(0.04, 0.34, Wd - 0.4, ledTexture(['國道客運  台北⇄台中'], 640, 96), L / 2 + 0.01, y0 + H - 0.3, 0);
  k.box(0.25, 0.45, Wd - 0.05, m.plastic, L / 2 - 0.05, y0 + 0.25, 0);
  k.box(0.25, 0.45, Wd - 0.05, m.plastic, -L / 2 + 0.05, y0 + 0.25, 0);
  k.mirrors(L / 2 + 0.25, y0 + 2.7, Wd / 2, 0.4);
  k.lights(L / 2 + 0.03, -L / 2 - 0.03, Wd / 2, y0 + 0.65, y0 + 1.0, { size: 1.2, side: 4.5, sideY: y0 + 1.0 });
  for (const z of [-1, 1]) { k.wheel(4.15, z * 1.03, 0.52, 0.32, true); k.wheel(-2.1, z * 0.98, 0.52, 0.32, false, true); k.wheel(-3.45, z * 1.03, 0.52, 0.3, false); }
  return k.done();
};
/** 小巴 7 m */
B.minibus = () => {
  const k = new Kit(), m = k.m, L = 7, H = 2.45, Wd = 2.15, y0 = 0.3;
  k.rbox(L, H, Wd, 0.16, m.paint, 0, y0 + H / 2, 0);
  k.box(L - 0.3, 0.3, Wd + 0.01, m.accent, -0.05, y0 + 0.7, 0);
  k.box(5.3, 0.85, Wd + 0.02, m.glass, -0.4, y0 + 1.6, 0);
  k.box(0.06, 1.2, Wd - 0.15, m.glass, L / 2 + 0.005, y0 + 1.45, 0);
  k.box(0.9, 1.9, 0.03, m.glass, 2.6, y0 + 1.1, Wd / 2 + 0.012);
  k.box(0.04, 0.3, Wd - 0.4, ledTexture(['小12  區間車']), L / 2 + 0.01, y0 + H - 0.25, 0);
  k.box(0.22, 0.35, Wd - 0.05, m.plastic, L / 2 - 0.05, y0 + 0.25, 0);
  k.box(0.22, 0.35, Wd - 0.05, m.plastic, -L / 2 + 0.05, y0 + 0.25, 0);
  k.mirrors(L / 2 - 0.1, y0 + 1.7, Wd / 2, 0.25);
  k.lights(L / 2 + 0.03, -L / 2 - 0.03, Wd / 2, y0 + 0.6, y0 + 0.9, { side: 2.2 });
  for (const z of [-1, 1]) { k.wheel(2.3, z * 0.9, 0.4, 0.24, true); k.wheel(-2.1, z * 0.9, 0.4, 0.24, false); }
  return k.done();
};
/** 3.5 噸廂型貨車 7 m: 車頭 (車色) + 貨箱 (第二色) */
B.boxtruck = () => {
  const k = new Kit(), m = k.m;
  k.rbox(1.95, 2.0, 2.1, 0.14, m.paint, 2.52, 0.48 + 1.0, 0);                   // 駕駛室
  k.box(0.05, 0.8, 1.9, m.glass, 3.5, 1.98, 0);
  for (const z of [-1, 1]) k.box(0.9, 0.65, 0.02, m.glass, 2.85, 2.0, z * 1.06);
  k.box(0.22, 0.4, 2.05, m.plastic, 3.45, 0.62, 0);                             // 保險桿
  k.box(0.3, 0.3, 2.0, m.black, 3.4, 1.15, 0);                                   // 水箱罩
  k.rbox(5.0, 2.55, 2.25, 0.05, m.accent, -0.92, 0.95 + 1.27, 0);                // 貨箱
  k.box(0.04, 2.4, 2.1, m.steel, -3.43, 2.22, 0);                               // 後門
  for (const z of [-0.5, 0.5]) k.box(0.05, 2.3, 0.04, m.chrome, -3.46, 2.22, z);
  k.box(6.6, 0.18, 0.9, m.steel, -0.1, 0.62, 0);                                 // 底盤
  k.mirrors(3.2, 2.05, 1.05, 0.25);
  k.lights(3.53, -3.47, 1.05, 0.8, 0.75, { side: 2.0 });
  for (const z of [-1, 1]) { k.wheel(2.55, z * 0.88, 0.42, 0.24, true); k.wheel(-1.9, z * 0.84, 0.42, 0.24, false, true); }
  return k.done();
};
/** 大貨車 11 m: 車頭 + 帆布貨斗，三軸 */
B.bigtruck = () => {
  const k = new Kit(), m = k.m;
  k.rbox(2.3, 2.75, 2.45, 0.15, m.paint, 4.35, 0.6 + 1.37, 0);
  k.box(0.05, 1.0, 2.2, m.glass, 5.5, 2.55, 0);
  for (const z of [-1, 1]) k.box(1.0, 0.8, 0.02, m.glass, 4.8, 2.55, z * 1.235);
  k.box(0.3, 0.6, 2.4, m.chrome, 5.45, 1.25, 0);
  k.box(0.25, 0.4, 2.4, m.plastic, 5.45, 0.65, 0);
  k.rbox(1.6, 0.4, 2.2, 0.1, m.paint, 4.2, 3.55, 0);                            // 導流罩
  k.box(8.0, 0.35, 2.5, m.steel, -1.5, 1.15, 0);                                 // 貨斗底板
  k.rbox(8.0, 2.6, 2.5, 0.06, m.accent, -1.5, 1.33 + 1.3, 0);                    // 帆布
  for (let x = -5.2; x <= 2.2; x += 1.2) k.box(0.05, 2.62, 2.52, m.steel, x, 2.63, 0);     // 帆布骨架
  k.box(10.4, 0.25, 1.0, m.steel, -0.2, 0.8, 0);
  k.mirrors(5.1, 2.6, 1.22, 0.3);
  k.lights(5.58, -5.53, 1.22, 0.85, 0.95, { size: 1.15, side: 3.6, sideY: 1.4 });
  for (const z of [-1, 1]) { k.wheel(4.3, z * 1.05, 0.52, 0.32, true); k.wheel(-2.3, z * 1.0, 0.52, 0.3, false, true); k.wheel(-3.65, z * 1.0, 0.52, 0.3, false, true); }
  return k.done();
};
/** 聯結車: 曳引車 6.2 m (另有拖車) */
B.semiTractor = () => {
  const k = new Kit(), m = k.m;
  k.rbox(2.2, 2.9, 2.45, 0.16, m.paint, 2.0, 0.65 + 1.45, 0);
  k.box(0.05, 1.05, 2.2, m.glass, 3.11, 2.75, 0);
  for (const z of [-1, 1]) k.box(0.95, 0.8, 0.02, m.glass, 2.45, 2.7, z * 1.235);
  k.box(0.3, 0.7, 2.4, m.chrome, 3.05, 1.35, 0);
  k.box(0.25, 0.4, 2.4, m.plastic, 3.05, 0.65, 0);
  k.rbox(1.7, 0.55, 2.3, 0.12, m.paint, 1.9, 3.85, 0);
  k.box(5.8, 0.3, 1.0, m.steel, -0.2, 0.85, 0);
  k.cyl(0.55, 0.12, m.steel, -1.0, 1.22, 0, 'y', 20);                            // 第五輪
  for (const z of [-1, 1]) { k.cyl(0.3, 1.1, m.chrome, 0.4, 0.75, z * 0.95, 'x', 16); k.cyl(0.08, 2.0, m.chrome, 0.7, 2.6, z * 1.1, 'y', 10); }  // 油箱、排氣管
  k.mirrors(2.75, 2.75, 1.22, 0.3);
  k.lights(3.18, -3.05, 1.22, 0.85, 0.9, { size: 1.1 });
  for (const z of [-1, 1]) { k.wheel(2.0, z * 1.05, 0.52, 0.32, true); k.wheel(-1.25, z * 1.0, 0.52, 0.3, false, true); k.wheel(-2.55, z * 1.0, 0.52, 0.3, false, true); }
  return k.done();
};
/** 聯結車拖車 12.2 m 貨櫃 (第二色) */
B.semiTrailer = () => {
  const k = new Kit(), m = k.m;
  k.box(12.0, 0.3, 1.1, m.steel, 0, 1.0, 0);
  k.box(12.2, 0.12, 2.45, m.steel, 0, 1.25, 0);
  k.box(12.2, 2.6, 2.45, m.accent, 0, 1.31 + 1.3, 0);
  for (let x = -5.8; x <= 5.8; x += 0.58) for (const z of [-1, 1]) k.box(0.12, 2.5, 0.03, m.accent, x, 2.61, z * 1.235);  // 浪板
  k.box(0.03, 2.5, 2.4, m.steel, -6.11, 2.61, 0);
  for (const z of [-0.6, 0.6]) k.box(0.05, 2.4, 0.05, m.chrome, -6.14, 2.61, z);
  for (const z of [-0.8, 0.8]) k.box(0.1, 1.0, 0.1, m.steel, 3.6, 0.5, z);      // 支撐腳
  for (const z of [-1, 1]) { k.box(0.06, 0.25, 0.4, m.tail, -6.13, 0.95, z * 1.0); k.box(0.06, 0.12, 0.25, z < 0 ? m.sigL : m.sigR, -6.13, 1.17, z * 1.0); }
  for (const z of [-1, 1]) { k.wheel(-3.9, z * 1.0, 0.52, 0.3, false, true); k.wheel(-5.2, z * 1.0, 0.52, 0.3, false, true); }
  return k.done();
};
/** 機車 + 騎士 */
B.scooter = () => {
  const k = new Kit(), m = k.m;
  k.rbox(1.25, 0.42, 0.52, 0.14, m.paint, -0.12, 0.5, 0);                         // 車身
  k.rbox(0.26, 0.72, 0.48, 0.08, m.paint, 0.58, 0.66, 0);                          // 前擋
  k.box(0.5, 0.06, 0.38, m.plastic, 0.25, 0.33, 0);                               // 腳踏板
  k.rbox(0.7, 0.12, 0.32, 0.05, m.black, -0.25, 0.78, 0);                         // 座墊
  k.box(0.08, 0.05, 0.66, m.black, 0.6, 1.05, 0);                                  // 把手
  k.box(0.05, 0.12, 0.18, m.head, 0.72, 0.92, 0);
  k.box(0.04, 0.06, 0.16, m.tail, -0.76, 0.62, 0);
  for (const z of [-1, 1]) { k.box(0.04, 0.04, 0.06, z < 0 ? m.sigL : m.sigR, 0.66, 0.95, z * 0.3); k.box(0.04, 0.04, 0.05, z < 0 ? m.sigL : m.sigR, -0.74, 0.66, z * 0.15); }
  // 騎士
  for (const z of [-1, 1]) {
    k.box(0.5, 0.17, 0.17, m.jeans, 0.0, 0.88, z * 0.14);                         // 大腿
    k.box(0.15, 0.45, 0.14, m.jeans, 0.24, 0.6, z * 0.17);                        // 小腿
    k.box(0.5, 0.1, 0.1, m.accent, 0.3, 1.22, z * 0.24, 0, 0, -0.35);             // 手臂
  }
  k.rbox(0.32, 0.62, 0.42, 0.1, m.accent, -0.12, 1.2, 0).rotation.z = -0.25;      // 上身 (外套)
  const helm = k.add(new T.SphereGeometry(0.15, 16, 12), m.paint, -0.02, 1.62, 0);
  helm.scale.set(1.15, 1, 1);
  k.box(0.02, 0.08, 0.2, m.glass, 0.13, 1.6, 0);
  k.wheel(0.62, 0, 0.27, 0.12, true); k.wheel(-0.62, 0, 0.27, 0.13, false);
  return k.done();
};

// ======================================================================= 參數
// len 全長、front/rear 從車身中心到前後端、wid 寬、wb 軸距、acc 加速度、vmax 極速 (m/s)、
// eye 駕駛視點、cam 第三人稱距離倍率、name 顯示名稱
const TYPES = {
  sedan: { name: '轎車', len: 4.7, wid: 1.85, wb: 2.8, acc: 1.5, vmax: 45, eye: [0.1, 1.2, -0.37], cam: 1 },
  taxi: { name: '計程車', len: 4.7, wid: 1.85, wb: 2.8, acc: 1.5, vmax: 42, eye: [0.1, 1.2, -0.37], cam: 1 },
  police: { name: '國道警察', len: 4.7, wid: 1.85, wb: 2.8, acc: 1.9, vmax: 50, eye: [0.1, 1.2, -0.37], cam: 1 },
  citybus: { name: '市區公車', len: 12, wid: 2.5, wb: 6.1, acc: 0.9, vmax: 22, eye: [5.6, 2.3, -0.8], cam: 1.9 },
  coach: { name: '國道客運', len: 12.2, wid: 2.5, wb: 6.25, acc: 0.85, vmax: 30, eye: [5.6, 2.7, -0.8], cam: 1.9 },
  minibus: { name: '小巴', len: 7, wid: 2.15, wb: 4.4, acc: 1.1, vmax: 25, eye: [2.9, 1.85, -0.6], cam: 1.35 },
  boxtruck: { name: '3.5 噸貨車', len: 7, wid: 2.25, wb: 4.45, acc: 1.0, vmax: 25, eye: [2.8, 2.0, -0.55], cam: 1.4 },
  bigtruck: { name: '大貨車', len: 11.1, wid: 2.5, wb: 7.3, acc: 0.75, vmax: 25, eye: [4.8, 2.6, -0.7], cam: 1.8 },
  semi: { name: '聯結車', len: 6.3, wid: 2.5, wb: 3.9, acc: 0.65, vmax: 25, eye: [2.5, 2.7, -0.7], cam: 2.2,
    trailer: { type: 'semiTrailer', hitch: 1.0, kingpin: 5.0, len: 12.2 } },
  scooter: { name: '機車', len: 1.9, wid: 0.75, wb: 1.24, acc: 2.4, vmax: 18, eye: [-0.05, 1.55, 0], cam: 0.7, lean: true },
};
// 拖車的後端延伸 (從曳引車中心): hitch + kingpin + 半長
for (const t of Object.values(TYPES)) {
  t.front = t.len / 2;
  t.rear = t.trailer ? t.trailer.hitch + t.trailer.kingpin + t.trailer.len / 2 : t.len / 2;
}
const BUILD = { sedan: B.sedan, taxi: B.taxi, police: B.police, citybus: B.citybus, coach: B.coach, minibus: B.minibus,
  boxtruck: B.boxtruck, bigtruck: B.bigtruck, semi: B.semiTractor, semiTrailer: B.semiTrailer, scooter: B.scooter };

window.TWV = { TYPES, build: (name) => BUILD[name](), ledTexture };
})();
