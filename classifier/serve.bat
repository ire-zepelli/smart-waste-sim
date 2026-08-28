@echo off
REM Serves the classifier on http://localhost:8000
REM localhost is a secure context, so the browser will allow camera access.
REM Opening index.html directly (file://) will NOT work - Chrome blocks the camera.

cd /d "%~dp0"
echo.
echo   Smart Waste - classifier node
echo   Open:  http://localhost:8000
echo   Stop:  Ctrl+C
echo.
start "" http://localhost:8000
python -m http.server 8000
