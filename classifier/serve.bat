@echo off
REM Serves the Zura classifier and opens it in your browser.
REM Do NOT open index.html directly - Chrome blocks the camera on file://

cd /d "%~dp0"
python serve.py %*
pause
