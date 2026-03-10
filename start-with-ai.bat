@echo off
echo ========================================
echo    MD2PDF with AI Chat Assistant
echo    Powered by Google Gemini
echo ========================================
echo.

REM Always set API key (overrides any stale value in the environment)
:: GROK API comes HERE
echo ✓ API Key: Configured
echo.
echo Starting MD2PDF server...
echo.
echo Server will be available at: http://localhost:8010
echo Press Ctrl+C to stop the server
echo.
echo ========================================
echo.

python server.py
