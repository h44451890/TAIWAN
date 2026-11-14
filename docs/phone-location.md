# 手機定位同步（Android，全程 Wi-Fi、不用插線）

讓手機上的 Google Maps、神盾等 App 跟著遊戲裡的車子移動。
原理：遊戲每秒把車子的經緯度、速度、方向送給電腦上的橋接程式（`scripts/phone_location.py`），橋接程式透過 **adb 無線偵錯**，把位置交給手機上的 **Appium Settings**（Android 的「模擬位置應用程式」）。

> ⚠️ 模擬定位會蓋掉手機真正的 GPS。玩完一定要清除（遊戲再按一次 `L`，或關掉橋接程式），**開真車時絕對不要開著**。
> 用完也可以到「開發者選項 → 選取模擬位置應用程式」改回「無」。

## 需要的東西
- Android 11 以上的手機（無線偵錯不用線）
- Windows 電腦（已裝 Python 3.11），跟手機連**同一個 Wi-Fi**
- **Android SDK Platform-Tools**（Google 官方 adb 工具，約 7 MB）：https://developer.android.com/tools/releases/platform-tools
  下載 Windows 版，解壓縮到 `C:\platform-tools`
- **Appium Settings** App（Appium 官方開源工具，用來接收模擬定位）：https://github.com/appium/io.appium.settings/releases
  下載最新版的 `settings_apk-debug.apk`

## 一次性設定
1. **打開開發者選項**：手機「設定 → 關於手機 → 軟體資訊」，連點「版本號碼」7 次。
2. **打開無線偵錯**：「設定 → 開發者選項 → 無線偵錯」打開（手機要連 Wi-Fi）。
3. **配對電腦**：在「無線偵錯」裡點「使用配對碼配對裝置」，畫面會顯示 IP:連接埠 和 6 位數配對碼。在電腦執行：
   ```bash
   C:\platform-tools\adb.exe pair 手機顯示的IP:連接埠
   ```
   輸入配對碼。
4. **連線**：回到「無線偵錯」主畫面，看「IP 位址和連接埠」那一行（跟配對用的連接埠不同），執行：
   ```bash
   C:\platform-tools\adb.exe connect 手機的IP:連接埠
   ```
5. **安裝 Appium Settings**：
   ```bash
   C:\platform-tools\adb.exe install -g settings_apk-debug.apk
   ```
6. **設成模擬位置應用程式**：「開發者選項 → 選取模擬位置應用程式」選「Appium Settings」（橋接程式啟動時也會自動幫你設定）。

## 每次使用
1. 手機打開「無線偵錯」，電腦執行 `adb connect 手機的IP:連接埠`。每次重新打開無線偵錯，連接埠都會變。
2. 在台灣資料夾執行橋接程式：
   ```bash
   python scripts/phone_location.py
   ```
   如果 adb 不在 `C:\platform-tools`，加上 `--adb 你的路徑\adb.exe`；連了多支手機時加 `--serial 手機的IP:連接埠`。
3. 在**同一台電腦**打開遊戲（本機的 `台灣.html` 或 GitHub Pages 網址都可以），按 `L`（或按 `T` 開選單 → 手機定位同步）。
   小地圖下方會顯示「📱 同步中 25.xxxxx, 121.xxxxx」。
4. 手機打開 Google Maps 或神盾，位置就會跟著遊戲移動（含速度與行進方向）。
5. 結束：遊戲再按一次 `L`，或在橋接程式按 `Ctrl+C`，都會清除模擬定位。

## 測試（不接手機）
```bash
python scripts/phone_location.py --dry-run
```
遊戲按 `L` 後，終端機會每秒印出收到的座標、速度、方向。

## 常見問題
| 狀況 | 處理 |
|---|---|
| 遊戲顯示「連不到電腦上的橋接程式」 | 確認 `phone_location.py` 有在跑，而且遊戲開在同一台電腦 |
| 顯示「找不到手機」 | 執行 `adb devices` 確認手機在清單裡；沒有的話重新 `adb connect`（連接埠可能變了） |
| Google Maps 位置沒動 | 確認「選取模擬位置應用程式」是 Appium Settings；把 Google Maps 關掉重開 |
| 位置一格一格跳 | 正常：大約每秒更新一次 |

## iPhone
iPhone 也支援（`python scripts/phone_location.py --phone iphone`），但第一次一定要用 USB 線配對並開啟開發者模式，
之後才能用 Wi-Fi。需要安裝 `pymobiledevice3`，並以系統管理員身分執行 `python -m pymobiledevice3 remote tunneld`。
