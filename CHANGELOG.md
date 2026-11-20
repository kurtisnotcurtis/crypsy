# Changelog

All notable changes to **Crypsy Note** are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.6.0] - 2026-11-19
### Security
- **Enforced Vault Passphrase & Legacy Vault Migration (`src/app.ts`, `src/crypto.ts`, `src/types.ts`)**: Removed silent encryption/decryption using the hardcoded default device secret (`state.passphrase` now defaults to `null`). New vaults require creating and confirming an 8+ character passphrase before initialization, while legacy default-key vaults are detected in `tryLoadEnvelope()` and forced through an in-place re-keying upgrade flow (`setLockScreenMode('upgrade')`) before exposing decrypted notes or boards.
- **Stronger KDF & Envelope Compatibility (`src/crypto.ts`)**: Upgraded `PBKDF2-SHA256` from `150,000` to `600,000` iterations for new encryptions, enforced non-empty passphrases in `encryptPayload()` / `decryptPayload()`, and added `resolveEnvelopeIterations()` so legacy `150,000`-iteration vaults remain readable.
- **Full Memory & DOM Wiping on Lock (`src/app.ts`, `src/board-editor.ts`, `src/cloud-sync.ts`)**: Updated `lockVault()` and added `BoardEditorController.clearSensitiveMemory()` so locking wipes `state.passphrase`, notes, boards, tags, up-to-40 board `undoStack`/`redoStack` snapshots, clipboard copies, rendered grids/cards, edit modal inputs, and active filter DOM. Updated `sanitizeClonedPortableDom()` to clear `#reconnectBannerMsg`, `#lastUpdatedText`, `#editModalTimestamp`, `<textarea>` contents, and title tooltips when exporting `Crypsy-Portable.html`.
- **Auto-Lock, Quick Lock & Strict Media Privacy (`src/app.ts`, `src/utils.ts`, `index.html`, `styles.css`)**: Added a topbar lock button (`#topbarLockBtn`), `Ctrl+Shift+L` / `Cmd+Shift+L` shortcut, configurable inactivity auto-lock (`5`/`15`/`30`/`60` min or `Never`), opt-in lock-on-hide (`visibilitychange`), and **Strict Media Privacy** (enabled by default) replacing external `http(s)://` image URLs with click-to-load placeholders until explicitly allowed for the session.
- **CSP, Form & Android Backup Hardening (`index.html`, `android/app/src/main/AndroidManifest.xml`)**: Added a Content Security Policy meta tag disallowing `'unsafe-eval'`, `object-src`, and `base-uri`, added `autocomplete="off"` to note description textareas, and set `android:allowBackup="false"` to disable Android cloud auto-backup of local app storage.

## [1.5.0] - 2026-11-18
### Added
- **Pen, Highlighter, Eraser & Lasso Drawing in Boards (`src/ink.ts`)**: Added zero-dependency freehand drawing on Spatial Boards using `BoardStrokeItem` (`type: 'stroke'`) with pressure/velocity modulation, Ramer-Douglas-Peucker simplification (`[x, y, pressure]` tuples), smooth variable-width pen paths, blended highlighter strokes, swept-segment stroke eraser, freehand lasso selection, `Shift+Drag` straight lines, live 120Hz drawing canvas (`#boardInkLiveCanvas`), 4 customizable ink slots via `#boardInkPopover`, theme-adaptive `Auto Ink`, per-board `Dots`/`Grid`/`Ruled`/`Blank` paper backgrounds, contextual stroke thickness & ink recoloring, right-click stroke actions, and SVG stroke previews inside board thumbnails.
- **Stylus & Touch-First Drawing UX**: Added automatic `pointerType === 'pen'` inking without leaving `Select` mode, hardware stylus barrel eraser support, a **Touch Draw** toggle (preserving single-finger panning cleanly when off), and multi-touch cancellation so two-finger gestures do not leave stray ink marks.
- **Mobile PWA & Touch Compatibility**: Added `manifest.webmanifest`, `icon.svg`, `viewport-fit=cover`, dynamic `theme-color`, `100dvh` & safe-area layout padding, `16px` mobile form input sizing (preventing iOS Safari auto-zoom), scrollable mobile board toolbars with fixed-position popovers, two-finger pinch-to-zoom/pan, `520ms` long-press touch context menus, auto-collapsing mobile sidebar drawer, and Web Share / Files vault import-export (`#wizardMobileSyncBox`) for iOS Safari & Android Chrome.
- **Native Android & iOS Capacitor Integration (`capacitor.config.json`, `android/`, `ios/`, `prepare-mobile.mjs`)**: Added Capacitor `v8.6.2` runtime and generated Android & iOS native projects using slim `www/` bundle staging, automatic encrypted persistence to `Documents/Crypsy/vault.crypsy.json` (`UIFileSharingEnabled` / `LSSupportsOpeningDocumentsInPlace` for iOS Files app visibility), and native OS share-sheet integration (`@capacitor/filesystem`, `@capacitor/share`).

