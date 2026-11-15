"""本機伺服器: 即時路況代理 + 手機定位同步 (遊戲 台灣.html <-> 電腦 <-> 手機，Wi-Fi 不用插線)

即時路況: GET /freeway-speed、GET /cms (代抓高公局即時資料，格式同 Smart-Nav-Map API)

遊戲每秒把車子的經緯度、速度、方向 POST 到這支程式，這支程式再把它設成手機的模擬定位，
Google Maps、神盾等 App 都會跟著遊戲裡的車子移動。

Android (預設): 透過 adb 無線偵錯 + Appium Settings (模擬位置應用程式)
iPhone:        透過 pymobiledevice3 的 developer dvt simulate-location (第一次需要 USB 配對)

用法:
  python scripts/phone_location.py                 # Android
  python scripts/phone_location.py --phone iphone  # iPhone
  python scripts/phone_location.py --dry-run       # 不連手機，只印出收到的座標 (測試用)
  python scripts/phone_location.py --adb C:\\platform-tools\\adb.exe --serial 192.168.1.23:41234

一次性設定步驟見 docs/phone-location.md。離開 (Ctrl+C) 時會自動清除手機的模擬定位。
"""
import argparse
import json
import math
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"target": None, "sent": None, "sent_at": 0.0, "device": None, "error": "", "count": 0, "clear": False}
LOCK = threading.Lock()
ARGS = None
APPIUM = "io.appium.settings"

# ---------------------------------------------------------------- 即時路況 / CMS 代理 (高公局沒開 CORS，瀏覽器不能直接抓)
# 回傳格式與 Smart-Nav-Map 的 api/freeway-speed.js、api/cms.js 相同，遊戲兩邊都能用。
import re
import urllib.request

TIS = "https://tisvcloud.freeway.gov.tw/history/motc20/"
FEED = {}          # 名稱 -> (抓取時間, 內容)
FEED_LOCK = threading.Lock()
FEED_TTL = {"Section": 6 * 3600, "CMS": 6 * 3600, "LiveTraffic": 55, "CMSLive": 55}


def feed(name):
    with FEED_LOCK:
        hit = FEED.get(name)
        if hit and time.time() - hit[0] < FEED_TTL[name]:
            return hit[1]
    try:
        req = urllib.request.Request(TIS + name + ".xml", headers={"User-Agent": "taiwan-1to1-local", "Accept-Encoding": "identity"})
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", "replace")
        with FEED_LOCK:
            FEED[name] = (time.time(), body)
        return body
    except Exception:  # noqa: BLE001
        if hit:
            return hit[1]   # 上游暫時連不到: 給上一次的
        raise


def _blocks(x, n):
    return re.findall(r"<%s>[\s\S]*?</%s>" % (n, n), x)


def _tag(b, n):
    m = re.search(r"<%s>([\s\S]*?)</%s>" % (n, n), b)
    if not m:
        return ""
    s = m.group(1).strip()
    for a, c in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")):
        s = s.replace(a, c)
    return s


def _mile(s):
    m = re.search(r"(\d+)K\+(\d+)", s or "", re.I)
    return int(m.group(1)) * 1000 + int(m.group(2)) if m else None


def next_update_ms(name):
    with FEED_LOCK:
        hit = FEED.get(name)
    return int(max(5, FEED_TTL[name] - (time.time() - hit[0])) * 1000) if hit else 60000


def freeway_speed():
    sec = feed("Section")
    live = {_tag(b, "SectionID"): b for b in _blocks(feed("LiveTraffic"), "LiveTraffic")}
    items = []
    for b in _blocks(sec, "Section"):
        lb = live.get(_tag(b, "SectionID"))
        s, e = _mile(_tag(b, "StartKM")), _mile(_tag(b, "EndKM"))
        if not lb or s is None or e is None:
            continue
        sp = _tag(lb, "TravelSpeed")
        items.append({"road": _tag(b, "RoadName"), "dir": _tag(b, "RoadDirection"), "s": s, "e": e,
                      "from": _tag(b, "Start"), "to": _tag(b, "End"), "limit": int(_tag(b, "SpeedLimit") or 0) or None,
                      "speed": int(sp) if sp.lstrip("-").isdigit() else -1, "level": int(_tag(lb, "CongestionLevel") or 0)})
    return {"updateTime": _tag(feed("LiveTraffic"), "UpdateTime"), "nextUpdateIn": next_update_ms("LiveTraffic"), "items": items}


