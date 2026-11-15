"""從 Overpass 下載快速道路、一般道路與建築 (分塊下載，避免逾時)。

輸出:
  data/taipei_trunk.json   快速道路 (highway=trunk|trunk_link)，交給 prep_freeway.py 做完整高架處理
  data/taipei_city.json    一般道路 (primary ~ residential)
  data/buildings/*.json    建築 (分塊)
"""
import json
import os
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
BBOX = (24.00, 120.45, 25.20, 121.92)
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
             "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
CITY = "primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street"


def query(q, label):
    for attempt in range(8):
        for ep in ENDPOINTS:
            try:
                r = requests.post(ep, data={"data": q}, timeout=300, headers={"User-Agent": "osm-research-script"})
                if r.status_code == 200 and r.text.lstrip().startswith("{"):
                    return r.json()
                print(f"  {label}: {ep.split('/')[2]} HTTP {r.status_code}", file=sys.stderr)
            except Exception as ex:  # noqa: BLE001
                print(f"  {label}: {ep.split('/')[2]} {type(ex).__name__}", file=sys.stderr)
            time.sleep(4)
        time.sleep(10 * (attempt + 1))
    sys.exit(f"failed: {label}")


def tiles(nx, ny):
    s, w, n, e = BBOX
    for i in range(ny):
        for j in range(nx):
            yield (s + (n - s) * i / ny, w + (e - w) * j / nx, s + (n - s) * (i + 1) / ny, w + (e - w) * (j + 1) / nx)


def bb(t):
    return ",".join(f"{v:.5f}" for v in t)


def main():
    os.makedirs(os.path.join(DATA, "buildings"), exist_ok=True)
    path = os.path.join(DATA, "taipei_trunk.json")
    if not os.path.exists(path):
        d = query(f'[out:json][timeout:240];way({bb(BBOX)})[highway~"^(trunk|trunk_link)$"];out geom tags;', "trunk")
        json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        print("trunk ways", len(d["elements"]))
    path = os.path.join(DATA, "taipei_city.json")
    if not os.path.exists(path):
        els, seen = [], set()
        for k, t in enumerate(tiles(2, 2)):
            d = query(f'[out:json][timeout:240];way({bb(t)})[highway~"^({CITY})$"];out geom tags;', f"city {k}")
            for e in d["elements"]:
                if e["id"] not in seen:
                    seen.add(e["id"]); els.append(e)
            print(f"city tile {k}: total {len(els)}")
        json.dump({"elements": els}, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    for k, t in enumerate(tiles(4, 2)):
        path = os.path.join(DATA, "buildings", f"b{k}.json")
        if os.path.exists(path):
            continue
        d = query(f'[out:json][timeout:240];way({bb(t)})[building];out geom tags;', f"buildings {k}")
        json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"buildings tile {k}: {len(d['elements'])}")


if __name__ == "__main__":
    main()
