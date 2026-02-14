#!/bin/bash
# Koyeb build script - installs Playwright browsers after pip install

echo "Installing Playwright browsers..."
playwright install --with-deps chromium

echo "Build complete!"
