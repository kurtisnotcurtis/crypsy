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
  mkdir -p "$TARGET_DIR"
  cp "$SCRIPT_DIR/index.html" "$SCRIPT_DIR/styles.css" "$SCRIPT_DIR/crypto.js" "$SCRIPT_DIR/cloud-sync.js" "$SCRIPT_DIR/app.js" "$TARGET_DIR/"
  echo "[OK] Crypsy installed to: $TARGET_DIR"
fi