def cms_live():
    pos = {}
    for b in _blocks(feed("CMS"), "CMS"):
        pos[_tag(b, "CMSID")] = b
    xml = feed("CMSLive")
    items = []
    for b in _blocks(xml, "CMSLive"):
        cid = _tag(b, "CMSID")
        p = pos.get(cid, "")
        items.append({"id": cid, "road": _tag(p, "RoadName"), "direction": _tag(p, "RoadDirection"), "mile": _tag(p, "LocationMile"),
                      "status": _tag(b, "Status"), "messageStatus": _tag(b, "MessageStatus"), "collectedAt": _tag(b, "DataCollectTime"),
                      "messages": [{"text": _tag(m, "Text"), "type": _tag(m, "Type"), "priority": _tag(m, "Priority")} for m in _blocks(b, "Message")]})
    return {"updateTime": _tag(xml, "UpdateTime"), "nextUpdateIn": next_update_ms("CMSLive"), "count": len(items), "items": items}


def run(cmd, timeout=20):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0 or "Error" in out or "Exception" in out:
        lines = [l for l in out.strip().splitlines() if l.strip()]
        raise RuntimeError(lines[-1] if lines else f"exit {r.returncode}")
    return out


# ---------------------------------------------------------------- Android (adb)
def adb(*args, timeout=15):
    base = [ARGS.adb] + (["-s", ARGS.serial] if ARGS.serial else [])
    return run(base + list(args), timeout=timeout)


def android_prepare():
    adb("shell", "appops", "set", APPIUM, "android:mock_location", "allow")   # 等同在開發者選項選它當模擬位置應用程式


def android_set(lat, lon, speed, course):
    adb("shell", "am", "start-foreground-service", "--user", "0", "-n", f"{APPIUM}/.LocationService",
        "--es", "latitude", f"{lat:.7f}", "--es", "longitude", f"{lon:.7f}", "--es", "altitude", "10",
        "--es", "speed", f"{speed:.2f}", "--es", "bearing", f"{course:.1f}", "--es", "accuracy", "3")


def android_clear():
    # am stopservice 成功時也可能回傳 255 ("Service stopped")；服務本來就沒在跑也算清除成功
    base = [ARGS.adb] + (["-s", ARGS.serial] if ARGS.serial else [])
    r = subprocess.run(base + ["shell", "am", "stopservice", f"{APPIUM}/.LocationService"], capture_output=True, text=True, timeout=15)
    out = (r.stdout or "") + (r.stderr or "")
    if "Service stopped" not in out and "not found" not in out.lower() and r.returncode not in (0, 255):
        raise RuntimeError(out.strip().splitlines()[-1] if out.strip() else f"exit {r.returncode}")


# ---------------------------------------------------------------- iPhone (pymobiledevice3)
def pmd(*cmd, timeout=20):
    return run([sys.executable, "-m", "pymobiledevice3", "developer", "dvt", "simulate-location", *cmd], timeout=timeout)


def iphone_set(lat, lon, speed, course):
    pmd("set", "--tunnel", ARGS.serial or "", "--", f"{lat:.7f}", f"{lon:.7f}")


def iphone_clear():
    pmd("clear", "--tunnel", ARGS.serial or "")


# ---------------------------------------------------------------- 共用
def set_location(lat, lon, speed=0.0, course=0.0):
    if ARGS.dry_run:
        print(f"[dry-run] set {lat:.7f}, {lon:.7f}  {speed * 3.6:.0f} km/h  {course:.0f}°")
    elif ARGS.phone == "android":
        android_set(lat, lon, speed, course)
    else:
        iphone_set(lat, lon, speed, course)


def clear_location():
    if ARGS.dry_run:
        print("[dry-run] clear")
    elif ARGS.phone == "android":
        android_clear()
    else:
        iphone_clear()


def dist_m(a, b):
    kx = 111320 * math.cos(math.radians(a[0]))
    return math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * 110540)


