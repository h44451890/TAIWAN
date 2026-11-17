"""下載 OSM 測速照相 -> data/cameras_osm.json

- 固定式測速照相: node highway=speed_camera (maxspeed、direction 可有可無)
- 測速執法關係: relation type=enforcement (enforcement=maxspeed / average_speed)，成員 device (相機)、from / to (區間測速起訖)
範圍與 fetch_city.py 的 BBOX 相同。build_cameras.py 再把它們對到遊戲路段上。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fetch_city import BBOX, bb, query  # noqa: E402

q = f"""[out:json][timeout:180];
(
  node({bb(BBOX)})["highway"="speed_camera"];
  relation({bb(BBOX)})["type"="enforcement"];
);
out body;
>;
out skel qt;"""
d = query(q, "cameras")
json.dump(d, open(os.path.join(HERE, "..", "data", "cameras_osm.json"), "w", encoding="utf-8"), ensure_ascii=False)
els = d["elements"]
print("speed_camera nodes", sum(1 for e in els if e["type"] == "node" and e.get("tags", {}).get("highway") == "speed_camera"))
print("enforcement relations", sum(1 for e in els if e["type"] == "relation"))
