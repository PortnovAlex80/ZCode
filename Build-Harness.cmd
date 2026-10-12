@echo off
cd /d "%~dp0"
node scripts\spec-harness-production.mjs build
if errorlevel 1 pause
