"""把網頁資料切成分區 (tiles)，讓遊戲只載入車子附近的區塊。

輸入 (export_web.py 的輸出):
  data/web_meta.json + data/web_data.bin   國道 / 快速道路、橋墩、地形
  data/city_meta.json + data/city.bin      一般道路、3D 建築
輸出:
  tiles/index.json        全域資訊 (原點、地形網格、分區清單、傳送地點)
  tiles/t/{tx}_{ty}.bin   地形: Int16 (0.1 m)，(TC+3)x(TC+3) 個樣本 (含 1 格外框，法向才不會有接縫)
  tiles/d/{tx}_{ty}.bin   細節: 路段 + 橋墩 + 建築 (格式見 pack_detail)

分區大小 = TC 格 x 30 m = 3840 m。每個路段 / 建築依中點歸屬一個分區，路段不切開；
路段有全域編號 gid (國道 = 原本的索引，一般道路 = 國道數 + 原本的索引)，live.json 的 wayMap 照用。
"""
import json
import os
import struct

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "tiles")
TC = 128            # 每個分區的地形格數
STEP = 30.0
TS = TC * STEP      # 3840 m


def tkey(tx, ty):
    return f"{tx}_{ty}"


def tile_of(x, y):
    return int(np.floor(x / TS)), int(np.floor(y / TS))


def load():
    fm = json.load(open(os.path.join(DATA, "web_meta.json"), encoding="utf-8"))
    fb = open(os.path.join(DATA, "web_data.bin"), "rb").read()
    NW, NP, NPI = fm["nways"], fm["npts"], fm["npiers"]
    TG = fm["terrain"]
    o = 0
    counts = np.frombuffer(fb, np.int32, NW, o); o += NW * 4
    pts = np.frombuffer(fb, np.float32, NP * 3, o).reshape(-1, 3); o += NP * 12
    under = np.frombuffer(fb, np.float32, NP, o); o += NP * 4
    piers = np.frombuffer(fb, np.float32, NPI * 9, o).reshape(-1, 9); o += NPI * 36
    hz = np.frombuffer(fb, np.int16, TG["w"] * TG["h"], o).reshape(TG["h"], TG["w"]); o += TG["w"] * TG["h"] * 2
    emask = np.frombuffer(fb, np.uint8, NP, o)
    fwy = dict(meta=fm, counts=counts, pts=pts, under=under, piers=piers, hz=hz, emask=emask)

    city = None
    if os.path.exists(os.path.join(DATA, "city_meta.json")):
        cm = json.load(open(os.path.join(DATA, "city_meta.json"), encoding="utf-8"))
        cb = open(os.path.join(DATA, "city.bin"), "rb").read()
        n, nb, npt, nbv = cm["nways"], cm["nb"], cm["npts"], cm["nbv"]
        o = 0
        cc = np.frombuffer(cb, np.int32, n, o); o += n * 4
        rxy0 = np.frombuffer(cb, np.float32, n * 2, o).reshape(-1, 2); o += n * 8
        bxy0 = np.frombuffer(cb, np.float32, nb * 2, o).reshape(-1, 2); o += nb * 8
        bbase = np.frombuffer(cb, np.float32, nb, o); o += nb * 4
        bh = np.frombuffer(cb, np.float32, nb, o); o += nb * 4
        roff = np.frombuffer(cb, np.int16, npt * 2, o).reshape(-1, 2); o += npt * 4
        rz = np.frombuffer(cb, np.int16, npt, o); o += npt * 2
        boff = np.frombuffer(cb, np.int16, nbv * 2, o).reshape(-1, 2); o += nbv * 4
        bcnt = np.frombuffer(cb, np.uint16, nb, o); o += nb * 2
        bcol = np.frombuffer(cb, np.uint8, nb, o)
        city = dict(meta=cm, cc=cc, rxy0=rxy0, bxy0=bxy0, bbase=bbase, bh=bh, roff=roff, rz=rz, boff=boff, bcnt=bcnt, bcol=bcol)
    return fwy, city


