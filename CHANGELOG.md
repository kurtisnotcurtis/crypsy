# Changelog

All notable changes to **Crypsy Note** are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

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
