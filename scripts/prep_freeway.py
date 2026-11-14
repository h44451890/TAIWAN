"""國道資料前處理：OSM + 地形 -> 給 Blender 用的 1:1 公尺座標資料。

輸入
  data/taipei_fwy.json   Overpass 匯出 (highway=motorway|motorway_link, out geom tags)
  data/terrain/*.png     Terrarium 地形圖磚 (fetch_terrain.py)
輸出
  data/freeway_prep.json 每條路段的 [x, y, z] 點、寬度、車道、橋/隧道資訊
  data/terrain_grid.npz  地形網格 X, Y, Z (公尺, 已依路面整平)

座標系統: TWD97 / TM2 (EPSG:3826) 再減去 ORIGIN，單位公尺，1 Blender 單位 = 1 公尺。
"""
import glob
import heapq
import json
import math
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

BBOX = (24.95, 121.40, 25.11, 121.70)  # 南, 西, 北, 東
GRID_STEP_DEG = 0.0003                 # 地形網格約 30 m
DENSIFY_M = 8.0                        # 路線加密間距
LANE_W = 3.75                          # 國道車道寬
LAYER_H = 7.0                          # 每一層高架的高度差
MAX_GRADE = 0.04                       # 高架引道最大坡度
SMOOTH_LEN = 80.0                      # 路面縱斷面平滑長度 (m)
TERRAIN_ZOOM = 13

# ---------------------------------------------------------------- 投影 TWD97 TM2
_A = 6378137.0
_F = 1 / 298.257222101
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_K0, _LON0, _FE = 0.9999, 121.0, 250000.0


def tm2(lat, lon):
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    phi = np.radians(lat)
    lam = np.radians(lon - _LON0)
    s, c = np.sin(phi), np.cos(phi)
    N = _A / np.sqrt(1 - _E2 * s * s)
    T = np.tan(phi) ** 2
    C = _EP2 * c * c
    A = c * lam
    e2, e4, e6 = _E2, _E2 ** 2, _E2 ** 3
    M = _A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
              - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * np.sin(2 * phi)
              + (15 * e4 / 256 + 45 * e6 / 1024) * np.sin(4 * phi)
              - (35 * e6 / 3072) * np.sin(6 * phi))
    x = _FE + _K0 * N * (A + (1 - T + C) * A ** 3 / 6
                         + (5 - 18 * T + T * T + 72 * C - 58 * _EP2) * A ** 5 / 120)
    y = _K0 * (M + N * np.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
                                       + (61 - 58 * T + T * T + 600 * C - 330 * _EP2) * A ** 6 / 720))
    return x, y


