@echo off
chcp 65001 >nul
title 台灣 1:1 本機伺服器
rem 遊戲本機伺服器：即時路況代理 (照高公局實際更新時間抓) + 手機定位同步，http://127.0.0.1:8765/
rem 意外停止會在 5 秒後自動重開；要結束請直接關掉這個視窗。
cd /d "%~dp0.."
set PYTHONIOENCODING=utf-8
set PY=python
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python311\python.exe"

:loop
%PY% scripts\phone_location.py
echo.
echo 伺服器停止了，5 秒後自動重新啟動 (要結束請直接關掉這個視窗)...
timeout /t 5 /nobreak >nul
goto loop
