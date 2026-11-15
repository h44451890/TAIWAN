# 台灣 1:1 — 基隆・台北・桃園・新竹・苗栗・台中・宜蘭

用 OpenStreetMap 路線 + 開放地形資料生成 1:1（1 單位 = 1 公尺）的國道模型，
有 Blender 版，也有可以直接開車的網頁：
- **`台灣.html`**：單一檔案，地圖全部內嵌，雙擊就能玩（不用網路；電台與即時路況需要網路）。
- **`index.html`**（GitHub Pages）：地圖切成分區放在 `tiles/`，開到哪載到哪，第一次開只要下載約 1.3 MB 加上附近的分區。
- 本機：執行 `python scripts/phone_location.py`，瀏覽器開 http://127.0.0.1:8765/ （同時提供即時路況與手機定位同步）。

## 台灣.html 操作
| 按鍵 | 功能 |
|---|---|
| W / ↑、S / ↓ | 油門、煞車・倒車 |
| A D / ← → | 轉向（也可改用螢幕方向盤、手機重力感應、實體方向盤 / 搖桿，見「操控設定」） |
| Shift / 空白 | 加速 / 手煞車 |
| V（或 1、3） | 第一人稱（只看前方的路）/ 第三人稱（看得到車子） |
| 滑鼠拖曳 | 第三人稱環視 |
| P | 自動駕駛 |
| K | 車道置中輔助（預設開；沒打方向盤時自動保持在最近的車道中央，打方向燈或轉彎時暫停，路段銜接時跟著車道走） |
| M | 小地圖縮放 |
| R | 回到最近的主線 |
| F、Z / X | 電台開關、換台（警察廣播電台 9 台） |
| N | 引擎音效開關 |
| G | 換車（轎車、計程車、國道警察、機車、小巴、市區公車、國道客運、3.5 噸貨車、大貨車、聯結車） |
| T | 選單：傳送（台北101、台北車站、桃園車站、中壢車站、林口、國2 機場線、國3 鶯歌…）／換車／手機定位同步／操控設定 |
| Q / E | 方向燈；自動駕駛時在路口依方向燈左轉／右轉 |
| L | 手機定位同步（見 [docs/phone-location.md](docs/phone-location.md)） |
| H | 隱藏說明 |

### 操控設定（選單 T）
- **轉向方式**：手機可選「◀ ▶ 按鈕」、「🛞 方向盤」（手指拖著轉）、「📱 重力感應」（橫拿手機左右傾斜，可校正正中）；電腦可選鍵盤或螢幕方向盤（滑鼠拖）。
- **可調**：轉向靈敏度、方向盤打到底的角度（±60°～±540°）、方向盤大小、左手 / 右手位置（右手時油門煞車移到左邊）、放開自動回正、重力感應打到底的傾斜角。
- **實體方向盤 / 搖桿**（Gamepad API）：插上後轉一下就會偵測到；X 軸轉向、RT 油門、LT 煞車，可反轉方向、有死區。
- 設定存在這台裝置（localStorage）。

網址參數（測試用）：`?cam=1` 第一人稱、`?demo` 開啟自動駕駛、`?lc=0` 關閉車道置中、`?t=60&lctest` 車道置中測試、`?steer=wheel` 方向盤模式、`?clipscan` 穿模掃描、`?cars=150` AI 車輛數、`?spawn=路段gid,點` 或 `?at=x,y` 指定出生點、`?meshr=7000` 模型載入半徑 (m)、`?api=https://.../api` 指定路況後端。

