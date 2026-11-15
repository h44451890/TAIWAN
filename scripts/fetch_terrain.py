"""下載地形高程圖磚（AWS Open Data: Terrain Tiles, Terrarium 格式）。

高度 = (R * 256 + G + B / 256) - 32768  (公尺)
來源: https://registry.opendata.aws/terrain-tiles/
"""
import math
import os
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "terrain")
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# 台北段範圍 (南, 西, 北, 東)，與 OSM 查詢一致，外加一點邊界
BBOX = (23.99, 120.44, 25.21, 121.93)
ZOOM = 13


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return int(x), int(y)


def main():
    os.makedirs(OUT, exist_ok=True)
    s, w, n, e = BBOX
    x0, y0 = tile_xy(n, w, ZOOM)
    x1, y1 = tile_xy(s, e, ZOOM)
    tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    print(f"zoom {ZOOM}: x {x0}-{x1}, y {y0}-{y1}, {len(tiles)} tiles")
    sess = requests.Session()
    sess.headers["User-Agent"] = "terrain-fetch-script"
    for x, y in tiles:
        path = os.path.join(OUT, f"{ZOOM}_{x}_{y}.png")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        for attempt in range(4):
            try:
                r = sess.get(URL.format(z=ZOOM, x=x, y=y), timeout=60)
                r.raise_for_status()
                with open(path, "wb") as f:
                    f.write(r.content)
                break
            except Exception as ex:  # noqa: BLE001
                print("retry", x, y, ex, file=sys.stderr)
                time.sleep(2 ** attempt)
        else:
            sys.exit(f"failed tile {x},{y}")
    print("done ->", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
