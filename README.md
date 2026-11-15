# Crypsy <img src="./logo.svg" width="28" height="28" align="top" alt="Crypsy logo" />

A lightweight, Google Keep-style encrypted notes web application with transparent client-side **AES-256-GCM** encryption and **Bring Your Own Cloud (BYOC)** folder syncing.

## Core Features

- **Search:** Instant client-side search across note titles, descriptions, and `#tags` with live match highlighting (`/` or `Ctrl+K`).
- **Tags:** Create, delete, and assign `#tags` to notes; filter notes by tag from the sidebar or by clicking any tag chip on a card.
- **Pins:** Pin important notes to the top (`PINNED` vs `OTHERS` sections).
- **Card / List View:** Toggle between a responsive multi-column Card Grid and a single-column List layout.
- **Rich Note Cards:** Title, multi-line description, timestamps, and 7 color themes (adapting to Dark & Light mode).
- **Transparent AES-256-GCM Encryption:** All notes and tags are encrypted in-browser using the WebCrypto API (`PBKDF2-SHA256` + `AES-256-GCM`) before persisting to storage.
- **Cloud Folder Onboarding & Live Sync:** Walk through placing Crypsy directly inside **Microsoft OneDrive, Google Drive, Dropbox, or iCloud Drive**—with live auto-save to `vault.crypsy.json` and automatic cross-device file-change polling.

## Two Ways to Set Up Cloud Sync

### 1. In-Browser Cloud Onboarding Wizard (Zero-Install)
1. Open `index.html` (or `dist/Crypsy-Portable.html`) in Chrome, Edge, or Brave.
2. Click **"Setup Cloud Folder"** in the top-right bar.
3. Choose your cloud provider (**OneDrive**, **Google Drive**, **Dropbox**, **iCloud Drive**, or **Custom**), copy the OS-specific folder path hint, and select your cloud folder.
4. Crypsy automatically creates a `Crypsy/` folder containing:
   - `vault.crypsy.json` — Your live AES-256-GCM encrypted notes vault (updated on every edit).
   - `Crypsy-Portable.html` — A single self-contained HTML file so you can open Crypsy on any other synced computer.
   - `README-CRYPSY.txt` — Recovery and usage instructions.

### 2. Cross-Platform CLI / Script Installer
Auto-detects installed cloud drives on Windows, macOS, and Linux, bundles `Crypsy-Portable.html`, copies the files into your cloud drive, and optionally creates a Desktop shortcut:

```powershell
# Interactive Cloud Installer (Windows PowerShell)
.\install.ps1

# Interactive Cloud Installer (macOS / Linux)
./install.sh

# Or via Node.js directly:
node install.js               # Interactive wizard
node install.js --list        # Inspect auto-detected cloud folders
node install.js --build-only  # Build standalone dist/Crypsy-Portable.html
```

## License

Licensed under the [MIT License](./LICENSE).