## 功能
- **路面**：車道數取自 OSM `lanes`，每線 3.75 m；標線為內側黃實線、外側白實線、白虛線（畫 4 m 空 6 m）。
- **瀝青材質**：Poly Haven「Asphalt 04」實景掃描貼圖（CC0，顏色 + 法線 + 粗糙度，一張 4.04 m），以世界座標貼上並疊加旋轉取樣與大範圍明暗避免重複感；國道車道有輪跡與油漬。
- **交流道指示牌**：每個匝道分岔點前約 230 m 一座綠色門架（`scripts/build_signs.py`，OSM 出口編號、`destination`、`destination:en`、`destination:ref`）。左邊直行方向（下兩個交流道 + ↑），右邊出口（路線盾牌、中英文地名 + ↗），上方黃底出口編號。
- **起點**：國1 南下、汐五高架底下（東湖 → 內湖），前方就是 15.8K 的 CMS 看板。
- **雙向分離**：OSM 的雙向中心線常比真實車寬還近，前處理會偵測同一層對向車道的重疊，把兩側往外推開，留出中央分隔帶，推移量沿路網平滑過渡。
- **立體交叉淨空**：上層橋面至少比下層路面高 6.5 m，只檢查真正交叉或上下疊在一起的路段，並排或相連的路段不算。
- **分合流處**：落在別條路面上的路緣不放護欄和側牆。
- **橋墩**：立柱避開下層道路，偏移時帽梁會延伸過去撐住橋面。
- **轉彎**：向心 Catmull-Rom 樣條（每段等同三次貝茲曲線，alpha = 0.5），曲線通過每個 OSM 節點、不過衝；路段接頭的切線取相鄰路段，接縫 G1 連續。
- **材質**：網頁著色器使用與 Blender 相同的公式與線性色彩值（瀝青雜訊 + 標線、混凝土、護欄、依高度配色的地形），色調映射同為 AgX，太陽方向與強度相同。
- **精細車輛**：放樣曲面車身與輪拱、玻璃車艙、A/B/C 柱、頭燈與日行燈、紅色尾燈組與第三煞車燈、倒車燈、水箱罩、後照鏡、門把、車門縫、排氣管、輪胎（旋轉）、五輻輪框、碟盤與卡鉗、臺灣車牌；前輪會轉向，煞車時尾燈變亮。
- **車種**：轎車／休旅／掀背、計程車、國道警察（警示燈閃爍）、市區公車（LED 路線看板）、國道客運、小巴、3.5 噸貨車、大貨車、聯結車（拖車會跟著轉彎折）、機車（含騎士，轉彎壓車）。
- **一般道路車流**：AI 在市區雙向道路靠右行駛、路口轉彎並打方向燈、橫向來車會讓；機車靠路邊騎；公車、機車只在市區；大貨車與聯結車在國道只走外側兩車道；國道上沒有機車。
- **手機定位同步**：遊戲位置即時送到 Android（adb 無線偵錯 + Appium Settings）或 iPhone 的模擬定位，Google Maps、神盾會跟著移動。
- **AI 車流**：最多 90 台（多種顏色，包含計程車黃，以及轎車、休旅、掀背三種車型）。採 IDM 跟車模型，會依前車加減速並保持安全距離，前車慢時會安全換道超車，也會回到外側車道。AI 車輛也會閃避玩家；只會在 750 m 外生成、1.8 km 外回收，不會在眼前突然消失。
- **即時路況**：高公局路段車速決定 AI 車速與車流密度。車子總數固定，玩家所在路段越塞，國道車就集中在越小的範圍（車多約 3～5 倍、壅塞 7～9 倍密度），塞車時眼前真的是一排車。小地圖只有路況才上色（國道底色改成中性灰，不會和路況顏色混淆）；連得上智行地圖伺服器時，再疊上它的 `/traffic/segments` 圖層（國道 + 臺北、桃園市區官方路況 + 手機回報）。
- **中央分隔島**：風化混凝土護欄（雨痕、大片黑色污漬、底部青苔）＋ 綠色防眩板（每 4 m 一片，雙向路面緊貼時只放一排）。
- **CMS 電子看板**：145 座，位置與訊息來自高公局，造型參考 Smart-Nav-Map `cms_3d.js`（鋼桁架、LED 點陣看板、閃光燈、里程牌），多則訊息每 5 秒輪播。
- **ETC 門架**：50 座，每個車道上方一組偵測器，並附門架編號牌。
- **電台**：警察廣播電台 9 台，以 hls.js 播放 HLS 串流。
- **伸縮縫聲**：模態合成的「喀噔」— 輪胎撞擊激發車身共振（40～1000 Hz 多個衰減模態）、輪胎拍擊、內裝細碎震動、懸吊回彈的第二下悶響；前後輪、縫的前後邊緣、左右輪各自錯開，力道與亮度隨車速變化。
- **穿模修復**（`scripts/fix_clip.mjs`）：路口高度統一（差太多視為不同樓層、不相連）、地形三角形頂點壓到路面下（保證地形不會冒出路面，山坡上的路變成路塹）、建築牆角推到路緣外、橋墩避開別條路；`?clipscan` 可重新檢查全圖。
- **引擎音效**：Web Audio 即時合成，包含 6 速自動變速、轉速對應音高、油門越大聲音越渾厚、換檔頓挫、進氣聲、風切與胎噪、過彎胎叫，以及碰撞聲。

