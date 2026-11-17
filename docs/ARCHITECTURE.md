# 技術架構說明

給之後一起開發的人看：這份文件說明資料從哪裡來、怎麼處理、網頁程式怎麼分工，以及改東西時要注意的地方。
操作方式與功能清單見 [README.md](../README.md)。

---

## 1. 整體流程

```
OpenStreetMap / AWS 地形 / 高公局          scripts/ (Python、Node，離線執行)             網頁 (瀏覽器)
─────────────────────────────          ─────────────────────────────            ─────────────────────
fetch_region / fetch_city  ──► data/*.json
fetch_terrain              ──► data/terrain/
                                prep_freeway.py  曲線平滑、投影、縱斷面、地形整平
                                export_web.py    路段二進位
                                build_live.py    路況 / CMS / 門架對到路段 ──► web/extra/live.json
                                build_signs.py   出口指示牌             ──► web/extra/signs.json
fetch_landcover            ──► landcover.py     地表分類格網 (30 m)
                                tile_web.py      切 3.84 km 分區      ──► tiles/index.json, tiles/t, tiles/d
                                fix_clip.mjs     穿模修復 (直接改分區)
fetch_cameras / places     ──► build_nav.mjs    導航路網、目的地、測速、里程牌 ──► tiles/n/nav.bin, web/extra/*.json
                                build_html.py    打包                  ──► 台灣.html (內嵌)、index.html (分區另外下載)
```

**順序很重要**：`tile_web.py` 會重寫分區，之後一定要再跑 `fix_clip.mjs`（它直接修改 `tiles/`），
然後 `build_nav.mjs`（讀修好的分區），最後 `build_html.py`。只改網頁程式 (`web/*.js`) 時只要重跑 `build_html.py`。

## 2. 座標與資料格式

- **座標**：TWD97 TM2（EPSG:3826）減去原點 `(305500, 2769200)`，單位公尺，x 東、y 北、z 上。
  three.js 是 y 朝上，所以轉換為 `(x, z, -y)`（`GB.v()`、`placeOnWay()` 都照這個規則）。
- **分區**：3840 m 正方形（128 格 × 30 m）。路段與建築依中點歸屬一個分區，**路段不切開**，全域編號 `gid` 不變。
  - `tiles/t/x_y.bin`：地形 Int16 (0.1 m) `TN×TN`（TN = 131，含 1 格外框）+ 同大小的 uint8 地表分類。
  - `tiles/d/x_y.bin`：`uint32 JSON 長度 + JSON 標頭 + 資料區`，格式見 `tile_web.py pack_detail()` 與 `app.js ingestDetail()`。
  - 高度 3276.8 m 以上會繞回負數，一律用 `Z16()` 解碼。
- **gid**：國道 / 快速道路 = 原本索引 (0..nfwy-1)，一般道路 = nfwy + 索引。`live.json`、`signs.json`、`nav.bin`、傳送地點都用 gid。
- **emask**（每個路點一個 byte）：bit0 左路緣、bit1 右路緣落在別條路面上（不放護欄 / 側牆）；bit2 這段匝道被主線路面蓋住（不畫路面）。
- **路網接續**：兩條路段在「座標四捨五入到 0.1 m 相同的點」相接（`PT_INDEX`）。走到路段端點時可以接上任何一條在同一點有點、高度差 2.5 m 以內的路段（`nextOptions()`）。
  `fix_clip.mjs` 另外輸出 `hd.ramp`（匝道與主線的對應），網頁用 `resolveRamps()` 補接。

## 3. 網頁程式

四個檔案依序載入，彼此用全域物件溝通：

| 檔案 | 負責 | 對外 |
|---|---|---|
| `vehicles.js` | 各車種的精細模型（放樣曲面） | `window.TWV` |
| `app.js` | 分區串流、路面 / 護欄 / 橋墩 / 隧道 / 建築 / 地形建模、材質著色器、天空與日夜、玩家車物理（含變速箱、定速巡航）、攝影機、小地圖、HUD、主迴圈 | `window.TW` |
| `features.js` | 即時路況、AI 車流 (IDM)、CMS 看板、ETC 門架、出口指示牌、電台、引擎音效、手機定位、觸控按鍵、操控設定 / 方向盤校正 / 新手引導、樹、夜間車燈 | `window.TWX` |
| `gameplay.js` | 天氣（雨、霧、雨刷、濕路面）、全螢幕、測速照相 / 區間測速、地名里程牌、導航、任務、選單的導航 / 任務 / 駕駛區 | `window.TWG` |

### 掛勾 (`TW.HOOKS`)
`app.js` 不認識擴充模組，模組自己把函式掛上去：

