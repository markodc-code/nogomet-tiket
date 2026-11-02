@echo off
chcp 65001 >nul
title Nogometni tiket
cd /d "%~dp0"
python server.py
pause
