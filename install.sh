#!/usr/bin/env bash
# Crypsy Cloud Folder Onboarding & Installer (macOS / Linux)
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node >/dev/null 2>&1; then
  node "$SCRIPT_DIR/install.js" "$@"
else
  echo "================================================================"
  echo "  Crypsy — macOS / Linux Cloud Folder Installer"
  echo "================================================================"
  read -r -p "Enter target cloud folder path (e.g. ~/Dropbox or ~/OneDrive): " BASE_PATH
  BASE_PATH="${BASE_PATH/#\~/$HOME}"
  TARGET_DIR="$BASE_PATH/Crypsy"
  mkdir -p "$TARGET_DIR/dist"
  cp "$SCRIPT_DIR/index.html" "$SCRIPT_DIR/styles.css" "$TARGET_DIR/"
  if [ -f "$SCRIPT_DIR/logo.svg" ]; then
    cp "$SCRIPT_DIR/logo.svg" "$TARGET_DIR/"
  fi
  if [ -f "$SCRIPT_DIR/Crypsy-Portable.html" ]; then
    cp "$SCRIPT_DIR/Crypsy-Portable.html" "$TARGET_DIR/"
  fi
  if [ -f "$SCRIPT_DIR/dist/app.bundle.js" ]; then
    cp "$SCRIPT_DIR/dist/app.bundle.js" "$TARGET_DIR/dist/"
  else
    echo "[WARN] dist/app.bundle.js not found. Run 'npm run build' with Node.js first, or open Crypsy-Portable.html."
  fi
  echo "[OK] Crypsy installed to: $TARGET_DIR"
fi
