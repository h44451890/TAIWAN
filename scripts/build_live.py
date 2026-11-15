"""即時路況 / CMS 看板 / ETC 門架 / 電台 -> web/extra/live.json

資料來源 (高公局 tisvcloud，免金鑰；與 Smart-Nav-Map api/freeway-speed.js、api/cms.js 同一份):
  Section.xml、LiveTraffic.xml (路段車速，每分鐘)、CMS.xml、CMSLive.xml (電子看板，每分鐘)
  smart-nav-map/etc_gantry_data.js (ETC 門架位置)

做法: 用 CMS 與門架 (都有經緯度 + 里程) 當里程錨點，把每段 OSM 主線對應到 (路名, 方向, 里程)，
網頁再用里程查路段車速；網頁開啟時若連得到 Smart-Nav-Map 後端，會改用即時資料每分鐘更新。
"""
import json
import math
import os
import re
import sys
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from prep_freeway import BBOX, DATA, local_xy  # noqa: E402

LIVE = os.path.join(DATA, "live")
TIS = "https://tisvcloud.freeway.gov.tw/history/motc20/"
OUT = os.path.join(ROOT, "web", "extra", "live.json")

# 警察廣播電台 (Smart-Nav-Map 智行地圖.html / 測試.html)
RADIO = {
    "base": "https://stream.pbs.gov.tw:443/live/",
    "stations": [
        {"code": "mp3:PBS", "name": "全國治安交通網", "freq": "104.9"},
        {"code": "TPS", "name": "臺北分臺", "freq": "94.3"},
        {"code": "TCS", "name": "臺中分臺", "freq": "94.5"},
        {"code": "KSS", "name": "高雄分臺", "freq": "93.1"},
        {"code": "ELS", "name": "宜蘭分臺", "freq": "101.3"},
        {"code": "HLS", "name": "花蓮分臺", "freq": "94.3"},
        {"code": "TTS", "name": "臺東分臺", "freq": "94.3"},
        {"code": "SCS", "name": "新竹分臺", "freq": "94.9"},
        {"code": "TNS", "name": "臺南分臺", "freq": "94.7"},
    ],
}
GANTRY_ROAD = {"01F": "國道1號", "01H": "國道1號汐止五股高架道路", "03F": "國道3號", "03A": "國道3甲", "05F": "國道5號"}


def fetch(name, refresh):
    path = os.path.join(LIVE, name + ".xml")
    if refresh or not os.path.exists(path):
        os.makedirs(LIVE, exist_ok=True)
        req = urllib.request.Request(TIS + name + ".xml", headers={"User-Agent": "taiwan-1to1-build"})
        with urllib.request.urlopen(req, timeout=60) as r:
            open(path, "wb").write(r.read())
    return open(path, encoding="utf-8").read()


def blocks(x, n):
    return re.findall(r"<%s>[\s\S]*?</%s>" % (n, n), x)


def tag(b, n):
    m = re.search(r"<%s>([\s\S]*?)</%s>" % (n, n), b)
    if not m:
        return ""
    s = m.group(1).strip()
    for a, c in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")):
        s = s.replace(a, c)
    return s


def mile_m(s):
    m = re.search(r"(\d+)K\+(\d+)", s or "", re.I)
    return int(m.group(1)) * 1000 + int(m.group(2)) if m else None


def way_road(w):
    ref, name = w["ref"], w["name"] or ""
    if ref == "1":
        return "國道1號汐止五股高架道路" if "汐止五股" in name else "國道1號"
    return {"3": "國道3號", "3甲": "國道3甲", "5": "國道5號"}.get(ref)


