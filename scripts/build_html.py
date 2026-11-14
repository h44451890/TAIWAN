"""把引擎、資料、程式打包成單一檔案 台灣.html (離線可用)。"""
import base64
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")


def three_classic():
    """three.module.min.js (ES module) -> 一般 <script>，掛在 window.THREE。"""
    src = open(os.path.join(WEB, "vendor", "three.module.min.js"), encoding="utf-8").read()
    i = src.rindex("export{")
    body, tail = src[:i], src[i + len("export{"):]
    items = tail[:tail.rindex("}")].split(",")
    pairs = []
    for it in items:
        it = it.strip()
        if not it:
            continue
        local, _, name = it.partition(" as ")
        pairs.append(f"{(name or local).strip()}:{local.strip()}")
    return 'window.THREE=(function(){"use strict";\n' + body + "\nreturn{" + ",".join(pairs) + "};})();"


def safe(js, label):
    if re.search(r"</script", js, re.I) or "<!--" in js:
        raise SystemExit(f"{label} contains an HTML-unsafe sequence")
    return js


def main():
    tpl = open(os.path.join(WEB, "template.html"), encoding="utf-8").read()
    meta = open(os.path.join(DATA, "web_meta.json"), encoding="utf-8").read().replace("</", "<\\/")
    data = base64.b64encode(open(os.path.join(DATA, "web_data.bin"), "rb").read()).decode("ascii")
    parts = {
        "META_JSON": meta,
        "DATA_B64": data,
        "THREE_JS": safe(three_classic(), "three.js"),
        "APP_JS": safe(open(os.path.join(WEB, "app.js"), encoding="utf-8").read(), "app.js"),
        "CITY_META": (open(os.path.join(DATA, "city_meta.json"), encoding="utf-8").read().replace("</", "<\/")
                      if os.path.exists(os.path.join(DATA, "city_meta.json")) else "{}"),
        "CITY_B64": (base64.b64encode(open(os.path.join(DATA, "city.bin"), "rb").read()).decode("ascii")
                     if os.path.exists(os.path.join(DATA, "city.bin")) else ""),
        "VEHICLES_JS": safe(open(os.path.join(WEB, "vehicles.js"), encoding="utf-8").read(), "vehicles.js"),
        "HLS_JS": safe(open(os.path.join(WEB, "vendor", "hls.light.min.js"), encoding="utf-8").read(), "hls.js"),
        "FEATURES_JS": safe(open(os.path.join(WEB, "features.js"), encoding="utf-8").read(), "features.js"),
    }
    # 額外模組 (電台、車流…) 依序附加在 app.js 之前
    extra_dir = os.path.join(WEB, "extra")
    extra = ""
    if os.path.isdir(extra_dir):
        for f in sorted(os.listdir(extra_dir)):
            p = os.path.join(extra_dir, f)
            if f.endswith(".json"):
                key = os.path.splitext(f)[0]
                extra += f'<script id="extra-{key}" type="application/json">' + \
                    open(p, encoding="utf-8").read().replace("</", "<\\/") + "</script>\n"
    out = tpl.replace("{{EXTRA}}", extra)
    for k, v in parts.items():
        out = out.replace("{{" + k + "}}", v)
    path = os.path.join(ROOT, "台灣.html")
    open(path, "w", encoding="utf-8").write(out)
    print(f"wrote {path} ({len(out.encode('utf-8')) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