def worker():
    """背景: 有新座標 (移動超過 2 m 或超過 5 秒) 就送到手機；一次送一筆，自然限速。"""
    prepared = False
    while True:
        time.sleep(0.1)
        with LOCK:
            tgt, sent, sent_at, want_clear = STATE["target"], STATE["sent"], STATE["sent_at"], STATE["clear"]
            STATE["clear"] = False
        try:
            if want_clear:
                clear_location()
                with LOCK:
                    STATE.update(sent=None, target=None, device=True, error="")
                print("已清除手機模擬定位")
                continue
            if tgt is None:
                continue
            if sent is not None and dist_m(tgt, sent) < 0.5 and abs(tgt[3] - sent[3]) < 2 and time.time() - sent_at < 2:
                continue
            if ARGS.phone == "android" and not ARGS.dry_run and not prepared:
                android_prepare()
                prepared = True
            set_location(*tgt)
            with LOCK:
                STATE.update(sent=tgt, sent_at=time.time(), device=True, error="", count=STATE["count"] + 1)
        except subprocess.TimeoutExpired:
            with LOCK:
                STATE.update(device=False, error="手機沒有回應 (逾時)")
        except Exception as ex:  # noqa: BLE001
            with LOCK:
                STATE.update(device=False, error=str(ex)[:200])
            print("送出失敗:", ex)
            prepared = False
            time.sleep(2)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")   # 讓 https 網頁 (GitHub Pages) 也能連本機

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/freeway-speed") or self.path.startswith("/cms"):
            try:
                data = freeway_speed() if self.path.startswith("/freeway-speed") else cms_live()
                return self._json(200, {"ok": True, "data": data})
            except Exception as ex:  # noqa: BLE001
                return self._json(502, {"ok": False, "error": "無法取得高公局資料: " + str(ex)[:150]})
        with LOCK:
            st = dict(STATE)
        self._json(200, {"ok": True, "phone": ARGS.phone, "dryRun": ARGS.dry_run, "device": st["device"], "error": st["error"],
                         "target": st["target"], "sent": st["sent"], "count": st["count"]})

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"ok": False, "error": "JSON 格式錯誤"})
        if self.path.startswith("/clear"):
            with LOCK:
                STATE["clear"] = True
            return self._json(200, {"ok": True})
        if self.path.startswith("/loc"):
            try:
                lat, lon = float(data["lat"]), float(data["lon"])
                speed, course = float(data.get("speed", 0) or 0), float(data.get("course", 0) or 0)
            except (KeyError, TypeError, ValueError):
                return self._json(400, {"ok": False, "error": "需要 lat, lon"})
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                return self._json(400, {"ok": False, "error": "座標超出範圍"})
            with LOCK:
                STATE["target"] = (lat, lon, max(0.0, speed), course % 360)
                dev, err = STATE["device"], STATE["error"]
            return self._json(200, {"ok": True, "device": dev is not False, "error": err})
        self._json(404, {"ok": False, "error": "unknown path"})

    def log_message(self, fmt, *a):
        pass


def find_adb():
    """常見的 adb 位置: PATH、C:\\platform-tools、下載資料夾裡解壓縮的 platform-tools、Android Studio SDK。"""
    import os
    home, local = os.path.expanduser("~"), os.environ.get("LOCALAPPDATA", "")
    for p in [shutil.which("adb"), r"C:\platform-tools\adb.exe",
              os.path.join(home, "Downloads", "platform-tools-latest-windows", "platform-tools", "adb.exe"),
              os.path.join(home, "Downloads", "platform-tools", "adb.exe"),
              os.path.join(local, "Android", "Sdk", "platform-tools", "adb.exe")]:
        if p and os.path.exists(p):
            return p
    return "adb"


def main():
    global ARGS
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description="台灣 1:1 -> 手機模擬定位 (Wi-Fi)")
    ap.add_argument("--phone", choices=["android", "iphone"], default="android")
    ap.add_argument("--host", default="127.0.0.1", help="預設只接受本機的遊戲；0.0.0.0 讓同網路其他電腦上的遊戲也能送")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--adb", default=find_adb(), help="adb.exe 的路徑 (預設自動尋找)")
    ap.add_argument("--serial", default="", help="Android: adb 裝置 (例如 192.168.1.23:41234)；iPhone: UDID")
    ap.add_argument("--dry-run", action="store_true", help="不連手機，只印出座標")
    ARGS = ap.parse_args()
    threading.Thread(target=worker, daemon=True).start()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    mode = "dry-run，不連手機" if ARGS.dry_run else ("Android / adb: " + ARGS.adb if ARGS.phone == "android" else "iPhone / pymobiledevice3")
    print(f"手機定位同步橋接程式已啟動: http://{ARGS.host}:{ARGS.port}  ({mode})")
    print("在遊戲裡按 L 開始同步；按 Ctrl+C 結束 (會自動清除手機模擬定位)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            clear_location()
            print("已清除手機模擬定位")
        except Exception as ex:  # noqa: BLE001
            print("清除模擬定位失敗:", ex)


if __name__ == "__main__":
    main()
