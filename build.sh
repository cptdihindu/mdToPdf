#!/bin/bash
# Koyeb build script - installs Playwright browsers
# Note: requirements.txt is installed automatically by buildpack

echo "Installing Playwright browsers..."
python -m playwright install --with-deps chromium

echo "Build complete!"