_ox, _oy = tm2((BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2)
ORIGIN = (float(round(float(_ox), -2)), float(round(float(_oy), -2)))


def local_xy(lat, lon):
    x, y = tm2(lat, lon)
    return x - ORIGIN[0], y - ORIGIN[1]


def inverse_local(x, y, lat0=25.03, lon0=121.55):
    """local_xy 的反算 (牛頓法)。"""
    x = np.asarray(x, np.float64)
    y = np.asarray(y, np.float64)
    lat = np.full_like(x, lat0)
    lon = np.full_like(x, lon0)
    for _ in range(6):
        fx, fy = local_xy(lat, lon)
        h = 1e-6
        ax, ay = local_xy(lat + h, lon)
        bx, by = local_xy(lat, lon + h)
        j11, j21 = (ax - fx) / h, (ay - fy) / h
        j12, j22 = (bx - fx) / h, (by - fy) / h
        rx, ry = x - fx, y - fy
        det = j11 * j22 - j12 * j21
        lat = lat + (j22 * rx - j12 * ry) / det
        lon = lon + (-j21 * rx + j11 * ry) / det
    return lat, lon


# ---------------------------------------------------------------- 地形
class DEM:
    def __init__(self, folder, z):
        self.z = z
        tiles = {}
        for p in glob.glob(os.path.join(folder, f"{z}_*_*.png")):
            _, x, y = os.path.splitext(os.path.basename(p))[0].split("_")
            tiles[(int(x), int(y))] = p
        xs = sorted({k[0] for k in tiles})
        ys = sorted({k[1] for k in tiles})
        self.x0, self.y0 = xs[0], ys[0]
        H, W = len(ys) * 256, len(xs) * 256
        self.h = np.zeros((H, W), np.float32)
        for (x, y), p in tiles.items():
            a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
            e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
            r, c = (y - self.y0) * 256, (x - self.x0) * 256
            self.h[r:r + 256, c:c + 256] = e

    def sample(self, lat, lon):
        lat = np.asarray(lat, np.float64)
        lon = np.asarray(lon, np.float64)
        n = 2 ** self.z * 256
        px = (lon + 180) / 360 * n - self.x0 * 256 - 0.5
        py = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n - self.y0 * 256 - 0.5
        H, W = self.h.shape
        px = np.clip(px, 0, W - 1.001)
        py = np.clip(py, 0, H - 1.001)
        i0, j0 = np.floor(py).astype(int), np.floor(px).astype(int)
        fy, fx = py - i0, px - j0
        h = self.h
        return ((1 - fy) * ((1 - fx) * h[i0, j0] + fx * h[i0, j0 + 1])
                + fy * ((1 - fx) * h[i0 + 1, j0] + fx * h[i0 + 1, j0 + 1]))


# ---------------------------------------------------------------- 路段屬性
def is_yes(v):
    return v is not None and v not in ("no", "false", "0")


def way_props(tags):
    hw = tags.get("highway")
    link = str(hw).endswith("_link")
    trunk = str(hw).startswith("trunk")
    ow = tags.get("oneway")
    oneway = ow in ("yes", "true", "1", "-1") or (ow is None and hw in ("motorway", "motorway_link"))
    try:
        lanes = int(str(tags.get("lanes", "")).split(";")[0])
    except ValueError:
        lanes = 1 if link else (2 if trunk else 3)
    lanes = max(1, lanes)
    bridge = is_yes(tags.get("bridge"))
    tunnel = is_yes(tags.get("tunnel"))
    if oneway:
        ls, rs = ((0.5, 1.0) if trunk else ((1.0, 2.5) if link else (1.0, 3.0)))   # 快速道路路肩較窄
    else:
        ls, rs = (1.0, 1.0) if trunk else (3.0, 3.0)
    try:
        layer = int(tags.get("layer", "1" if bridge else "0"))
    except ValueError:
        layer = 1 if bridge else 0
    return dict(link=link, oneway=oneway, lanes=lanes, ls=ls, rs=rs,
                width=ls + lanes * LANE_W + rs, bridge=bridge, tunnel=tunnel, layer=layer,
                reverse=tags.get("oneway") == "-1")


# ---------------------------------------------------------------- 稀疏線性系統 (CG)
def solve_cg(n, ei, ej, ew, dterm, rhs, x0, iters=20000, tol=1e-7):
    D = np.bincount(ei, ew, n) + np.bincount(ej, ew, n) + dterm + 1e-6
    rhs = rhs + 1e-6 * x0

    def A(x):
        return D * x - np.bincount(ei, ew * x[ej], n) - np.bincount(ej, ew * x[ei], n)

    x = x0.copy()
    r = rhs - A(x)
    Minv = 1.0 / D
    z = Minv * r
    p = z.copy()
    rz = r @ z
    nb = np.linalg.norm(rhs)
    for k in range(iters):
        Ap = A(p)
        a = rz / (p @ Ap)
        x += a * p
        r -= a * Ap
        if np.linalg.norm(r) < tol * nb:
            break
        z = Minv * r
        rz2 = r @ z
        p = z + (rz2 / rz) * p
        rz = rz2
    print(f"  CG {k + 1} iterations")
    return x


MEDIAN_W = 1.0   # 雙向車道路緣之間至少留的中央分隔寬度 (m)
CLEARANCE = 6.5  # 立體交叉: 上層路面至少高出下層 5 m 淨高 + 1.5 m 梁深
CLEAR_GRADE = 0.05  # 為了淨空墊高時的最大坡度


def pairs_within(AX, AY, BX, BY, R):
    """回傳所有距離 < R 的 (i, j) 配對 (A 的第 i 點、B 的第 j 點)，網格雜湊。"""
    AX, AY, BX, BY = (np.asarray(v, np.float64) for v in (AX, AY, BX, BY))
    K = 1000003
    cb = np.floor(BX / R).astype(np.int64) * K + np.floor(BY / R).astype(np.int64)
    order = np.argsort(cb, kind="stable")
    cbs = cb[order]
    ax, ay = np.floor(AX / R).astype(np.int64), np.floor(AY / R).astype(np.int64)
    I, J = [], []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            key = (ax + dx) * K + (ay + dy)
            lo = np.searchsorted(cbs, key, "left")
            hi = np.searchsorted(cbs, key, "right")
            cnt = hi - lo
            tot = int(cnt.sum())
            if not tot:
                continue
            ii = np.repeat(np.arange(len(AX)), cnt)
            within = np.arange(tot) - np.repeat(np.cumsum(cnt) - cnt, cnt)
            jj = order[np.repeat(lo, cnt) + within]
            k = (AX[ii] - BX[jj]) ** 2 + (AY[ii] - BY[jj]) ** 2 < R * R
            I.append(ii[k]); J.append(jj[k])
    if not I:
        return np.zeros(0, int), np.zeros(0, int)
    return np.concatenate(I), np.concatenate(J)


def way_normals(x, y):
    """沿線左法向 (與 Blender / 網頁相同的中央差分)。"""
    d = np.empty((len(x), 2))
    d[1:-1, 0], d[1:-1, 1] = x[2:] - x[:-2], y[2:] - y[:-2]
    d[0] = (x[1] - x[0], y[1] - y[0])
    d[-1] = (x[-1] - x[-2], y[-1] - y[-2])
    L = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)
    return -d[:, 1] / L, d[:, 0] / L


