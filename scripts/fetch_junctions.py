"""下載 OSM 交流道節點 (highway=motorway_junction: 出口編號 ref、名稱、destination) -> data/junctions_osm.json
範圍與 fetch_city.py 的 BBOX 相同。build_signs.py 用它來標出口編號與英文地名。"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fetch_city import BBOX, bb, query  # noqa: E402

d = query(f'[out:json][timeout:120];node({bb(BBOX)})["highway"="motorway_junction"];out body;', "junctions")
json.dump(d, open(os.path.join(HERE, "..", "data", "junctions_osm.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("junctions", len(d["elements"]))
