"""下載 OSM 地名 (導航目的地) -> data/places_osm.json

城市、鄉鎮、區、里 (place=city/town/suburb/quarter/village)、火車站 (railway=station)、國道服務區 (highway=services/rest_area)。
範圍與 fetch_city.py 的 BBOX 相同。build_nav.mjs 會把每個地名接到最近的道路上。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fetch_city import BBOX, bb, query  # noqa: E402

q = f"""[out:json][timeout:180];
(
  node({bb(BBOX)})["place"~"^(city|town|suburb|quarter|village)$"]["name"];
  node({bb(BBOX)})["railway"="station"]["name"];
  nwr({bb(BBOX)})["highway"~"^(services|rest_area)$"]["name"];
);
out center tags;"""
d = query(q, "places")
for e in d["elements"]:   # 面狀的服務區用中心點
    if "lat" not in e and "center" in e:
        e["lat"], e["lon"] = e["center"]["lat"], e["center"]["lon"]
json.dump(d, open(os.path.join(HERE, "..", "data", "places_osm.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("places", len(d["elements"]))
