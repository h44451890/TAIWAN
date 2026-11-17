"""把 data/landcover/*.json (OSM 地表) 畫成和地形同一套 30 m 格網的地表分類 data/landcover.npy (uint8, H x W)。
tile_web.py 會把它附在每個地形分區後面，網頁用它決定地形顏色與水面。

分類:
  0 未知 (照坡度、高度自動上色)   1 水 (海、河、湖、水庫)   2 沙灘 / 沙地   3 河床砂石 / 裸岩
  4 濕地 / 泥灘 (紅樹林)          5 都市 (住宅、商業、工業)   6 農田 / 果園 / 魚塭   7 森林   8 草地 / 公園 / 高爾夫球場
海: 地形高度 <= 0.4 m、而且和地圖邊界相連的區域。海岸邊再自動補 2 格沙灘。
"""
import glob
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from prep_freeway import local_xy  # noqa: E402

DATA = os.path.join(HERE, "..", "data")

WATER, SAND, GRAVEL, WET, URBAN, FARM, FOREST, GRASS = 1, 2, 3, 4, 5, 6, 7, 8
RIVER = 9   # 內部用: 河道 (寬的河後處理成「中間水道 + 兩岸砂石灘」)
# 畫的順序 = 優先順序 (後畫的蓋過先畫的)
ORDER = [FOREST, GRASS, FARM, URBAN, WET, SAND, GRAVEL, WATER, RIVER]


def classify(t):
    nat, lu, ww, le = t.get("natural", ""), t.get("landuse", ""), t.get("waterway", ""), t.get("leisure", "")
    if ww == "riverbank" or (nat == "water" and t.get("water") in ("river", "stream", "canal")):
        return RIVER
    if nat == "water" or ww == "dock" or lu in ("reservoir", "basin", "salt_pond"):
        return WATER
    if nat in ("beach", "sand"):
        return SAND
    if nat in ("shingle", "bare_rock", "scree") or lu in ("quarry", "landfill"):
        return GRAVEL
    if nat in ("wetland", "mud", "reef"):
        return WET
    if lu in ("residential", "commercial", "industrial", "retail", "construction", "railway", "military", "brownfield"):
        return URBAN
    if lu in ("farmland", "farmyard", "orchard", "vineyard", "plant_nursery", "aquaculture", "greenfield"):
        return FARM
    if nat in ("wood", "scrub", "heath") or lu == "forest" or le == "nature_reserve":
        return FOREST
    if nat == "grassland" or lu in ("meadow", "grass", "recreation_ground", "village_green", "cemetery") or le in ("park", "golf_course", "pitch", "stadium"):
        return GRASS
    return 0


def rings_of(el):
    """way -> [(外圈, 點)]；relation (multipolygon) -> 把成員線段接成環 [(role, 點)]"""
    if el["type"] == "way":
        g = el.get("geometry") or []
        return [("outer", [(p["lat"], p["lon"]) for p in g])] if len(g) >= 3 else []
    out = []
    for role in ("outer", "inner"):
        segs = [[(p["lat"], p["lon"]) for p in m.get("geometry") or []] for m in el.get("members", [])
                if m.get("type") == "way" and (m.get("role") or "outer") == role and m.get("geometry")]
        segs = [s for s in segs if len(s) >= 2]
        while segs:
            ring = segs.pop(0)
            changed = True
            while changed and ring[0] != ring[-1]:
                changed = False
                for k, s in enumerate(segs):
                    if s[0] == ring[-1]:
                        ring += s[1:]
                    elif s[-1] == ring[-1]:
                        ring += s[::-1][1:]
                    elif s[-1] == ring[0]:
                        ring = s[:-1] + ring
                    elif s[0] == ring[0]:
                        ring = s[::-1][:-1] + ring
                    else:
                        continue
                    segs.pop(k); changed = True
                    break
            if len(ring) >= 3:
                out.append((role, ring))
    return out