def main():
    refresh = "--offline" not in sys.argv
    sec_xml, live_xml = fetch("Section", refresh), fetch("LiveTraffic", refresh)
    cms_xml, cmsl_xml = fetch("CMS", refresh), fetch("CMSLive", refresh)
    roads = set(GANTRY_ROAD.values())

    # ---- 路段車速
    live = {tag(b, "SectionID"): b for b in blocks(live_xml, "LiveTraffic")}
    sections = []
    for b in blocks(sec_xml, "Section"):
        road = tag(b, "RoadName")
        if road not in roads:
            continue
        lb = live.get(tag(b, "SectionID"), "")
        sp = tag(lb, "TravelSpeed")
        sections.append(dict(road=road, dir=tag(b, "RoadDirection"), s=mile_m(tag(b, "StartKM")), e=mile_m(tag(b, "EndKM")),
                             **{"from": tag(b, "Start"), "to": tag(b, "End")}, limit=int(tag(b, "SpeedLimit") or 0) or None,
                             speed=int(sp) if sp.lstrip("-").isdigit() else -1, level=int(tag(lb, "CongestionLevel") or 0)))

    # ---- 錨點 (CMS + 門架)
    anchors = {}
    cms_pos = {}
    for b in blocks(cms_xml, "CMS"):
        road, m = tag(b, "RoadName"), mile_m(tag(b, "LocationMile"))
        lat, lon = float(tag(b, "PositionLat") or 0), float(tag(b, "PositionLon") or 0)
        cms_pos[tag(b, "CMSID")] = dict(road=road, dir=tag(b, "RoadDirection"), m=m, lat=lat, lon=lon,
                                        section=tag(b, "Start") + " → " + tag(b, "End"))
        if road in roads and m is not None and lat:
            anchors.setdefault(road, []).append((m, lat, lon))
    g_src = open(os.path.join(ROOT, "smart-nav-map", "etc_gantry_data.js"), encoding="utf-8").read()
    g_src = g_src[g_src.index("window.ETC_GANTRY"):]
    gantries = json.loads(g_src[g_src.index("["):g_src.rindex("]") + 1])
    for lon, lat, d, gid, brg in gantries:
        road = GANTRY_ROAD.get(gid[:3]) if gid[3:7].isdigit() else None
        if road:
            anchors.setdefault(road, []).append((int(gid[3:7]) * 100, lat, lon))
    poly = {}
    for road, a in anchors.items():
        a.sort()
        arr = np.array(a)
        x, y = local_xy(arr[:, 1], arr[:, 2])
        poly[road] = (arr[:, 0], np.asarray(x), np.asarray(y))
    if "國道1號汐止五股高架道路" not in poly:
        poly["國道1號汐止五股高架道路"] = poly["國道1號"]

    def mileage_at(road, x, y, tx, ty):
        m, px, py = poly[road]
        best = None
        for i in range(len(m) - 1):
            dx, dy = px[i + 1] - px[i], py[i + 1] - py[i]
            L2 = dx * dx + dy * dy
            if L2 < 1:
                continue
            t = min(max(((x - px[i]) * dx + (y - py[i]) * dy) / L2, 0), 1)
            d = math.hypot(px[i] + dx * t - x, py[i] + dy * t - y)
            if best is None or d < best[0]:
                inc = (dx * tx + dy * ty) * (1 if m[i + 1] >= m[i] else -1)
                best = (d, m[i] + (m[i + 1] - m[i]) * t, inc)
        return best

    # ---- 每段主線 -> (路名, 方向, 里程)
    prep = json.load(open(os.path.join(DATA, "freeway_prep.json"), encoding="utf-8"))
    way_map = []
    for w in prep["ways"]:
        road = way_road(w) if w["highway"] == "motorway" else None
        if not road:
            way_map.append(None)
            continue
        P = np.array(w["pts"])
        k = len(P) // 2
        a, b = P[max(k - 1, 0)], P[min(k + 1, len(P) - 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1
        r = mileage_at(road, P[k][0], P[k][1], tx / L, ty / L)
        if not r or r[0] > 500:
            way_map.append(None)
            continue
        ew = road == "國道3甲"
        d = ("E" if ew else "S") if r[2] > 0 else ("W" if ew else "N")
        way_map.append([road, d, int(round(r[1]))])

    # ---- 放置 CMS / 門架: 吸附到同路同向主線的最近點
    ways = prep["ways"]
    s, wlon, n, elon = BBOX

    def snap(road, d, lat, lon, maxd=70):
        x, y = local_xy(lat, lon)
        best = None
        for k, w in enumerate(ways):
            mp = way_map[k]
            if not mp or mp[1] != d or (road and mp[0] != road and not (road.startswith("國道1號") and mp[0].startswith("國道1號"))):
                continue
            P = np.array(w["pts"])
            dd = np.hypot(P[:, 0] - x, P[:, 1] - y)
            i = int(np.argmin(dd))
            if dd[i] < maxd and (best is None or dd[i] < best[0]):
                best = (dd[i], k, i)
        return best

    cms = []
    msgs = {tag(b, "CMSID"): b for b in blocks(cmsl_xml, "CMSLive")}
    for cid, p in cms_pos.items():
        if p["road"] not in roads or not (s < p["lat"] < n and wlon < p["lon"] < elon):
            continue
        sn = snap(p["road"], p["dir"], p["lat"], p["lon"])
        if not sn:
            continue
        mb = msgs.get(cid, "")
        pages = [dict(text=tag(m, "Text"), type=tag(m, "Type")) for m in blocks(mb, "Message") if tag(m, "Text")]
        cms.append(dict(id=cid, road=p["road"], dir=p["dir"], m=p["m"], section=p["section"], way=sn[1], idx=sn[2], pages=pages))
    etc = []
    for lon, lat, d, gid, brg in gantries:
        road = GANTRY_ROAD.get(gid[:3]) if gid[3:7].isdigit() else None
        if not road or not (s < lat < n and wlon < lon < elon):
            continue
        sn = snap(road, d, lat, lon)
        if sn:
            etc.append(dict(id=gid, road=road, dir=d, m=int(gid[3:7]) * 100, way=sn[1], idx=sn[2]))

    # 起點: 國1 南下 0K (基隆端) 為預設；汐五高架底下 (CMS 15.8K 前 170 m) 放進傳送選單
    def spawn_near_cms(cid, back_m):
        for c in cms:
            if c["id"] == cid:
                P = np.array(ways[c["way"]]["pts"])
                s_ = np.r_[0, np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))]
                i = int(np.searchsorted(s_, max(s_[c["idx"]] - back_m, 0)))
                return [c["way"], min(max(i, 1), len(P) - 2)]
        return None

    def spawn_near_ll(road, d, lat, lon):
        """沒有看板時: 找同路同向主線上最近的點。"""
        x, y = local_xy(lat, lon)
        best = None
        for k, w in enumerate(ways):
            mp = way_map[k]
            if not mp or mp[0] != road or mp[1] != d:
                continue
            P = np.array(w["pts"])
            dd = np.hypot(P[:, 0] - x, P[:, 1] - y)
            i = int(dd.argmin())
            if best is None or dd[i] < best[0]:
                best = (dd[i], k, min(max(i, 1), len(P) - 2))
        return [best[1], best[2]] if best and best[0] < 800 else None

    spawn = spawn_near_cms("CMS-N1-S-0.000-M", 0) or spawn_near_ll("國道1號", "S", 25.1231, 121.7358)
    spawn_xiwu = spawn_near_cms("CMS-N1-S-15.800-M", 170)
    print("default spawn (國1 0K 基隆):", spawn, " 汐五高架下:", spawn_xiwu)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out = dict(updateTime=tag(live_xml, "UpdateTime"), cmsUpdateTime=tag(cmsl_xml, "UpdateTime"),
               apiBase="https://node-1.tailfdfee1.ts.net/api", sections=sections, wayMap=way_map,
               cms=cms, etc=etc, radio=RADIO, spawn=spawn, spawnXiwu=spawn_xiwu)
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    mapped = sum(1 for x in way_map if x)
    main_n = sum(1 for w in ways if w["highway"] == "motorway")
    print(f"sections {len(sections)} (update {out['updateTime']})")
    print(f"mainline ways mapped {mapped}/{main_n}; CMS placed {len(cms)} (with message {sum(1 for c in cms if c['pages'])}); ETC gantries placed {len(etc)}")
    lv = [x for x in sections if x["speed"] > 0]
    print("sample:", [(x["road"], x["dir"], x["from"], x["to"], x["speed"], x["level"]) for x in lv if x["road"] == "國道1號"][:6])


if __name__ == "__main__":
    main()