| 掛勾 | 什麼時候呼叫 |
|---|---|
| `init[]` | 第一次載入完成、玩家放到路上之後 |
| `update[](dt)` | 每格物理更新之後 |
| `frame[](dt)` | 每格繪製之前（動畫、HUD） |
| `minimap[](ctx, scale)` | 畫小地圖時（ctx 已經是世界座標、以玩家為原點） |
| `tile[](rec)` | 一個分區的模型建好時 |
| `key[](event)` | 按鍵 |
| `leader(shift)` / `laneFree(shift)` | 自動駕駛問前車距離 / 換車道安全（AI 車流提供） |
| `wayColor(w)` | 小地圖路段顏色（路況） |
| `navBias(w, option)` | 自動駕駛在路口選路的加分（導航提供） |
| `joint(v, axle)` | 壓過伸縮縫 |

### 主迴圈 (`app.js` 最後)
`update()`（120 Hz 子步）→ `HOOKS.update` → `syncCar` / `updateCamera` / `updateDayNight` → `HOOKS.frame` → render → 小地圖（隔格）→ HUD。

### 著色器
材質都是 three.js 內建的 `MeshStandardMaterial`，用 `patch()` 在固定位置插入 GLSL（顏色、粗糙度、法線、自發光）。
`vObj` 是資料座標（x, y, z-up）。重要的共用 uniform：`NIGHT`（0 白天..1 夜晚）、`WEATHER.wet`（路面濕度）。
有用對數深度緩衝，**自訂 ShaderMaterial 一定要加 `logdepthbuf` 的 chunk**，不然會畫在錯的深度（之前反光點「飛起來」就是這個）。

## 4. 各功能的資料

| 功能 | 資料 | 產生 |
|---|---|---|
| 路況、CMS、門架 | `web/extra/live.json` + 即時 API | `build_live.py`、`phone_location.py`、Smart-Nav-Map 後端 |
| 出口指示牌 | `web/extra/signs.json` | `build_signs.py` |
| 地名里程牌 | `web/extra/distsigns.json`：`[主線 gid, 點, [[地名, 公里]...], 路線]` | `build_nav.mjs` |
| 測速照相 | `web/extra/cameras.json`：`cams [x,y,z,方向,速限]`、`sections [名稱,速限,起訖座標,方向]` | `fetch_cameras.py` → `build_nav.mjs` |
| 導航 | `tiles/n/nav.bin`（格式寫在 `build_nav.mjs` 開頭）+ 目的地清單 | `fetch_places.py` → `build_nav.mjs` |
| ETC 通行費 | `web/extra/live.json` 的 `etc`（門架 id、里程 m、所在路段 gid / 點），門架間距 = 計費里程 | `build_live.py` |
| 天氣（即時） | Open-Meteo（只送遊戲中車子位置的經緯度，取到小數 2 位） | 執行時 |

### 導航演算法
- 狀態 = (路段, 行進方向)，成本 = 行駛時間（長度 ÷ 速限，巷道 ×1.8、小路 ×1.2，轉彎加 5～9 秒）。
- A*，啟發函數 = 直線距離 ÷ 115 km/h。全圖 11 萬條路段，通常 10 ms 內算完。
- 轉彎限制和遊戲的 `chooseNext()` 一樣（國道夾角 > 72° 不接、一般道路 > 101° 不接），所以規劃出來的路線自動駕駛開得過去。
- 路網有縫（端點差幾公尺沒接上）的地方，`build_nav.mjs` 會接到 8 m 內方向順的路段。

## 5. 改東西前要知道的

- **不要直接改 `台灣.html` / `index.html`**，它們是打包產生的。
- `台灣.html` 不能超過 100 MB（GitHub 單檔上限）。`build_html.py` 的 `INLINE_MB` 控制內嵌多少分區，其他分區開啟時從 GitHub Pages 下載。
- `fix_clip.mjs` 會改寫 `tiles/`，**連續跑兩次會疊加效果**（例如匝道高度），要從 `tile_web.py` 重新開始。
- 交流道：OSM 匝道從主線中心線岔出，前段會和主線重疊。目前的做法是**不搬動匝道平面位置**，只把重疊段高度對齊主線、被蓋住的部分不畫。
  之前試過把匝道橫向移到主線外側，結果在匝道再分岔、多條主線並行的地方路面會扭曲錯開，已經退掉。
- 效能：手機版 AI 車、樹、陰影都降級（`TW.MOBILE`）；新功能要記得手機也能跑。
- 本機測試：`python scripts/phone_location.py` 後開 `http://127.0.0.1:8765/`。測試參數見 README。
  無頭測試：`chrome --headless=new --use-angle=swiftshader --virtual-time-budget=... --screenshot "http://127.0.0.1:8765/?t=90&..."`，`?t=秒數` 會先模擬再截圖，主控台會印 `[test]` 統計（碰撞、AI 重疊、換車道）。
- 設定與存檔都在 localStorage：`tw_pos`（上次位置）、`tw_ctrl`（操控）、`tw_weather`、`tw_manual`、`tw_wallet`、`tw_tickets`、`tw_voice`、`tw_onboard`、`tw_etc`（今日 ETC 里程與通行費）。

## 6. 授權
OpenStreetMap（ODbL）、AWS Terrain Tiles、Poly Haven（CC0）、交通部高速公路局、警察廣播電台、Open-Meteo（CC BY 4.0）、three.js（MIT）、hls.js（Apache-2.0）。
