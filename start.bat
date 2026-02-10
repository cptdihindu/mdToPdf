@echo off
setlocal

REM Ensure we run from this script's folder
pushd "%~dp0"

REM Start the Python server in a new window
start "MD2PDF Server" cmd /k "python server.py"

REM Wait briefly for the server to start
ping 127.0.0.1 -n 4 > nul

REM Open the app in the default browser
start "" "http://127.0.0.1:8010/"

popd
endlocal