### Changed
- **Landing Site Refresh ([docs/index.html](file:///C:/Users/Kurt/Projects/crypsy/crypsy-note/docs/index.html))**: Centered hero positioning on Spatial Boards and quick Markdown notes, added an auto-rotating constant-height hero carousel (`Spatial Boards | Quick Notes`), added the `#boards` Canvas Editor spotlight section, updated ciphertext version previews, and removed third-party app comparisons (`Keep` / `OneNote`) across public pages and repository docs.

## [1.4.0] - 2026-11-18
### Added
- **Spatial Boards (Free-Form Infinite Canvas)**: Added **Boards** as a first-class encrypted object type alongside Notes in the AES-256-GCM vault (`VaultPayload.boards`), organized in the sidebar under **All Notes** (Notes-only default), **Pinned**, and **Boards** with a collapsible board list and inline `+ New board...` creation.
- **Full-Screen Board Canvas Editor**: Added a pannable, zoomable dot-grid canvas (`Space+Drag` / middle-mouse pan, `Ctrl+Scroll` zoom, fit-to-view, 16px grid snap), click-anywhere text boxes, perimeter drag border (`7px` outer rim) vs. interior text editing, corner/edge resize handles with rotated aspect/anchor compensation, rotation handle with 15° `Shift` snapping, zero-shift floating formatting bar (font size, bold, italic, text alignment, multi-item AABB align, palette tinting, z-order, duplicate/delete), in-session undo/redo (`Ctrl+Z`/`Ctrl+Y`), drag-and-drop images, and `Ctrl+V` paste for images, image URLs, link cards, and plain text.
- **Proportionally Scaled Board Thumbnails**: Added live miniature board card previews (`.board-card-minimap` / `.board-minimap-world`) reflecting each board's theme color, item colors, typography, rotation, links, and images.
- **Custom Right-Click Context Menu**: Intercepted right-click (`contextmenu`) across Board canvas space & items, note cards, board cards, sidebar boards, and sidebar `#tags` with viewport collision flipping, full keyboard navigation (`ArrowUp`/`ArrowDown`/`Home`/`End`/`Enter`/`Esc`), note/board duplication, inline sidebar tag/board renaming, inline color tint pickers, and Board `Copy`/`Cut`/`Paste`/`Select All` (`Ctrl+C`/`Ctrl+X`/`Ctrl+A`), while preserving native browser spellcheck/edit menus inside `<input>`/`<textarea>` controls and via `Shift + Right-Click`.

### Changed
- **Shared Rendering & Media Modules**: Extracted shared DOM/text/rotation utilities (`src/utils.ts`), clipboard/WebP compression helpers (`src/media.ts`), and accessible context menu logic (`src/context-menu.ts`), and updated `sanitizeClonedPortableDom()` in `src/cloud-sync.ts` for new Board and Context Menu overlays.

### Fixed
- **Board Selection & Formatting Bar Stability**: Floated `#boardSelectionBar` above the canvas stage so toggling selection never shifts the canvas vertically, kept single-selection resize/rotate handles visible while typing, and separated border clicks from interior text clicks so clicking a box border never flashes or jumps straight back into `<textarea>` editing.

## [1.3.0] - 2026-11-17
### Added
- **Encrypted Image Attachments & URL Import**: Paste screenshots or image URLs directly via `Ctrl+V`, drag-and-drop image files, upload files, or link image URLs in both the quick composer and note editor. Images are resized and compressed on-device to WebP before AES-256-GCM encryption, with CORS fallback to `no-referrer` external links, inline `![alt](url)` Markdown rendering, card galleries, and a click-to-zoom lightbox.
- **IndexedDB Vault Cache**: Cached encrypted vault envelopes in IndexedDB (`crypsy_vault_cache_db_v1`) alongside `localStorage` so vaults with embedded images do not hit `localStorage`'s 5 MB quota limit.
- **Collapsible Sidebar Sections**: Added persistent expand/collapse toggles for the **Tags** and **Quick Guide** sidebar sections (defaulting to both expanded).

### Changed
- **Search Input Overflow Fade**: Added a smooth horizontal fade mask (`mask-image`) on overflowing search text and reclaimed unused right padding when the clear button is hidden.
- **Document Title & Landing Site**: Simplified the web app `<title>` to `Crypsy` and updated the landing page preview card to highlight encrypted WebP clipboard & URL images.

### Fixed
- **Portable HTML Bundling Over `file://`**: Updated `buildSelfContainedHtmlInBrowser()` so opening `index.html` over `file://` will no longer overwrite `Crypsy-Portable.html` with an unstyled `outerHTML` snapshot referencing external `styles.css` and `dist/app.bundle.js`, and added clean DOM sanitization when exporting from an already self-contained portable bundle.

## [1.2.0] - 2026-11-15
### Changed
- **TypeScript + esbuild Pipeline**: Migrated `crypto.js`, `cloud-sync.js`, and `app.js` to strict TypeScript modules under `src/` (`types.ts`, `crypto.ts`, `cloud-sync.ts`, `app.ts`) bundled via `esbuild` into `dist/app.bundle.js`, shrinking `Crypsy-Portable.html` from ~144 KB to ~107 KB.

## [1.1.1] - 2026-11-15
### Changed
- Replaced the refresh icon on the **Check for Updates** topbar button with a gear icon.

## [1.1.0] - 2026-11-15
### Added
- **Smart List & Checkbox Continuation**: Pressing `Enter` inside a bullet list, numbered list, or task checkbox (`- [ ]` / `- [x]`) automatically continues the list (incrementing numbers and creating unchecked `[ ]` tasks), and pressing `Enter` on an empty list item exits the list.
- **Topbar Polish**: Replaced the duplicate shield icon with a dedicated **Check for Updates** icon button and moved the theme toggle to the left of the view toggle.

## [1.0.0] - 2026-11-15 — First Public Release
### Added
- **First Public Release (`v1.0.0`)**: Promoted Crypsy Note from experimental pre-release to `v1.0.0`.
- **Application & Vault Versioning**: Added `APP_VERSION` (`1.0.0`), `VAULT_SCHEMA_VERSION` (`1`), topbar version badge (`v1.0.0`), `VERSION` file, and `--version` / `-v` CLI flag in `install.js`.
- **Encrypted Envelope Metadata**: Embedded `appVersion` in AES-256-GCM vault envelopes (`vault.crypsy.json`) and portable bundle headers.

## [0.9.0] - 2026-11-08 — Release Candidate
### Added
- Cross-platform CLI cloud drive auto-detector & installer (`install.js`, `install.ps1`, `install.sh`).
- Single-file zero-dependency portable bundler (`Crypsy-Portable.html`) and optional Desktop shortcut creation.

## [0.8.0] - 2024-10-19
### Added
- **Bring Your Own Cloud (BYOC)** synchronization engine (`cloud-sync.js`) built on the Browser File System Access API and IndexedDB handle persistence.
- 3-step Cloud Folder Onboarding & Provisioning Wizard supporting Microsoft OneDrive, Google Drive, Dropbox, iCloud Drive, and custom folders.
- Live auto-save to `vault.crypsy.json` and cross-device file-modification polling.

## [0.5.0] - 2022-08-20
### Added
- **WebCrypto AES-256-GCM Engine (`crypto.js`)**: Client-side `PBKDF2-SHA256` (150,000 iterations) key derivation and authenticated `AES-256-GCM` encryption at rest.
- Cloud Ciphertext Inspector modal, custom vault passphrase re-keying, lock screen overlay, and `.crypsy.json` import/export.

## [0.3.0] - 2021-01-21
### Added
- Sidebar `#tag` management, per-note tag popover assignment, and one-click tag chip filtering.
- Instant client-side search across note titles, descriptions, and `#tags` with live `<mark>` match highlighting and `/` or `Ctrl+K` shortcuts.

## [0.2.0] - 2020-04-18
### Added
- `PINNED` vs `OTHERS` note sections, responsive Card Grid / List view toggle, Dark & Light themes, and 7 adaptive note card color palettes.

## [0.1.0] - 2019-11-14
### Added
- Initial weekend prototype with expandable quick note composer, modal editor, and local storage persistence.