## 即時資料
網頁依序試：本機 `phone_location.py` → Smart-Nav-Map 後端（預設 `https://node.tailfdfee1.ts.net/api`，提供 `/freeway-speed`、`/cms`、`/traffic/segments`）→ 打包當下的快照（`data/live/*.xml`）。
本機伺服器照 Smart-Nav-Map `lib/upstream.js` 的作法，依高公局檔案的 Last-Modified 推算下一次更新時間，一到就抓（還沒更新每 3 秒用 HEAD 問一次），網頁照回傳的 `nextUpdateIn` 來拿，資料一更新就拿到。
路況列顯示「即時 · N 秒前（本機／後端）」；兩個伺服器都連不到才顯示「離線快照」。GitHub Pages 是靜態網頁，手機上要即時路況必須開著智行地圖的後端伺服器（`Smart-Nav-Map/server/啟動伺服器.bat` + Tailscale Funnel）。

## 檔案
| 路徑 | 說明 |
|---|---|
| `台灣.html` | 打包好的單一網頁 |
| `blender/taipei_freeway.blend` | Blender 檔 |
| `data/taipei_fwy.json` | OSM 國道 + 快速道路資料（範圍 24.00–25.20N, 120.45–121.92E：基隆到台中、國5 全線南港→雪山隧道→頭城→蘇澳）。一般道路與建築目前有基隆～桃園和台中，新竹、苗栗、宜蘭市區還在補 |
| `data/terrain_grid.npz` | prep_freeway.py 產生的整平地形（150 MB 以上，不放進 git，重跑 prep_freeway.py 就有） |
| `scripts/fix_clip.mjs` | 穿模修復：路口高度、地形、建築、橋墩（tile_web.py 之後執行） |
| `data/terrain/` | AWS Terrain Tiles 地形圖磚（zoom 13） |
| `data/live/` | 高公局 Section / LiveTraffic / CMS / CMSLive 快照 |
| `smart-nav-map/` | 從 Smart-Nav-Map 複製來的參考檔（門架資料、CMS 3D、路況與 CMS API、音訊管理、測速照相） |
| `scripts/fetch_terrain.py` | 下載地形圖磚 |
| `scripts/prep_freeway.py` | 貝茲曲線平滑、投影到 TWD97、路面縱斷面與橋梁高度、地形整平 |
| `scripts/build_freeway_blender.py` | 建 Blender 場景 |
| `scripts/export_web.py` | 輸出網頁用二進位資料 |
| `scripts/build_live.py` | 路況、CMS、門架對應到路段（`--offline` 用現有快照） |
| `scripts/build_signs.py` | 交流道出口指示牌資料（`web/extra/signs.json`） |
| `web/tex/` | 路面貼圖（Poly Haven CC0） |
| `scripts/tile_web.py` | 把網頁資料切成 3.84 km 分區（`tiles/index.json`、`tiles/t/` 地形、`tiles/d/` 路段 + 橋墩 + 建築） |
| `scripts/build_html.py` | 打包 `台灣.html`（分區全部內嵌）與 `index.html`（分區另外下載） |
| `tiles/` | 分區資料（由 `tile_web.py` 產生） |
| `web/app.js`、`web/features.js`、`web/template.html` | 網頁原始碼 |

## 重新產生
```bash
python scripts/fetch_terrain.py
python scripts/prep_freeway.py
"/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background --factory-startup --python scripts/build_freeway_blender.py
python scripts/export_web.py
python scripts/build_live.py
python scripts/build_signs.py
python scripts/tile_web.py
node scripts/fix_clip.mjs
python scripts/build_html.py
```

## 分區載入
地圖以 TWD97 本地座標切成 3840 m（128 格 × 30 m）的正方形分區。每個路段、建築依中點歸屬一個分區（路段不切開，全域編號 gid 不變，live.json 照用）。遊戲在車子周圍下載資料、鄰近 8 區都到齊才建模型，遠了就丟掉模型（資料保留）。電腦版模型半徑 7 km、地形 18 km；手機版 4.2 km、9 km。

## 座標
高度以 Int16（0.1 m）存放；3276.8 m 以上（合歡山、雪山）會繞回負數，讀取時小於 −500 m 的值加 65536（`Z16()`）。

TWD97 TM2（EPSG:3826）減去原點 `(305500, 2769200)`，原點也存在 Blender 場景自訂屬性 `origin_twd97`。

## 限制
- 高架高度由 OSM `layer` 推估（每層 7 m，引道坡度 ≤ 4%），不是實測值。
- AI 車只走主線（遇到只能接匝道的地方才會上匝道），還不會主動下交流道。
- 地形解析度約 19 m，可換成內政部 20 m DEM。

資料來源：© OpenStreetMap contributors（ODbL）；地形：AWS Terrain Tiles；路面貼圖：Poly Haven（CC0）；路況 / CMS / ETC：交通部高速公路局；電台：警察廣播電台；three.js、hls.js（MIT / Apache-2.0）。
