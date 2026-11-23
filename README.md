# Crypsy <img src="./logo.svg" width="28" height="28" align="top" alt="Crypsy logo" />

A lightweight encrypted quick-notes and spatial-boards web & mobile application with transparent client-side **AES-256-GCM** encryption, **Bring Your Own Cloud (BYOC)** folder syncing, and native Android/iOS builds via Capacitor.

## Core Features

- **Spatial Boards (Free-Form Infinite Canvas):** Create free-form encrypted **Boards** from the sidebar (`Boards` section) or **+ New Board**. Click anywhere to type text boxes, draw freehand with variable-width pens and highlighters (with stylus auto-detect, barrel eraser, swept stroke eraser, lasso selection, `Dots`/`Grid`/`Ruled`/`Blank` paper backgrounds, and a Touch Draw toggle), paste (`Ctrl+V`) or drag-and-drop screenshots, image URLs, and link cards, grab the box border to move, resize/rotate with handles (including `Shift` 15° snap), align multiple items, pan/zoom/pinch infinitely, undo/redo edits, and preview boards via true-scale SVG/card thumbnails.
- **Custom Right-Click & Long-Press Context Menus:** Right-click (or long-press on touch devices) on Board canvas space, single or multi-selected board items/strokes, note cards, board cards, sidebar boards, or sidebar `#tags` for quick formatting, ink thickness, tint, duplicate, rename, copy/cut/paste, and delete actions—while holding `Shift + Right-Click` or right-clicking inside text inputs preserves the native browser menu.
- **Search:** Instant client-side search across note titles, descriptions, board contents, and `#tags` with live match highlighting (`/` or `Ctrl+K`).
- **Tags & Pins:** Organize notes and boards with collapsible `#tags` in the sidebar and pin priority cards to the top (`PINNED` vs `OTHERS` sections).
- **Rich Note Cards & Markdown:** Multi-column Card Grid or List view with interactive `- [ ]` checkboxes, smart list continuation, `Ctrl+V`/URL encrypted WebP images with click-to-zoom lightbox, 7 note themes, and Dark/Light modes.
- **Enforced AES-256-GCM Encryption & Privacy Controls:** All notes, boards, ink strokes, images, and tags are encrypted on-device using the native WebCrypto API (`PBKDF2-SHA256`, 600,000 iterations + `AES-256-GCM`) with a mandatory user passphrase (including explicitly gated migration for legacy v1.x vaults). Locking (`Ctrl+Shift+L`, topbar lock button, configurable idle auto-lock, or optional lock-on-hide) commits open drafts, clears application state references (passphrase, decrypted notes/boards, undo stacks), and empties rendered DOM; **Strict Media Privacy** blocks external image URLs until clicked, and Android builds disable OS cloud auto-backup (`android:allowBackup="false"`).
- **Cloud Folder Sync, Mobile PWA & Native Apps (Capacitor):**
  - **Desktop Browsers (BYOC):** Link Crypsy directly inside **Microsoft OneDrive, Google Drive, Dropbox, iCloud Drive, or custom synced folders** with live auto-save to `vault.crypsy.json` and cross-device polling.
  - **Mobile Web / PWA (iOS Safari & Android Chrome):** Install to Home Screen cleanly with safe-area layouts, two-finger pinch-to-zoom, no-zoom inputs, and one-tap Web Share / OS Files import-export for `vault.crypsy.json`.
  - **Native Android & iOS Apps (Capacitor):** Pre-configured `android/` and `ios/` projects auto-persist `Documents/Crypsy/vault.crypsy.json` (exposed in the iOS **Files** app via `UIFileSharingEnabled`) and open native OS share sheets cleanly via `@capacitor/filesystem` and `@capacitor/share`.

## Setup & Native Mobile Builds

### 1. In-Browser / Mobile PWA
- **Desktop:** Open `Crypsy-Portable.html` (or the hosted web app) in Chrome, Edge, or Brave and click **"Setup Cloud Folder"** to provision `Crypsy/vault.crypsy.json` and `Crypsy-Portable.html`.
- **Android / iOS Web App:** Open in Chrome or Safari and **Add to Home Screen**. Use **Setup Cloud Folder** for one-tap Share Sheet backup and OS Files import of `vault.crypsy.json`.

### 2. Native Android & iOS Builds (Capacitor)
```bash
npm install
npm run cap:sync      # Builds bundle + prepares slim www/ + syncs android/ & ios/
npm run cap:android   # Opens crypsy-note/android in Android Studio (requires Android SDK)
npm run cap:ios       # Opens crypsy-note/ios in Xcode on macOS
```

### 3. Cross-Platform CLI / Desktop Folder Installer
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
