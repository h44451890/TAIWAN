"""一般道路 + 3D 建築 -> 網頁資料 (由 export_web.py 呼叫)。

道路高度取自網頁同一張地形網格 (整平後)，所以路面一定貼合畫面上的地形；
匝道接一般道路的地方，路面高度往國道端點平順過渡；橋梁以 5% 坡道抬升；隧道段不輸出。
"""
import json
import math
import os
import re

import numpy as np

CITY_CLASS = {"primary": 2, "secondary": 3, "tertiary": 4, "residential": 5, "unclassified": 5, "living_street": 5,
              "primary_link": 6, "secondary_link": 6, "tertiary_link": 6}
SKIP_BUILDING = {"roof", "carport", "canopy", "bridge", "ruins", "no", "grandstand", "shelter"}


def city_props(tags):
    hw = tags.get("highway", "")
    cls = CITY_CLASS.get(hw)
    ow = tags.get("oneway")
    oneway = ow in ("yes", "true", "1", "-1")
    try:
        lanes = int(str(tags.get("lanes", "")).split(";")[0])
    except ValueError:
        lanes = {2: 4, 3: 4, 4: 2, 5: 2, 6: 1}[cls]
        if oneway and cls in (2, 3):
            lanes = 2
        elif oneway:
            lanes = 1
    lanes = max(1, min(lanes, 8))
    lw = 2.9 if cls == 5 else 3.25
    width = lanes * lw + 0.6
    if cls == 5 and not oneway:
        width = max(width, 6.0)
    return cls, oneway, lanes, width, tags.get("oneway") == "-1"


