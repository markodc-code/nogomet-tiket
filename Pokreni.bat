@echo off
chcp 65001 >nul
title Dzavke prati, pare vrati
cd /d "%~dp0"
python server.py
pause
