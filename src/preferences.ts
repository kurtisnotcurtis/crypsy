/**
 * Crypsy — UI Preferences Persistence, Passphrase Validation & First-Launch Seed Notes
 */

import { MIN_PASSPHRASE_LENGTH } from './vault/crypto';
import type { AppState, Note } from './types';

export const STORAGE_KEY_PREFS = 'crypsy_ui_prefs_v1';

const ALLOWED_AUTO_LOCK_MINUTES = [0, 5, 15, 30, 60] as const;

export interface ParsedPreferences {
  viewMode?: 'grid' | 'list';
  theme?: 'dark' | 'light';
  boardsSectionExpanded?: boolean;
  tagsSectionExpanded?: boolean;
  guideSectionExpanded?: boolean;
  autoCheckUpdates?: boolean;
  autoLockMinutes?: number;
  lockOnHide?: boolean;
  blockExternalMedia?: boolean;
}

interface RawStoredPrefs {
  viewMode?: unknown;
  theme?: unknown;
  boardsSectionExpanded?: unknown;
  tagsSectionExpanded?: unknown;
  guideSectionExpanded?: unknown;
  autoCheckUpdates?: unknown;
  autoLockMinutes?: unknown;
  lockOnHide?: unknown;
  blockExternalMedia?: unknown;
}

export function parseStoredPreferences(raw: string | null): ParsedPreferences {
  if (!raw) return {};
  const prefs = JSON.parse(raw) as RawStoredPrefs;
  const parsed: ParsedPreferences = {};

  if (prefs.viewMode === 'list' || prefs.viewMode === 'grid') {
    parsed.viewMode = prefs.viewMode;
  }
  if (prefs.theme === 'light' || prefs.theme === 'dark') {
    parsed.theme = prefs.theme;
  }
  if (typeof prefs.boardsSectionExpanded === 'boolean') {
    parsed.boardsSectionExpanded = prefs.boardsSectionExpanded;
  }
  if (typeof prefs.tagsSectionExpanded === 'boolean') {
    parsed.tagsSectionExpanded = prefs.tagsSectionExpanded;
  }
  if (typeof prefs.guideSectionExpanded === 'boolean') {
    parsed.guideSectionExpanded = prefs.guideSectionExpanded;
  }
  if (typeof prefs.autoCheckUpdates === 'boolean') {
    parsed.autoCheckUpdates = prefs.autoCheckUpdates;
  }
  if (
    typeof prefs.autoLockMinutes === 'number' &&
    (ALLOWED_AUTO_LOCK_MINUTES as readonly number[]).includes(prefs.autoLockMinutes)
  ) {
    parsed.autoLockMinutes = prefs.autoLockMinutes;
  }
  if (typeof prefs.lockOnHide === 'boolean') {
    parsed.lockOnHide = prefs.lockOnHide;
  }
  if (typeof prefs.blockExternalMedia === 'boolean') {
    parsed.blockExternalMedia = prefs.blockExternalMedia;
  }
  return parsed;
}

export function loadPreferencesIntoState(state: AppState): void {
  try {
    const parsed = parseStoredPreferences(localStorage.getItem(STORAGE_KEY_PREFS));
    if (parsed.viewMode !== undefined) state.viewMode = parsed.viewMode;
    if (parsed.theme !== undefined) state.theme = parsed.theme;
    if (parsed.boardsSectionExpanded !== undefined) {
      state.boardsSectionExpanded = parsed.boardsSectionExpanded;
    }
    if (parsed.tagsSectionExpanded !== undefined) {
      state.tagsSectionExpanded = parsed.tagsSectionExpanded;
    }
    if (parsed.guideSectionExpanded !== undefined) {
      state.guideSectionExpanded = parsed.guideSectionExpanded;
    }
    if (parsed.autoCheckUpdates !== undefined) {
      state.autoCheckUpdates = parsed.autoCheckUpdates;
    }
    if (parsed.autoLockMinutes !== undefined) {
      state.autoLockMinutes = parsed.autoLockMinutes;
    }
    if (parsed.lockOnHide !== undefined) state.lockOnHide = parsed.lockOnHide;
    if (parsed.blockExternalMedia !== undefined) {
      state.blockExternalMedia = parsed.blockExternalMedia;
    }
  } catch (e) {
    console.warn('Failed to load UI prefs:', e);
  }
}

export function savePreferencesFromState(state: AppState): void {
  localStorage.setItem(
    STORAGE_KEY_PREFS,
    JSON.stringify({
      viewMode: state.viewMode,
      theme: state.theme,
      boardsSectionExpanded: state.boardsSectionExpanded,
      tagsSectionExpanded: state.tagsSectionExpanded,
      guideSectionExpanded: state.guideSectionExpanded,
      autoCheckUpdates: state.autoCheckUpdates,
      autoLockMinutes: state.autoLockMinutes,
      lockOnHide: state.lockOnHide,
      blockExternalMedia: state.blockExternalMedia,
    })
  );
}

export function validateNewPassphrase(pass: string, confirm: string): string | null {
  if (!pass || pass.trim().length === 0) {
    return 'Enter a passphrase to encrypt your vault.';
  }
  if (pass.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`;
  }
  if (pass !== confirm) {
    return 'Passphrases do not match.';
  }
  return null;
}

export function createSeedNotes(now = Date.now()): Note[] {
  return [
    {
      id: 'note-1',
      title: 'Welcome to Crypsy',
      description:
        'Your notes are decrypted on-device and encrypted with AES-256-GCM before touching storage.\n\nClick "Setup Cloud Folder" in the top bar to walk through placing your encrypted vault and portable app directly inside OneDrive, Google Drive, Dropbox, or iCloud!',
      tags: ['security', 'ideas'],
      pinned: true,
      color: 'teal',
      createdAt: now - 3600000 * 24,
      updatedAt: now - 3600000 * 2,
    },
    {
      id: 'note-2',
      title: 'Product Roadmap & Architecture',
      description:
        '1. BYOC Cloud Sync via local cloud folder (vault.crypsy.json + Crypsy-Portable.html)\n2. WebAuthn PRF hardware passkey unlock\n3. Desktop on-demand virtual filesystem hydration\n4. Android SAF DocumentsProvider biometric prompt',
      tags: ['work', 'security'],
      pinned: true,
      color: 'cobalt',
      createdAt: now - 3600000 * 18,
      updatedAt: now - 3600000 * 1,
    },
    {
      id: 'note-3',
      title: 'Quick Keyboard Shortcuts',
      description:
        '• Press "/" or Ctrl+K to jump to search\n• Click any note card to open the full editor\n• Toggle between Card Grid and List view in the top-right toolbar\n• Click any #tag chip to filter immediately',
      tags: ['ideas'],
      pinned: false,
      color: 'amber',
      createdAt: now - 3600000 * 12,
      updatedAt: now - 3600000 * 5,
    },
    {
      id: 'note-4',
      title: 'Weekend Grocery & Errands',
      description:
        '- Espresso beans (whole bean, medium roast)\n- Sparkling water\n- Olive oil & garlic\n- Pick up hardware security key backup (YubiKey 5C NFC)',
      tags: ['personal'],
      pinned: false,
      color: 'sage',
      createdAt: now - 3600000 * 6,
      updatedAt: now - 3600000 * 3,
    },
  ];
}
