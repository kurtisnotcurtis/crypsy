# Crypsy <img src="./logo.svg" width="28" height="28" align="top" alt="Crypsy logo" />

A lightweight encrypted quick-notes and spatial-boards web application with transparent client-side **AES-256-GCM** encryption and **Bring Your Own Cloud (BYOC)** folder syncing.

## Core Features

- **Spatial Boards (Free-Form Infinite Canvas):** Create free-form encrypted **Boards** from the sidebar (`Boards` section) or **+ New Board**. Click anywhere to type text boxes, paste (`Ctrl+V`) or drag-and-drop screenshots, image URLs, and link cards, grab the box border to move, resize/rotate with handles (including `Shift` 15° snap), align multiple items, pan/zoom infinitely, undo/redo edits, and preview boards directly via true-scale card thumbnails.
- **Custom Right-Click Context Menus:** Right-click on Board canvas space, single or multi-selected board items, note cards, board cards, sidebar boards, or sidebar `#tags` for quick format, tint, duplicate, rename, copy/cut/paste, and delete actions—while holding `Shift + Right-Click` or right-clicking inside text inputs preserves the native browser menu.
- **Search:** Instant client-side search across note titles, descriptions, board contents, and `#tags` with live match highlighting (`/` or `Ctrl+K`).
- **Tags:** Create, rename, delete, and assign `#tags` to notes and boards; filter from the sidebar or by clicking any tag chip on a card.
- **Pins:** Pin priority notes and boards to the top (`PINNED` vs `OTHERS` sections).
- **Card / List View:** Toggle between a responsive multi-column Card Grid and a single-column List layout.
- **Rich Note Cards & Markdown:** Title, multi-line description with interactive `- [ ]` task checkboxes, smart bullet/numbered list continuation, inline `![alt](url)` image rendering, timestamps, and 7 color themes (adapting to Dark & Light mode).
- **Encrypted Images & Clipboard Paste:** Paste images (`Ctrl+V`), drag-and-drop files, upload images, or import image URLs—compressed on-device to WebP and encrypted inside your vault (with automatic `no-referrer` external fallback if a remote host blocks CORS), plus a click-to-zoom lightbox.
- **Collapsible Sidebar:** Expand/collapse **Boards**, **Tags**, and **Quick Guide** sections in the sidebar with persisted UI state.
- **Transparent AES-256-GCM Encryption:** All notes, boards, images, and tags are encrypted in-browser using the WebCrypto API (`PBKDF2-SHA256` + `AES-256-GCM`) before persisting to IndexedDB / `localStorage` or your cloud folder.
- **Cloud Folder Onboarding & Live Sync:** Walk through placing Crypsy directly inside **Microsoft OneDrive, Google Drive, Dropbox, or iCloud Drive**—with live auto-save to `vault.crypsy.json` and automatic cross-device file-change polling.

## Two Ways to Set Up Cloud Sync

### 1. In-Browser Cloud Onboarding Wizard (Zero-Install)
1. Open `Crypsy-Portable.html` (or `index.html` over `http(s)://`) in Chrome, Edge, or Brave.
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
node install.js --build-only  # Build standalone Crypsy-Portable.html
```

## License

Licensed under the [MIT License](./LICENSE).
