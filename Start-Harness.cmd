@echo off
cd /d "%~dp0"
node scripts\spec-harness-production.mjs start
if errorlevel 1 pause