def catmull(P, step=20.0):
    """單一路段的向心 Catmull-Rom 加密 (端點直線外插)。"""
    n = len(P)
    if n < 2:
        return P
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = [P[0]]
    for i in range(n - 1):
        P0, P1, P2, P3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        seg = float(np.linalg.norm(P2 - P1))
        a_, b_ = P1 - P0, P3 - P2
        ca = float(np.dot(a_, b_) / ((np.linalg.norm(a_) * np.linalg.norm(b_)) or 1.0))
        ang = math.degrees(math.acos(max(-1.0, min(1.0, ca))))
        k = max(1, int(math.ceil(seg / step)), min(int(math.ceil(ang / 4.0)), int(seg / 1.5)))   # 直線段疏、彎道密
        if k > 1:
            t0 = 0.0
            t1 = t0 + max(np.linalg.norm(P1 - P0) ** 0.5, 1e-4)
            t2 = t1 + max(np.linalg.norm(P2 - P1) ** 0.5, 1e-4)
            t3 = t2 + max(np.linalg.norm(P3 - P2) ** 0.5, 1e-4)
            t = (t1 + (t2 - t1) * (np.arange(1, k) / k))[:, None]
            A1 = (t1 - t) / (t1 - t0) * P0 + (t - t0) / (t1 - t0) * P1
            A2 = (t2 - t) / (t2 - t1) * P1 + (t - t1) / (t2 - t1) * P2
            A3 = (t3 - t) / (t3 - t2) * P2 + (t - t2) / (t3 - t2) * P3
            B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2
            B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3
            out.extend((t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2)
        out.append(P2)
    return np.array(out)


def build(DATA, local_xy, GZ, X0, Y0, STEP, fwy_ways):
    """回傳 (blob bytes, meta dict)；GZ 會就地整平。"""
    H, W = GZ.shape

    def terrain(x, y):
        fj = np.clip((x - X0) / STEP, 0, W - 1.001)
        fi = np.clip((y - Y0) / STEP, 0, H - 1.001)
        j, i = fj.astype(int), fi.astype(int)
        u, v = fj - j, fi - i
        return ((1 - v) * ((1 - u) * GZ[i, j] + u * GZ[i, j + 1]) + v * ((1 - u) * GZ[i + 1, j] + u * GZ[i + 1, j + 1]))

    # ---- 國道點 (接頭高度用)
    FP = np.concatenate([np.array(w["pts"]) for w in fwy_ways])

    # ---- 一般道路
    osm = json.load(open(os.path.join(DATA, "taipei_city.json"), encoding="utf-8"))
    roads = []
    for el in osm["elements"]:
        g = el.get("geometry") or []
        if len(g) < 2 or any(p is None for p in g):
            continue
        tags = el.get("tags", {})
        if tags.get("tunnel") not in (None, "no") or tags.get("area") == "yes":
            continue
        cls, oneway, lanes, width, rev = city_props(tags)
        if cls is None:
            continue
        lat = np.array([p["lat"] for p in g]); lon = np.array([p["lon"] for p in g])
        if rev:
            lat, lon = lat[::-1], lon[::-1]
        x, y = local_xy(lat, lon)
        P = catmull(np.c_[x, y])
        keep = (P[:, 0] > X0 + 30) & (P[:, 0] < X0 + (W - 2) * STEP) & (P[:, 1] > Y0 + 30) & (P[:, 1] < Y0 + (H - 2) * STEP)
        if keep.sum() < 2:
            continue
        P = P[keep] if not keep.all() else P
        bridge = tags.get("bridge") not in (None, "no")
        try:
            layer = int(tags.get("layer", "1" if bridge else "0"))
        except ValueError:
            layer = 1 if bridge else 0
        roads.append(dict(P=P, cls=cls, oneway=oneway, lanes=lanes, width=width, bridge=bridge, layer=layer,
                          name=tags.get("name", "") or tags.get("ref", "")))
    # 路面高度: 地形 (沿線平滑)；橋梁: 兩端之間內插 + 坡道抬升
    for r in roads:
        P = r["P"]
        z = terrain(P[:, 0], P[:, 1])
        if len(z) >= 5:
            zp = np.r_[z[0], z[0], z, z[-1], z[-1]]
            z = np.convolve(zp, np.ones(5) / 5, mode="valid")
        if r["bridge"]:
            s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
            t = s / max(s[-1], 1e-3)
            base = z[0] + (z[-1] - z[0]) * t
            lift = np.minimum(max(r["layer"], 1) * 5.5, 0.05 * np.minimum(s, s[-1] - s))
            z = np.maximum(base + lift, z)
        r["z"] = z
    # 匝道接一般道路: 端點 12 m 內有國道點 -> 往國道高度平順過渡 (40 m)
    fk = {}
    for i, (x, y) in enumerate(FP[:, :2]):
        fk.setdefault((int(x // 12), int(y // 12)), []).append(i)

    def near_fwy(x, y):
        best, bd = None, 12.0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in fk.get((int(x // 12) + dx, int(y // 12) + dy), ()):
                    d = math.hypot(FP[i, 0] - x, FP[i, 1] - y)
                    if d < bd:
                        bd, best = d, FP[i, 2]
        return best

    joined = 0
    for r in roads:
        P, z = r["P"], r["z"]
        s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
        for end, dist in ((0, s), (len(P) - 1, s[-1] - s)):
            zf = near_fwy(P[end, 0], P[end, 1])
            if zf is not None and abs(zf - z[end]) > 0.05:
                w_ = np.clip(1 - dist / 40.0, 0, 1)
                z += (zf - 0.15 - z[end]) * w_ * w_ * (3 - 2 * w_)
                joined += 1
    # 地形整平: 地面一般道路底下的格點往下壓到路面下 0.25 m
    gp = np.concatenate([np.c_[r["P"], r["z"], np.full(len(r["P"]), r["width"] / 2)] for r in roads if not r["bridge"]])
    fi = np.round((gp[:, 1] - Y0) / STEP).astype(int)
    fj = np.round((gp[:, 0] - X0) / STEP).astype(int)
    flat = GZ.ravel()
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            ii, jj = fi + di, fj + dj
            ok = (ii >= 0) & (ii < H) & (jj >= 0) & (jj < W)
            cx, cy = X0 + jj[ok] * STEP, Y0 + ii[ok] * STEP
            d = np.hypot(cx - gp[ok, 0], cy - gp[ok, 1])
            near = d < gp[ok, 3] + 8
            cell = (ii[ok] * W + jj[ok])[near]
            np.minimum.at(flat, cell, gp[ok, 2][near] - 0.25)
    # 整平後重新貼一次地面道路 (保留橋與接頭的高度)
    for r in roads:
        if not r["bridge"]:
            r["z"] = np.maximum(r["z"], terrain(r["P"][:, 0], r["P"][:, 1]) + 0.05)
        r["z"] = r["z"] + 0.3

    # ---- 建築
    blds = []
    bdir = os.path.join(DATA, "buildings")
    seen = set()
    for f in sorted(os.listdir(bdir)) if os.path.isdir(bdir) else []:
        for el in json.load(open(os.path.join(bdir, f), encoding="utf-8"))["elements"]:
            if el["id"] in seen:
                continue
            seen.add(el["id"])
            g = el.get("geometry") or []
            tags = el.get("tags", {})
            if len(g) < 4 or tags.get("building") in SKIP_BUILDING or any(p is None for p in g):
                continue
            # 地下街、地下停車場、捷運站等地底建築不蓋在地面上
            if (str(tags.get("layer", "0")).startswith("-") or tags.get("location") in ("underground", "indoor")
                    or (str(tags.get("building:levels", "")).strip() == "0" and not tags.get("height"))):
                continue
            lat = np.array([p["lat"] for p in g]); lon = np.array([p["lon"] for p in g])
            if abs(lat[0] - lat[-1]) < 1e-9 and abs(lon[0] - lon[-1]) < 1e-9:
                lat, lon = lat[:-1], lon[:-1]
            if len(lat) < 3 or len(lat) > 400:
                continue
            x, y = local_xy(lat, lon)
            if x.min() < X0 + 30 or x.max() > X0 + (W - 2) * STEP or y.min() < Y0 + 30 or y.max() > Y0 + (H - 2) * STEP:
                continue
            area = 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
            if abs(area) < 12:
                continue
            if area < 0:
                x, y = x[::-1], y[::-1]
            h = None
            m = re.match(r"[\d.]+", str(tags.get("height", "")))
            if m:
                try:
                    h = float(m.group(0))
                except ValueError:
                    h = None
            if h is None:
                try:
                    h = float(str(tags.get("building:levels", "")).split(";")[0]) * 3.2 + 1.0
                except ValueError:
                    h = (4 if abs(area) > 200 else 3) * 3.2 + 1.0
            h = float(min(max(h, 3.0), 520.0))
            base = float(terrain(x, y).min()) - 0.3
            blds.append((x, y, base, h, el["id"] % 7))
    nbv = sum(len(b[0]) for b in blds)

    # ---- 打包
    # 道路點: 每條路第一點 Float32，其餘相對座標 Int16 (0.1 m)；高度 Int16 (0.1 m)。超過 ±3.2 km 的路切段
    split = []
    for r in roads:
        P, z = r["P"], r["z"]
        stack = [(0, len(P))]
        while stack:
            a_, b_ = stack.pop()
            off = (P[a_:b_] - P[a_]) * 10
            if np.abs(off).max() > 32000 and b_ - a_ > 3:
                m_ = (a_ + b_) // 2
                stack += [(m_ - 1, b_), (a_, m_)]
                continue
            split.append(dict(r, P=P[a_:b_], z=z[a_:b_]))
    roads = split
    counts = np.array([len(r["P"]) for r in roads], np.int32)
    pts = np.concatenate([np.c_[r["P"], r["z"]] for r in roads])
    xy0 = np.array([r["P"][0] for r in roads], np.float32)
    roff = np.concatenate([np.round((r["P"] - r["P"][0]) * 10) for r in roads]).astype(np.int16)
    rz = np.round(pts[:, 2] * 10).astype(np.int16)
    # 建築頂點: 每棟第一點存 Float32，其餘存相對第一點的 Int16 (0.1 m)，省一半空間
    bxy0 = np.array([[b[0][0], b[1][0]] for b in blds], np.float32).reshape(-1, 2)
    boff = np.concatenate([np.c_[np.round((b[0] - b[0][0]) * 10), np.round((b[1] - b[1][0]) * 10)] for b in blds]) if blds else np.zeros((0, 2))
    boff = np.clip(boff, -32767, 32767).astype(np.int16)
    bbase = np.array([b[2] for b in blds], np.float32)
    bh = np.array([b[3] for b in blds], np.float32)
    bcnt = np.array([len(b[0]) for b in blds], np.uint16)
    bcol = np.array([b[4] for b in blds], np.uint8)
    blob = b"".join([counts.tobytes(), xy0.tobytes(), bxy0.tobytes(), bbase.tobytes(), bh.tobytes(),
                     roff.tobytes(), rz.tobytes(), boff.tobytes(), bcnt.tobytes(), bcol.tobytes()])
    # ---- 傳送地點: [名稱, 種類, 路段索引, 點索引, 方向]
    SPOTS = [("台北101 · 信義路", 25.0334, 121.5638, "city", None), ("台北車站 · 忠孝西路", 25.0463, 121.5168, "city", None),
             ("西門町 · 中華路", 25.0425, 121.5073, "city", None), ("大直 · 北安路", 25.0807, 121.5470, "city", None),
             ("板橋車站 · 縣民大道", 25.0140, 121.4640, "city", None), ("新店 · 北新路", 24.9790, 121.5410, "city", None),
             ("建國高架", 25.0420, 121.5370, "fwy", "建國"), ("市民大道高架", 25.0448, 121.5300, "fwy", "市民大道"),
             ("環東大道", 25.0560, 121.6000, "fwy", "環東"), ("台64 八里新店線", 25.0050, 121.4900, "fwy", "八里新店"),
             ("水源快速道路", 25.0170, 121.5200, "fwy", "水源"), ("國3 碧潭橋", 24.9588, 121.5394, "fwy", "碧潭")]
    spawns = []
    for name, la, lo, kind, key in SPOTS:
        tx, ty = local_xy(np.array([la]), np.array([lo]))
        tx, ty = float(tx[0]), float(ty[0])
        best = None
        if kind == "city":
            for k, r in enumerate(roads):
                if r["cls"] not in (2, 3) or r["bridge"] or len(r["P"]) < 3:
                    continue
                d = np.hypot(r["P"][:, 0] - tx, r["P"][:, 1] - ty)
                i = int(d.argmin())
                if best is None or d[i] < best[0]:
                    best = (d[i], k, min(max(i, 0), len(r["P"]) - 2))
        else:
            for k, w in enumerate(fwy_ways):
                if not w["name"] or key not in w["name"] or str(w["highway"]).endswith("_link") or w["tunnel"]:
                    continue
                P = np.array(w["pts"])
                d = np.hypot(P[:, 0] - tx, P[:, 1] - ty)
                i = int(d.argmin())
                if best is None or d[i] < best[0]:
                    best = (d[i], k, min(max(i, 0), len(P) - 2))
        if best and best[0] < 1500:
            spawns.append([name, kind, best[1], best[2], 1])
    meta_spawns = spawns
    meta = dict(nways=len(roads), npts=int(len(pts)), nb=len(blds), nbv=int(nbv), spawns=meta_spawns,
                ways=[[r["cls"], r["lanes"], int(r["oneway"]), round(r["width"], 2), int(r["bridge"]), r["name"]] for r in roads])
    print(f"city roads {len(roads)} ({len(pts)} pts, {joined} ends joined to freeway), buildings {len(blds)} ({nbv} verts), blob {len(blob) / 1e6:.2f} MB")
    return blob, meta