def pack_detail(t):
    """細節分區二進位: uint32 JSON 長度 + JSON (補齊 4 bytes) + 資料區
    資料區順序 (先 4-byte 型別，再 2-byte，再 1-byte，免對齊問題):
      fP f32[np*3]  fU f32[np]  piers f32[npier*9]  rxy0 f32[ncw*2]  bxy0 f32[nb*2]  bbase f32[nb]  bh f32[nb]
      roff i16[cnp*2]  rz i16[cnp]  boff i16[nbv*2]  bcnt u16[nb]  emask u8[np]  bcol u8[nb]
    """
    head = dict(fw=t["fw"], fc=t["fc"], np=int(sum(t["fc"])), npier=len(t["piers"]) // 9,
                cw=t["cw"], cc=t["cc"], cnp=int(sum(t["cc"])), nb=len(t["bcnt"]), nbv=int(sum(t["bcnt"])))
    js = json.dumps(head, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    parts = [struct.pack("<I", len(js)), js]
    f32 = lambda a: np.asarray(a, np.float32).tobytes()
    i16 = lambda a: np.asarray(a, np.int16).tobytes()
    parts += [f32(t["fP"]), f32(t["fU"]), f32(t["piers"]), f32(t["rxy0"]), f32(t["bxy0"]), f32(t["bbase"]), f32(t["bh"]),
              i16(t["roff"]), i16(t["rz"]), i16(t["boff"]), np.asarray(t["bcnt"], np.uint16).tobytes(),
              np.asarray(t["emask"], np.uint8).tobytes(), np.asarray(t["bcol"], np.uint8).tobytes()]
    return b"".join(parts)


def new_tile():
    return dict(fw=[], fc=[], fP=[], fU=[], emask=[], piers=[], cw=[], cc=[], rxy0=[], roff=[], rz=[],
                bxy0=[], bbase=[], bh=[], boff=[], bcnt=[], bcol=[])


def main():
    fwy, city = load()
    fm, TG = fwy["meta"], fwy["meta"]["terrain"]
    NW = fm["nways"]
    tiles = {}
    get = lambda k: tiles.setdefault(k, new_tile())
    way_tile = {}       # gid -> (tile key, 路段在分區內的序號)

    # ---- 國道 / 快速道路
    o = 0
    for k in range(NW):
        n = int(fwy["counts"][k])
        P = fwy["pts"][o:o + n]
        mx, my = P[n // 2, 0], P[n // 2, 1]
        key = tkey(*tile_of(mx, my))
        t = get(key)
        way_tile[k] = key
        t["fw"].append([k] + fm["ways"][k])
        t["fc"].append(n)
        t["fP"].append(P.ravel()); t["fU"].append(fwy["under"][o:o + n]); t["emask"].append(fwy["emask"][o:o + n])
        o += n
    for p in fwy["piers"]:
        get(tkey(*tile_of(p[0], p[1])))["piers"].append(p)

    # ---- 一般道路 + 建築
    if city:
        cm = city["meta"]
        o = 0
        for k in range(cm["nways"]):
            n = int(city["cc"][k])
            x0, y0 = city["rxy0"][k]
            mi = o + n // 2
            mx, my = x0 + city["roff"][mi, 0] * 0.1, y0 + city["roff"][mi, 1] * 0.1
            key = tkey(*tile_of(mx, my))
            t = get(key)
            way_tile[NW + k] = key
            t["cw"].append([NW + k] + cm["ways"][k])
            t["cc"].append(n)
            t["rxy0"].append(city["rxy0"][k]); t["roff"].append(city["roff"][o:o + n]); t["rz"].append(city["rz"][o:o + n])
            o += n
        o = 0
        for b in range(cm["nb"]):
            n = int(city["bcnt"][b])
            off = city["boff"][o:o + n].astype(np.float64) * 0.1
            cx, cy = city["bxy0"][b] + off.mean(axis=0)
            t = get(tkey(*tile_of(cx, cy)))
            t["bxy0"].append(city["bxy0"][b]); t["bbase"].append(city["bbase"][b]); t["bh"].append(city["bh"][b])
            t["boff"].append(city["boff"][o:o + n]); t["bcnt"].append(n); t["bcol"].append(city["bcol"][b])
            o += n

    for sub in ("d", "t"):     # 只刪舊檔、不刪資料夾 (OneDrive 會鎖住資料夾)
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)
        for f in os.listdir(os.path.join(OUT, sub)):
            os.remove(os.path.join(OUT, sub, f))

    # ---- 寫出細節分區
    cat = lambda lst, shape: np.concatenate(lst).reshape(shape) if lst else np.zeros(shape if shape[0] != -1 else (0,) + shape[1:], np.float32)
    dsz = {}
    for key, t in tiles.items():
        tt = dict(fw=t["fw"], fc=t["fc"], cw=t["cw"], cc=t["cc"], bcnt=t["bcnt"],
                  fP=np.concatenate(t["fP"]) if t["fP"] else np.zeros(0),
                  fU=np.concatenate(t["fU"]) if t["fU"] else np.zeros(0),
                  emask=np.concatenate(t["emask"]) if t["emask"] else np.zeros(0),
                  piers=np.concatenate(t["piers"]) if t["piers"] else np.zeros(0),
                  rxy0=np.concatenate(t["rxy0"]) if t["rxy0"] else np.zeros(0),
                  roff=np.concatenate(t["roff"]).ravel() if t["roff"] else np.zeros(0),
                  rz=np.concatenate(t["rz"]) if t["rz"] else np.zeros(0),
                  bxy0=np.concatenate(t["bxy0"]) if t["bxy0"] else np.zeros(0),
                  bbase=np.array(t["bbase"]), bh=np.array(t["bh"]),
                  boff=np.concatenate(t["boff"]).ravel() if t["boff"] else np.zeros(0),
                  bcol=np.array(t["bcol"]))
        blob = pack_detail(tt)
        open(os.path.join(OUT, "d", key + ".bin"), "wb").write(blob)
        dsz[key] = len(blob)

    # ---- 地形分區 (全域格點 J = x/30；分區 tx 的樣本 J = tx*TC-1 .. tx*TC+TC+1)
    J0 = int(round(TG["x0"] / STEP)); I0 = int(round(TG["y0"] / STEP))
    W, H = TG["w"], TG["h"]
    hz = fwy["hz"]
    N = TC + 3
    tsz = {}
    tx0, tx1 = int(np.floor(J0 / TC)), int(np.floor((J0 + W - 2) / TC))
    ty0, ty1 = int(np.floor(I0 / TC)), int(np.floor((I0 + H - 2) / TC))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            jj = np.clip(np.arange(tx * TC - 1, tx * TC + TC + 2) - J0, 0, W - 1)
            ii = np.clip(np.arange(ty * TC - 1, ty * TC + TC + 2) - I0, 0, H - 1)
            win = hz[np.ix_(ii, jj)]
            assert win.shape == (N, N)
            key = tkey(tx, ty)
            open(os.path.join(OUT, "t", key + ".bin"), "wb").write(np.ascontiguousarray(win, np.int16).tobytes())
            tsz[key] = N * N * 2

    # ---- 傳送地點 (附座標，載入器才知道要先載哪幾區)
    def way_xy(gid, idx):
        if gid < NW:
            o = int(np.sum(fwy["counts"][:gid])) + idx
            return float(fwy["pts"][o, 0]), float(fwy["pts"][o, 1])
        k = gid - NW
        o = int(np.sum(city["cc"][:k])) + idx
        return float(city["rxy0"][k, 0] + city["roff"][o, 0] * 0.1), float(city["rxy0"][k, 1] + city["roff"][o, 1] * 0.1)

    spawns = []
    live_p = os.path.join(ROOT, "web", "extra", "live.json")
    live = json.load(open(live_p, encoding="utf-8")) if os.path.exists(live_p) else {}
    if live.get("spawn"):
        spawns.append(["基隆 · 國1 起點 0K（南下）", live["spawn"][0], live["spawn"][1], 1, *way_xy(*live["spawn"])])
    if live.get("spawnXiwu"):
        spawns.append(["國1 汐五高架下（東湖→內湖）", live["spawnXiwu"][0], live["spawnXiwu"][1], 1, *way_xy(*live["spawnXiwu"])])
    if city:
        for name, kind, wi, pi, d in city["meta"].get("spawns", []):
            gid = NW + wi if kind == "city" else wi
            spawns.append([name, gid, pi, d, *way_xy(gid, pi)])

    index = dict(version=1, ts=TS, tc=TC, step=STEP, origin_twd97=fm["origin_twd97"], source=fm.get("source"),
                 terrain=dict(J0=J0, I0=I0, w=W, h=H), nfwy=NW, nways=NW + (city["meta"]["nways"] if city else 0),
                 detail=dsz, tiles_t=tsz, spawns=spawns)
    json.dump(index, open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"detail tiles {len(dsz)} ({sum(dsz.values()) / 1e6:.1f} MB, max {max(dsz.values()) / 1e6:.2f} MB), "
          f"terrain tiles {len(tsz)} ({sum(tsz.values()) / 1e6:.1f} MB), spawns {len(spawns)}")


if __name__ == "__main__":
    main()
