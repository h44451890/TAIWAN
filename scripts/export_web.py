"""把國道資料輸出成網頁用的二進位資料 (data/web_data.bin + data/web_meta.json)。

- 路線: 與 Blender 相同的 [x, y, z] 點 (freeway_prep.json)
- 地形: 重新取樣成「公尺規則網格」(30 m)，並依路面整平，高度存 Int16 (0.1 m)
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from prep_freeway import DATA, DEM, TERRAIN_ZOOM, inverse_local, local_xy  # noqa: E402

STEP = 30.0
X0, X1, Y0, Y1 = -15000.0, 15000.0, -8800.0, 8800.0


def main():
    prep = json.load(open(os.path.join(DATA, "freeway_prep.json"), encoding="utf-8"))
    osm = json.load(open(os.path.join(DATA, "taipei_fwy.json"), encoding="utf-8"))
    if os.path.exists(os.path.join(DATA, "taipei_trunk.json")):
        osm["elements"] += json.load(open(os.path.join(DATA, "taipei_trunk.json"), encoding="utf-8"))["elements"]
    tags_by_id = {e["id"]: e.get("tags", {}) for e in osm["elements"]}
    ways = prep["ways"]

    # ---- 地形網格 (公尺)
    gx = np.arange(X0, X1 + 1e-6, STEP)
    gy = np.arange(Y0, Y1 + 1e-6, STEP)
    GX, GY = np.meshgrid(gx, gy)
    lat, lon = inverse_local(GX.ravel(), GY.ravel())
    chk = local_xy(lat, lon)
    print("inverse projection max error (m):", float(np.max(np.hypot(chk[0] - GX.ravel(), chk[1] - GY.ravel()))))
    dem = DEM(os.path.join(DATA, "terrain"), TERRAIN_ZOOM)
    GZ = np.maximum(dem.sample(lat, lon), 0.0).reshape(GX.shape)
    H, W = GZ.shape

    # ---- 依路面整平 (地面路段: 路面下 0.7 m；橋下: 至少低於橋面 3 m)
    gp, bp = [], []
    for w in ways:
        P = np.array(w["pts"])
        hw = np.full(len(P), w["width"] / 2)
        if w["tunnel"]:
            continue
        (bp if w["bridge"] else gp).append(np.c_[P, hw])
    for pts, mode in ((np.concatenate(gp), "ground"), (np.concatenate(bp), "bridge")):
        fi = (pts[:, 1] - Y0) / STEP
        fj = (pts[:, 0] - X0) / STEP
        R = 3
        cells, ds, zs, hws = [], [], [], []
        for di in range(-R, R + 1):
            for dj in range(-R, R + 1):
                ii = np.round(fi).astype(int) + di
                jj = np.round(fj).astype(int) + dj
                ok = (ii >= 0) & (ii < H) & (jj >= 0) & (jj < W)
                p = pts[ok]
                ii, jj = ii[ok], jj[ok]
                cells.append(ii * W + jj)
                ds.append(np.hypot(GX[ii, jj] - p[:, 0], GY[ii, jj] - p[:, 1]))
                zs.append(p[:, 2])
                hws.append(p[:, 3])
        c, d, z, hw = map(np.concatenate, (cells, ds, zs, hws))
        o = np.lexsort((d, c))
        c, d, z, hw = c[o], d[o], z[o], hw[o]
        f = np.r_[True, c[1:] != c[:-1]]
        c, d, z, hw = c[f], d[f], z[f], hw[f]
        flat = GZ.ravel()
        if mode == "ground":
            t = np.clip((d - (hw + 4.0)) / 32.0, 0, 1)
            t = t * t * (3 - 2 * t)
            flat[c] = (z - 0.7) * (1 - t) + flat[c] * t
        else:
            near = d < hw + 6.0
            flat[c[near]] = np.minimum(flat[c[near]], z[near] - 3.0)
        GZ = flat.reshape(H, W)
    GZ = np.maximum(GZ, -5.0)

    # ---- 路線
    pts = np.concatenate([np.array(w["pts"], np.float32) for w in ways])
    under = np.concatenate([np.array(w["under"], np.float32) for w in ways])
    counts = np.array([len(w["pts"]) for w in ways], np.int32)
    meta_ways = []
    for w in ways:
        t = tags_by_id.get(w["id"], {})
        try:
            ms = int(str(t.get("maxspeed", "")).split()[0])
        except (ValueError, IndexError):
            ms = 0
        meta_ways.append([w["ref"] or "", w["name"] or "", w["lanes"], w["ls"], w["rs"], w["width"],
                          int(w["bridge"]) | int(w["tunnel"]) << 1 | int(str(w["highway"]).endswith("_link")) << 2
                          | int(w["oneway"]) << 3, ms, 1 if str(w["highway"]).startswith("trunk") else 0])

    # ---- 一般道路 + 3D 建築 (會再整平一次地形)
    if os.path.exists(os.path.join(DATA, "taipei_city.json")):
        import city_web
        cblob, cmeta = city_web.build(DATA, local_xy, GZ, X0, Y0, STEP, ways)
        open(os.path.join(DATA, "city.bin"), "wb").write(cblob)
        json.dump(cmeta, open(os.path.join(DATA, "city_meta.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    hz = np.round(GZ * 10).astype(np.int16)
    piers = np.array(prep.get("piers", []), np.float32).reshape(-1, 9)
    masks = np.concatenate([np.array(w["edgeL"], np.uint8) | (np.array(w["edgeR"], np.uint8) << 1) for w in ways])
    blob = b"".join([counts.tobytes(), pts.tobytes(), under.tobytes(), piers.tobytes(), hz.tobytes(), masks.tobytes()])
    open(os.path.join(DATA, "web_data.bin"), "wb").write(blob)
    meta = dict(nways=len(ways), npts=int(len(pts)), npiers=int(len(piers)),
                terrain=dict(x0=X0, y0=Y0, step=STEP, w=W, h=H),
                ways=meta_ways, origin_twd97=prep["meta"]["origin_twd97"], source=prep["meta"]["source"])
    json.dump(meta, open(os.path.join(DATA, "web_meta.json"), "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    print(f"ways {len(ways)}, points {len(pts)}, terrain {W}x{H}, blob {len(blob) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
