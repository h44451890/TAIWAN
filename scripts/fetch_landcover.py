"""從 Overpass 下載地表資料 (水域、沙灘、河床砂石、濕地、森林、都市、農田、公園…)，分塊存 data/landcover/。
已下載的分塊會略過 (中斷後重跑會接著下載)。之後由 scripts/landcover.py 轉成 30 m 地表分類格網。

用法: python scripts/fetch_landcover.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fetch_city import BBOX, bb, query  # noqa: E402

DATA = os.path.join(HERE, "..", "data")
NAT = "water|beach|sand|shingle|wetland|wood|scrub|grassland|heath|bare_rock|scree|mud|reef"
LANDUSE = ("residential|commercial|industrial|retail|construction|railway|military|cemetery|"
           "farmland|farmyard|meadow|orchard|vineyard|plant_nursery|aquaculture|"
           "forest|grass|recreation_ground|village_green|reservoir|basin|salt_pond|landfill|quarry|brownfield|greenfield")


def main():
    out = os.path.join(DATA, "landcover")
    os.makedirs(out, exist_ok=True)
    s, w, n, e = BBOX
    ny, nx = 8, 6
    for i in range(ny):
        for j in range(nx):
            box = (s + (n - s) * i / ny, w + (e - w) * j / nx, s + (n - s) * (i + 1) / ny, w + (e - w) * (j + 1) / nx)
            path = os.path.join(out, f"lc_{i}_{j}.json")
            if os.path.exists(path):
                continue
            b = bb(box)
            q = f"""[out:json][timeout:300];
(
  way["natural"~"^({NAT})$"]({b}); relation["natural"~"^({NAT})$"]({b});
  way["waterway"~"^(riverbank|river|canal|dock)$"]({b}); relation["waterway"="riverbank"]({b});
  way["landuse"~"^({LANDUSE})$"]({b}); relation["landuse"~"^({LANDUSE})$"]({b});
  way["leisure"~"^(park|golf_course|pitch|stadium|nature_reserve)$"]({b});
);
out geom tags;"""
            d = query(q, f"landcover {i},{j}")
            json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"[{i},{j}] {len(d['elements'])} elements", flush=True)
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    main()
