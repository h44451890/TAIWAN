"""擴大地圖: 只下載新增區域的國道、快速道路、一般道路、建築，合併進既有資料 (依 OSM id 去重)。

用法:
  python scripts/fetch_region.py 25.11,121.40,25.20,121.80 24.95,121.70,25.11,121.80
  (每個參數是一個矩形: 南,西,北,東)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fetch_city import CITY, query  # noqa: E402

DATA = os.path.join(HERE, "..", "data")


def bb(t):
    return ",".join(f"{v:.5f}" for v in t)


def merge(path, elements):
    d = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {"elements": []}
    seen = {e["id"] for e in d["elements"]}
    add = [e for e in elements if e["id"] not in seen]
    d["elements"] += add
    json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    return len(add)


def split(rect, n):
    s, w, nn, e = rect
    for i in range(n):
        for j in range(n):
            yield (s + (nn - s) * i / n, w + (e - w) * j / n, s + (nn - s) * (i + 1) / n, w + (e - w) * (j + 1) / n)


def main():
    rects = [tuple(float(v) for v in a.split(",")) for a in sys.argv[1:]]
    if not rects:
        sys.exit(__doc__)
    bdir = os.path.join(DATA, "buildings")
    os.makedirs(bdir, exist_ok=True)
    for r_i, rect in enumerate(rects):
        tag = "_".join(f"{v:.2f}" for v in rect)
        d = query(f'[out:json][timeout:240];way({bb(rect)})[highway~"^motorway(_link)?$"];out geom tags;', f"motorway {tag}")
        print(f"[{tag}] motorway +{merge(os.path.join(DATA, 'taipei_fwy.json'), d['elements'])}")
        d = query(f'[out:json][timeout:240];way({bb(rect)})[highway~"^(trunk|trunk_link)$"];out geom tags;', f"trunk {tag}")
        print(f"[{tag}] trunk +{merge(os.path.join(DATA, 'taipei_trunk.json'), d['elements'])}")
        d = query(f'[out:json][timeout:240];way({bb(rect)})[highway~"^({CITY})$"];out geom tags;', f"city {tag}")
        print(f"[{tag}] city roads +{merge(os.path.join(DATA, 'taipei_city.json'), d['elements'])}")
        for k, sub in enumerate(split(rect, 2)):
            path = os.path.join(bdir, f"x_{tag}_{k}.json")
            if os.path.exists(path):
                continue
            d = query(f'[out:json][timeout:240];way({bb(sub)})[building];out geom tags;', f"buildings {tag}/{k}")
            json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"[{tag}] buildings part {k}: {len(d['elements'])}")


if __name__ == "__main__":
    main()