def main():
    meta = json.load(open(os.path.join(DATA, "web_meta.json"), encoding="utf-8"))
    TG = meta["terrain"]
    X0, Y0, STEP, W, H = TG["x0"], TG["y0"], TG["step"], TG["w"], TG["h"]
    fm = meta
    fb = open(os.path.join(DATA, "web_data.bin"), "rb").read()
    NW, NP, NPI = fm["nways"], fm["npts"], fm["npiers"]
    o = NW * 4 + NP * 12 + NP * 4 + NPI * 36
    hz = np.frombuffer(fb, np.int16, W * H, o).reshape(H, W).astype(np.int32)
    hz = np.where(hz < -5000, hz + 65536, hz) * 0.1

    layers = {c: Image.new("L", (W, H), 0) for c in ORDER}
    draws = {c: ImageDraw.Draw(im) for c, im in layers.items()}
    holes = Image.new("L", (W, H), 0); dh = ImageDraw.Draw(holes)
    seen, n_el = set(), 0

    def px(pts):
        la = np.array([p[0] for p in pts]); lo = np.array([p[1] for p in pts])
        x, y = local_xy(la, lo)
        return list(zip(((x - X0) / STEP).tolist(), ((y - Y0) / STEP).tolist()))

    for f in sorted(glob.glob(os.path.join(DATA, "landcover", "lc_*.json"))):
        for el in json.load(open(f, encoding="utf-8"))["elements"]:
            key = (el["type"], el["id"])
            if key in seen:
                continue
            seen.add(key)
            t = el.get("tags", {})
            ww = t.get("waterway", "")
            if el["type"] == "way" and ww in ("river", "canal") and (t.get("tunnel") in ("yes", "culvert", "flooded") or t.get("covered") == "yes" or t.get("layer", "0").startswith("-")):
                n_el += 1
                continue   # 涵洞、加蓋、地下的河道: 地面上看不到水
            if el["type"] == "way" and ww in ("river", "canal"):   # 河道中心線 (沒有河岸多邊形時): 依寬度畫粗線
                g = el.get("geometry") or []
                if len(g) >= 2:
                    try:
                        wd = float(str(t.get("width", "")).replace("m", " ").split()[0])
                    except (ValueError, IndexError):
                        wd = 20.0 if ww == "river" else 10.0
                    if wd >= 12:
                        draws[RIVER].line(px([(p["lat"], p["lon"]) for p in g]), fill=255, width=max(1, int(round(wd / STEP))))
                n_el += 1
                continue
            c = classify(t)
            if not c:
                continue
            for role, ring in rings_of(el):
                pts = px(ring)
                if role == "outer":
                    draws[c].polygon(pts, fill=255)
                elif c in (WATER, RIVER):
                    dh.polygon(pts, fill=255)   # 河中沙洲、湖中島
            n_el += 1
    cls = np.zeros((H, W), np.uint8)
    for c in ORDER:
        a = np.asarray(layers[c]) > 127
        if c in (WATER, RIVER):
            a &= ~(np.asarray(holes) > 127)
        cls[a] = c
    # 河道: 寬度 240 m 以上的河 (台灣西部的大河) 兩岸 2 格 (約 60 m) 是砂石灘，中間是水；窄的河整條都是水
    riv = cls == RIVER
    if riv.any():
        dt = ndimage.distance_transform_edt(riv)
        wide = ndimage.maximum_filter(dt, size=17) >= 4
        cls[riv] = WATER
        cls[riv & wide & (dt < 2.5)] = GRAVEL
    # 海: 高度 <= 0.4 m 且和地圖邊界相連
    low = hz <= 0.4
    lab, _ = ndimage.label(low)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    sea = np.isin(lab, list(edge))
    cls[sea] = WATER
    # 海岸自動補沙灘: 離海 2 格內、海拔 < 4 m 的陸地 (沒有標成都市、濕地的)
    near = ndimage.binary_dilation(sea, iterations=2) & ~sea & (hz < 4) & np.isin(cls, [0, FARM, GRASS])
    cls[near] = SAND
    np.save(os.path.join(DATA, "landcover.npy"), cls)
    names = ["未知", "水", "沙灘", "砂石", "濕地", "都市", "農田", "森林", "草地"]
    tot = cls.size
    print(f"landcover {W}x{H}, elements {n_el}, sea cells {int(sea.sum())}: " +
          ", ".join(f"{names[i]} {np.sum(cls == i) / tot * 100:.1f}%" for i in range(9)))


if __name__ == "__main__":
    main()