def point_tangents(ways, PX, PY, n):
    tx, ty = np.zeros(n), np.zeros(n)
    for w in ways:
        idx = np.array(w["idx"])
        nx_, ny_ = way_normals(PX[idx], PY[idx])
        np.add.at(tx, idx, ny_)
        np.add.at(ty, idx, -nx_)
    L = np.maximum(np.hypot(tx, ty), 1e-9)
    return tx / L, ty / L


def main():
    osm = json.load(open(os.path.join(DATA, "taipei_fwy.json"), encoding="utf-8"))
    trunk_path = os.path.join(DATA, "taipei_trunk.json")      # 快速道路 (台64、台65、環東、建國高架…) 走同一套高架處理
    if os.path.exists(trunk_path):
        osm["elements"] += json.load(open(trunk_path, encoding="utf-8"))["elements"]
    dem = DEM(os.path.join(DATA, "terrain"), TERRAIN_ZOOM)

    # ---- 建立點與路段 (共用節點 = 座標完全相同)
    # 轉彎平滑: 向心 Catmull-Rom 樣條 (alpha = 0.5，每段等同一條三次貝茲曲線)，
    # 曲線通過每個 OSM 節點、不會過衝或打結；路段端點的切線取相鄰路段的節點，接頭處 G1 連續。
    raw = []
    for el in osm["elements"]:
        if el.get("type") != "way" or len(el.get("geometry", [])) < 2:
            continue
        g = el["geometry"]
        if any(p is None for p in g):
            continue
        tags = el.get("tags", {})
        pr = way_props(tags)
        lat = np.array([p["lat"] for p in g])
        lon = np.array([p["lon"] for p in g])
        if pr["reverse"]:
            lat, lon = lat[::-1], lon[::-1]
        x, y = local_xy(lat, lon)
        keys = [(round(a * 1e7), round(b * 1e7)) for a, b in zip(lat, lon)]
        raw.append(dict(el=el, tags=tags, pr=pr, lat=lat, lon=lon, xy=np.c_[x, y], keys=keys))
    node_ways = {}
    for r_i, r in enumerate(raw):
        for p_i, k in enumerate(r["keys"]):
            node_ways.setdefault(k, []).append((r_i, p_i))

    def ghost(r_i, end):
        """端點外側的控制點: 取方向最一致的相鄰路段節點，沒有就直線外插。"""
        r = raw[r_i]
        xy = r["xy"]
        P, Pn, key = (xy[0], xy[1], r["keys"][0]) if end == 0 else (xy[-1], xy[-2], r["keys"][-1])
        out = P - Pn
        out = out / (np.linalg.norm(out) or 1.0)
        best, bs = None, 0.5
        for o_i, p_i in node_ways.get(key, ()):
            if o_i == r_i:
                continue
            oxy = raw[o_i]["xy"]
            j = p_i - 1 if end == 0 else p_i + 1
            if not 0 <= j < len(oxy):
                continue
            v = oxy[j] - P
            L = np.linalg.norm(v)
            if L < 0.5:
                continue
            c = float(np.dot(v / L, out))
            if c > bs:
                bs, best = c, oxy[j]
        return best if best is not None else P + (P - Pn)

    def catmull_rom(P0, P1, P2, P3, us, alpha=0.5):
        """向心 Catmull-Rom (Barry-Goldman)，us 為 0..1 之間的參數。"""
        t0 = 0.0
        t1 = t0 + max(np.linalg.norm(P1 - P0) ** alpha, 1e-4)
        t2 = t1 + max(np.linalg.norm(P2 - P1) ** alpha, 1e-4)
        t3 = t2 + max(np.linalg.norm(P3 - P2) ** alpha, 1e-4)
        t = (t1 + (t2 - t1) * np.asarray(us))[:, None]
        A1 = (t1 - t) / (t1 - t0) * P0 + (t - t0) / (t1 - t0) * P1
        A2 = (t2 - t) / (t2 - t1) * P1 + (t - t1) / (t2 - t1) * P2
        A3 = (t3 - t) / (t3 - t2) * P2 + (t - t2) / (t3 - t2) * P3
        B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2
        B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3
        return (t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2

    key2pt = {}
    PXl, PYl, LATl, LONl = [], [], [], []
    ways = []

    def node_pt(k, x, y, la, lo):
        if k not in key2pt:
            key2pt[k] = len(PXl)
            PXl.append(x); PYl.append(y); LATl.append(la); LONl.append(lo)
        return key2pt[k]

    n_curve = 0
    for r_i, r in enumerate(raw):
        xy, nn = r["xy"], len(r["xy"])
        ext = np.vstack([ghost(r_i, 0), xy, ghost(r_i, 1)])
        idx = [node_pt(r["keys"][0], xy[0, 0], xy[0, 1], r["lat"][0], r["lon"][0])]
        for i in range(nn - 1):
            P0, P1, P2, P3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
            seg = float(np.linalg.norm(P2 - P1))
            a, b = P1 - P0, P3 - P2
            cosang = float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) or 1.0))
            ang = math.degrees(math.acos(max(-1.0, min(1.0, cosang))))
            k = max(1, int(math.ceil(seg / DENSIFY_M)), min(int(math.ceil(ang / 2.5)), int(seg / 0.75)))
            if k > 1:
                pts = catmull_rom(P0, P1, P2, P3, np.arange(1, k) / k)
                n_curve += k - 1
                for q in pts:
                    idx.append(len(PXl))
                    PXl.append(q[0]); PYl.append(q[1]); LATl.append(np.nan); LONl.append(np.nan)
            idx.append(node_pt(r["keys"][i + 1], xy[i + 1, 0], xy[i + 1, 1], r["lat"][i + 1], r["lon"][i + 1]))
        ways.append(dict(id=r["el"]["id"], tags=r["tags"], idx=idx, **r["pr"]))

    n = len(PXl)
    PX, PY = np.array(PXl), np.array(PYl)
    P_lat, P_lon = np.array(LATl), np.array(LONl)
    miss = np.isnan(P_lat)
    P_lat[miss], P_lon[miss] = inverse_local(PX[miss], PY[miss])
    print(f"spline points {n_curve}")
    print(f"{len(ways)} ways, {n} points")

    # ---- 圖結構
    ei, ej = [], []
    struct_only = np.ones(n, bool)   # 只屬於橋/隧道的點
    is_bridge = np.zeros(n, bool)
    layer = np.zeros(n, int)
    halfw = np.zeros(n)
    for w in ways:
        idx = np.array(w["idx"])
        ei.extend(idx[:-1])
        ej.extend(idx[1:])
        st = w["bridge"] or w["tunnel"]
        if not st:
            struct_only[idx] = False
        if w["bridge"]:
            is_bridge[idx] = True
            layer[idx] = np.maximum(layer[idx], w["layer"])
        halfw[idx] = np.maximum(halfw[idx], w["width"] / 2)
    ei = np.array(ei)
    ej = np.array(ej)
    elen = np.maximum(np.hypot(PX[ei] - PX[ej], PY[ei] - PY[ej]), 0.5)
    ew = 1.0 / elen

    # 雙向主線拉齊：同一國道、不同路段、相距 < 45 m 的地面點互相耦合
    pt_way = np.full(n, -1)
    pt_ref = np.full(n, "", dtype=object)
    for k, w in enumerate(ways):
        if not w["link"] and not (w["bridge"] or w["tunnel"]):
            idx = np.array(w["idx"])
            pt_way[idx] = k
            pt_ref[idx] = w["tags"].get("ref", "")
    cand = np.nonzero(pt_way >= 0)[0]
    CELL = 45.0
    cells = {}
    for i in cand:
        cells.setdefault((int(PX[i] // CELL), int(PY[i] // CELL)), []).append(i)
    ci, cj = [], []
    for i in cand:
        cx, cy = int(PX[i] // CELL), int(PY[i] // CELL)
        best, bd = -1, CELL
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in cells.get((cx + dx, cy + dy), ()):
                    if pt_way[j] != pt_way[i] and pt_ref[j] == pt_ref[i]:
                        dd = math.hypot(PX[i] - PX[j], PY[i] - PY[j])
                        if dd < bd:
                            best, bd = j, dd
        if best >= 0:
            ci.append(i)
            cj.append(best)
    print(f"cross-coupling pairs (opposite carriageways): {len(ci)}")
    ei_s = np.r_[ei, np.array(ci, int)]
    ej_s = np.r_[ej, np.array(cj, int)]
    ew_s = np.r_[ew, np.full(len(ci), 0.3)]

    # ---- 縱斷面: 地面段貼地形並平滑；橋/隧道段在兩端之間調和內插
    d = dem.sample(P_lat, P_lon).astype(np.float64)
    alpha = DENSIFY_M / SMOOTH_LEN ** 2
    wdata = np.where(struct_only, 0.0, alpha)
    print("solving road profile ...")
    z = solve_cg(n, ei_s, ej_s, ew_s, wdata, wdata * d, d)

    # ---- 高架層級: 從地面點出發的最短距離 -> 引道坡度
    adj = [[] for _ in range(n)]
    for a, b, L in zip(ei, ej, elen):
        adj[a].append((b, L))
        adj[b].append((a, L))
    dist = np.full(n, np.inf)
    pq = []
    for i in np.nonzero(~struct_only)[0]:
        dist[i] = 0.0
        pq.append((0.0, int(i)))
    heapq.heapify(pq)
    while pq:
        dd, i = heapq.heappop(pq)
        if dd > dist[i]:
            continue
        for j, L in adj[i]:
            if struct_only[j] and dd + L < dist[j]:
                dist[j] = dd + L
                heapq.heappush(pq, (dd + L, j))
    dist[np.isinf(dist)] = 1e4  # 範圍外被切斷的高架
    tun = np.zeros(n, bool)
    for w in ways:
        if w["tunnel"]:
            tun[np.array(w["idx"])] = True
    # 高架抬升只補「離地不夠高」的部分: 平地高架抬到每層 7 m；跨溪谷的橋本來就很高，不再額外加
    d_s = solve_cg(n, ei, ej, ew, np.full(n, 0.005), 0.005 * d, d)   # 沿路網平滑的地形 (去掉單點雜訊)
    above = np.maximum(z - d_s, 0.0)
    lift_t = np.where(is_bridge & struct_only & (layer > 0) & ~tun,
                      np.maximum(np.minimum(layer * LAYER_H, MAX_GRADE * dist) - above, 0.0), 0.0)
    # 抬升量在路網上平滑 (地面點固定 0)：避免多條橋交會的節點取到較高層數而形成單點突刺 (垂直的「路面牆」)
    wl = np.where(struct_only, 0.02, 1.0)
    lift = np.maximum(solve_cg(n, ei, ej, ew, wl, wl * lift_t, lift_t), 0.0)
    z_road = z + lift

    # ---- 立體交叉淨空: 上層橋面至少比下層路面高 CLEARANCE (5 m 淨高 + 1.5 m 梁深)，不足時局部平滑抬高
    TX, TY = point_tangents(ways, PX, PY, n)
    lvl = np.where(struct_only & is_bridge, layer, 0)
    is_tunnel_pt = np.zeros(n, bool)
    for w in ways:
        if w["tunnel"]:
            is_tunnel_pt[np.array(w["idx"])] = True
    lvl[struct_only & is_tunnel_pt] = -1
    upper_ok = struct_only & is_bridge
    _reach = {}

    def reach(src, maxd=300.0):
        if src in _reach:
            return _reach[src]
        seen = {src: 0.0}
        pq_ = [(0.0, src)]
        while pq_:
            dd, i = heapq.heappop(pq_)
            if dd > seen.get(i, 1e18):
                continue
            for j, L in adj[i]:
                nd = dd + L
                if nd < maxd and nd < seen.get(j, 1e18):
                    seen[j] = nd
                    heapq.heappush(pq_, (nd, j))
        _reach[src] = seen
        return seen

    prev_cnt = 1 << 30
    for it in range(12):
        a, b = pairs_within(PX, PY, PX, PY, 26.0)
        k = (lvl[a] > lvl[b]) & upper_ok[a] & (lvl[b] >= 0)
        a, b = a[k], b[k]
        dx, dy = PX[b] - PX[a], PY[b] - PY[a]
        along = dx * TX[a] + dy * TY[a]
        lat = -dx * TY[a] + dy * TX[a]
        need = CLEARANCE - (z_road[a] - z_road[b])
        dot = np.abs(TX[a] * TX[b] + TY[a] * TY[b])
        hsum = halfw[a] + halfw[b]
        # 真正的立體交叉: 斜交且平面重疊，或平行但上下疊在一起 (如汐五高架在國1正上方)；並排的對向車道不算
        crossing = ((dot < 0.85) & (np.abs(lat) < hsum - 0.5)) | (np.abs(lat) < 0.5 * hsum)
        k = (np.abs(along) < 8) & crossing & (need > 0.05)
        a, b, need = a[k], b[k], need[k]
        # 排除路網上 300 m 內相連的 (匝道匯入/分出高架處本來就會靠在一起)
        keep = np.array([b_ not in reach(a_) for a_, b_ in zip(a, b)], bool) if len(a) else np.zeros(0, bool)
        a, need = a[keep], need[keep]
        cnt = len(np.unique(a)) if len(a) else 0
        if not cnt or cnt >= prev_cnt:   # 不再改善就停 (避免兩條路互相抬升的正回饋)
            print(f"  clearance: stop at pass {it + 1}, {cnt} points remain")
            break
        prev_cnt = cnt
        # 坡度錐: 從需要淨空的點沿路網以 CLEAR_GRADE 往外降，得到每點最低高度 (引道路堤也跟著墊高，不會有突刺)
        zmin = np.full(n, -np.inf)
        np.maximum.at(zmin, a, z_road[a] + need + 0.1)
        zreq = zmin.copy()
        pq_ = [(-zmin[i], int(i)) for i in np.unique(a)]
        heapq.heapify(pq_)
        while pq_:
            negv, i = heapq.heappop(pq_)
            v = -negv
            if v < zreq[i] - 1e-9:
                continue
            for j, L in adj[i]:
                c = v - CLEAR_GRADE * L
                if c > zreq[j] and c > z_road[j]:
                    zreq[j] = c
                    heapq.heappush(pq_, (-c, j))
        raised = zreq > z_road
        z_road = np.maximum(z_road, zreq)
        print(f"  clearance pass {it + 1}: {len(np.unique(a))} points under-clearance, max deficit {need.max():.2f} m, raised {int(raised.sum())} points")

    # ---- 安全網: 坡度超過 12% 的地方做局部平均 (單點突刺會被抹平)
    deg = np.bincount(ei, minlength=n) + np.bincount(ej, minlength=n)
    for it in range(250):
        bad = np.abs(z_road[ei] - z_road[ej]) / elen > 0.12
        if not bad.any():
            break
        pb = np.unique(np.r_[ei[bad], ej[bad]])
        avg = (np.bincount(ei, z_road[ej], n) + np.bincount(ej, z_road[ei], n)) / np.maximum(deg, 1)
        z_road[pb] = 0.5 * z_road[pb] + 0.5 * avg[pb]
    print(f"grade limiter: {it} iterations, {int(bad.sum())} edges still > 12%")

    if os.environ.get("Z_DEBUG"):
        np.savez(os.path.join(DATA, "z_debug.npz"), z=z, lift=lift, lift_t=lift_t, zc=z_road, PX=PX, PY=PY,
                 struct_only=struct_only, layer=layer, dist=dist, lvl=lvl)
        json.dump([w["idx"] for w in ways], open(os.path.join(DATA, "z_debug_idx.json"), "w"))
    # ---- 雙向車道分離: OSM 兩條單向中心線常比真實車寬還近，鋪上 1:1 寬度後會重疊
    #      (對向路肩與中央分隔護欄「躺」在車道上)。偵測重疊並把兩側往外推開，推移量沿路網平滑過渡。
    TX, TY = point_tangents(ways, PX, PY, n)
    oneway_pt = np.zeros(n, bool)
    for w in ways:
        if w["oneway"]:
            oneway_pt[np.array(w["idx"])] = True
    cand = np.nonzero(oneway_pt)[0]
    shift = np.zeros((n, 2))
    for it in range(12):
        X, Y = PX + shift[:, 0], PY + shift[:, 1]
        a, b = pairs_within(X[cand], Y[cand], X[cand], Y[cand], 28.0)
        p, q = cand[a], cand[b]
        k = (TX[p] * TX[q] + TY[p] * TY[q] < -0.8) & (np.abs(z_road[p] - z_road[q]) < 3.5) & (lvl[p] == lvl[q])
        p, q = p[k], q[k]
        dx, dy = X[q] - X[p], Y[q] - Y[p]
        along = dx * TX[p] + dy * TY[p]
        lat = -dx * TY[p] + dy * TX[p]                    # 左正
        pen = halfw[p] + halfw[q] + MEDIAN_W - np.abs(lat)
        k = (np.abs(along) < 12) & (pen > 0.05)
        p, lat, pen = p[k], lat[k], pen[k]
        if not len(p):
            break
        if os.environ.get("SEP_DEBUG") and it == 3:
            pw = np.full(n, -1)
            for k_, w in enumerate(ways):
                pw[np.array(w["idx"])] = k_
            qq = q[k]
            for r in np.argsort(-pen)[:12:2]:
                wa, wb = ways[pw[p[r]]], ways[pw[qq[r]]]
                la_, lo_ = inverse_local(PX[p[r]], PY[p[r]])
                print(f"    pen {pen[r]:.1f} lat {lat[r]:.1f} @({float(la_):.5f},{float(lo_):.5f}) "
                      f"A={wa['tags'].get('ref')}/{wa['tags'].get('name')}/{wa['tags'].get('highway')} br={wa['bridge']} L{wa['layer']} "
                      f"B={wb['tags'].get('ref')}/{wb['tags'].get('name')}/{wb['tags'].get('highway')} br={wb['bridge']} L{wb['layer']} "
                      f"dz={z_road[p[r]] - z_road[qq[r]]:.1f}")
        o = np.lexsort((-pen, p))                          # 每點取最大重疊
        p, lat, pen = p[o], lat[o], pen[o]
        f = np.r_[True, p[1:] != p[:-1]]
        p, lat, pen = p[f], lat[f], pen[f]
        tgt = np.zeros((n, 2))
        sg = np.sign(lat)
        tgt[p, 0] = -sg * (pen / 2 + 0.05) * -TY[p]          # 往遠離對向的那側 (左法向 = (-ty, tx))
        tgt[p, 1] = -sg * (pen / 2 + 0.05) * TX[p]
        wdat = np.full(n, 0.0008)
        wdat[p] = 0.05
        inc = np.c_[solve_cg(n, ei, ej, ew, wdat, wdat * tgt[:, 0], np.zeros(n)),
                    solve_cg(n, ei, ej, ew, wdat, wdat * tgt[:, 1], np.zeros(n))]
        shift += inc
        print(f"  separation pass {it + 1}: {len(p)} overlapping points, max overlap {pen.max():.2f} m")
    PX, PY = PX + shift[:, 0], PY + shift[:, 1]
    P_lat, P_lon = inverse_local(PX, PY)
    print(f"carriageway separation: max shift {np.hypot(shift[:, 0], shift[:, 1]).max():.2f} m")

    # ---- 地形網格 (經緯度規則網格 -> 投影)
    S, W, N, E = BBOX
    glat = np.arange(S, N + 1e-9, GRID_STEP_DEG)
    glon = np.arange(W, E + 1e-9, GRID_STEP_DEG)
    LON, LAT = np.meshgrid(glon, glat)
    GX, GY = local_xy(LAT, LON)
    GZ = np.maximum(dem.sample(LAT, LON).astype(np.float64), 0.0)  # 去除負值雜訊
    H, Wn = GZ.shape
    print(f"terrain grid {Wn} x {H} = {GZ.size} vertices")

    # 地面路段附近整平：找每個網格點最近的地面路點
    ground = np.nonzero(~struct_only)[0]
    fi = (P_lat[ground] - S) / GRID_STEP_DEG
    fj = (P_lon[ground] - W) / GRID_STEP_DEG
    R = 3
    cand_cell, cand_d, cand_z, cand_hw = [], [], [], []
    for di in range(-R, R + 1):
        for dj in range(-R, R + 1):
            ii = np.round(fi).astype(int) + di
            jj = np.round(fj).astype(int) + dj
            ok = (ii >= 0) & (ii < H) & (jj >= 0) & (jj < Wn)
            ii, jj, g = ii[ok], jj[ok], ground[ok]
            dd = np.hypot(GX[ii, jj] - PX[g], GY[ii, jj] - PY[g])
            cand_cell.append(ii * Wn + jj)
            cand_d.append(dd)
            cand_z.append(z_road[g])
            cand_hw.append(halfw[g])
    cell = np.concatenate(cand_cell)
    cd = np.concatenate(cand_d)
    cz = np.concatenate(cand_z)
    chw = np.concatenate(cand_hw)
    order = np.lexsort((cd, cell))
    cell, cd, cz, chw = cell[order], cd[order], cz[order], chw[order]
    first = np.r_[True, cell[1:] != cell[:-1]]
    cell, cd, cz, chw = cell[first], cd[first], cz[first], chw[first]
    t = np.clip((cd - (chw + 4.0)) / 30.0, 0.0, 1.0)
    t = t * t * (3 - 2 * t)
    flat = GZ.ravel()
    flat[cell] = (cz - 0.4) * (1 - t) + flat[cell] * t
    GZ = flat.reshape(H, Wn)

    # 每個路點正下方的地形高度 (給橋墩用)
    pi_ = np.clip((P_lat - S) / GRID_STEP_DEG, 0, H - 1.001)
    pj_ = np.clip((P_lon - W) / GRID_STEP_DEG, 0, Wn - 1.001)
    i0, j0 = pi_.astype(int), pj_.astype(int)
    fy, fx = pi_ - i0, pj_ - j0
    under = ((1 - fy) * ((1 - fx) * GZ[i0, j0] + fx * GZ[i0, j0 + 1])
             + fy * ((1 - fx) * GZ[i0 + 1, j0] + fx * GZ[i0 + 1, j0 + 1]))

    def terrain_xy(x, y):
        la, lo = inverse_local(np.asarray(x, float), np.asarray(y, float))
        a_ = np.clip((la - S) / GRID_STEP_DEG, 0, H - 1.001)
        b_ = np.clip((lo - W) / GRID_STEP_DEG, 0, Wn - 1.001)
        i_, j_ = a_.astype(int), b_.astype(int)
        v_, u_ = a_ - i_, b_ - j_
        return ((1 - v_) * ((1 - u_) * GZ[i_, j_] + u_ * GZ[i_, j_ + 1])
                + v_ * ((1 - u_) * GZ[i_ + 1, j_] + u_ * GZ[i_ + 1, j_ + 1]))

    # ---- 路緣遮罩: 路緣落在別條路面上 (匝道分合流、重疊段) 時不放護欄與側牆
    TX, TY = point_tangents(ways, PX, PY, n)
    EX, EY, EZ, Eown = [], [], [], []
    for k_, w in enumerate(ways):
        idx = np.array(w["idx"])
        nxw, nyw = way_normals(PX[idx], PY[idx])
        hw_ = w["width"] / 2
        for side in (1, -1):
            EX.append(PX[idx] + nxw * hw_ * side); EY.append(PY[idx] + nyw * hw_ * side)
            EZ.append(z_road[idx]); Eown.append(np.full(len(idx), k_ * 2 + (0 if side > 0 else 1)))
    EX, EY, EZ, Eown = map(np.concatenate, (EX, EY, EZ, Eown))
    a, b = pairs_within(EX, EY, PX, PY, 18.0)
    dx, dy = EX[a] - PX[b], EY[a] - PY[b]
    along = dx * TX[b] + dy * TY[b]
    lat = -dx * TY[b] + dy * TX[b]
    inside = (np.abs(along) < 5) & (np.abs(lat) < halfw[b] - 0.35) & (np.abs(EZ[a] - z_road[b]) < 1.5)
    emask = np.zeros(len(EX), bool)
    emask[a[inside]] = True
    edge_masks, o_ = [], 0
    for w in ways:
        m_ = len(w["idx"])
        edge_masks.append((emask[o_:o_ + m_], emask[o_ + m_:o_ + 2 * m_]))
        o_ += 2 * m_
    print(f"edge mask: {emask.sum()} of {len(emask)} edge points hidden (barrier/skirt inside another road)")

    # ---- 橋墩: 每 35 m 一座；立柱落在下層道路上時往側邊移，帽梁延伸過去
    piers = []
    cands = []
    OFFS = [0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10, 12, -12, 14, -14, 17, -17, 20, -20]
    for k_, w in enumerate(ways):
        if not w["bridge"]:
            continue
        idx = np.array(w["idx"])
        P = np.c_[PX[idx], PY[idx], z_road[idx]]
        nxw, nyw = way_normals(P[:, 0], P[:, 1])
        s_ = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
        for d in np.arange(17.5, s_[-1] - 5, 35.0):
            i = min(int(np.searchsorted(s_, d)), len(P) - 1)
            cands.append((k_, P[i], nxw[i], nyw[i], w["width"] / 2))
    if cands:
        cx = np.array([[c[1][0] + c[2] * o, c[1][1] + c[3] * o] for c in cands for o in OFFS])
        ctop = np.repeat([c[1][2] - 2.2 for c in cands], len(OFFS))
        a, b = pairs_within(cx[:, 0], cx[:, 1], PX, PY, 18.0)
        dx, dy = cx[a, 0] - PX[b], cx[a, 1] - PY[b]
        along = dx * TX[b] + dy * TY[b]
        lat = -dx * TY[b] + dy * TX[b]
        hit = (np.abs(along) < 5) & (np.abs(lat) < halfw[b] + 1.4) & (z_road[b] < ctop[a] - 2.0)
        blocked = np.zeros(len(cx), bool)
        blocked[a[hit]] = True
        zg_all = terrain_xy(cx[:, 0], cx[:, 1])
        for ci, (k_, P, nxi, nyi, hw_) in enumerate(cands):
            top = P[2] - 2.2
            for oi, off in enumerate(OFFS):
                j = ci * len(OFFS) + oi
                if blocked[j]:
                    continue
                zg = float(zg_all[j])
                if top - zg < 2.5:
                    break
                capL, capR = min(-0.85 * hw_, off - 1.0), max(0.85 * hw_, off + 1.0)
                piers.append([round(float(P[0]), 2), round(float(P[1]), 2), round(float(nyi), 4), round(float(-nxi), 4),
                              off, round(zg, 2), round(float(top), 2), round(capL, 2), round(capR, 2)])
                break
    print(f"piers: {len(piers)} placed, {sum(1 for p in piers if p[4] != 0)} moved aside to avoid roads below")

    # ---- 輸出
    out_ways = []
    for k_, w in enumerate(ways):
        idx = np.array(w["idx"])
        t_ = w["tags"]
        out_ways.append(dict(
            id=w["id"], highway=t_.get("highway"), ref=t_.get("ref"),
            name=t_.get("name"), name_en=t_.get("name:en"),
            lanes=w["lanes"], oneway=w["oneway"], ls=w["ls"], rs=w["rs"], width=w["width"],
            bridge=w["bridge"], tunnel=w["tunnel"], layer=w["layer"],
            pts=np.round(np.c_[PX[idx], PY[idx], z_road[idx]], 3).tolist(),
            under=np.round(under[idx], 2).tolist(),
            edgeL=edge_masks[k_][0].astype(int).tolist(), edgeR=edge_masks[k_][1].astype(int).tolist(),
            ll=[float(P_lat[idx[len(idx) // 2]]), float(P_lon[idx[len(idx) // 2]])],
        ))
    meta = dict(crs="EPSG:3826 (TWD97 TM2)", origin_twd97=ORIGIN, bbox=BBOX,
                source="© OpenStreetMap contributors (ODbL); terrain: AWS Terrain Tiles",
                pier_fields=["x", "y", "tx", "ty", "offset_left", "z_ground", "z_top", "cap_left", "cap_right"])
    json.dump(dict(meta=meta, ways=out_ways, piers=piers),
              open(os.path.join(DATA, "freeway_prep.json"), "w", encoding="utf-8"), ensure_ascii=False)
    np.savez_compressed(os.path.join(DATA, "terrain_grid.npz"),
                        X=GX.astype(np.float32), Y=GY.astype(np.float32), Z=GZ.astype(np.float32))

    # ---- 統計
    br = is_bridge & struct_only
    print(f"origin TWD97 = {ORIGIN}")
    print(f"extent x {GX.min():.0f}..{GX.max():.0f}  y {GY.min():.0f}..{GY.max():.0f} m")
    print(f"terrain z {GZ.min():.1f}..{GZ.max():.1f} m")
    print(f"road z {z_road.min():.1f}..{z_road.max():.1f} m; bridge lift max {lift.max():.1f} m")
    print(f"bridge points {br.sum()}, max height above ground {(z_road - under)[br].max():.1f} m")
    total = sum(np.hypot(*np.diff(np.array(w['pts'])[:, :2], axis=0).T).sum() for w in out_ways)
    print(f"total carriageway length {total / 1000:.1f} km")


if __name__ == "__main__":
    main()
