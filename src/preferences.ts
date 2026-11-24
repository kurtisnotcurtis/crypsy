/**
 * Crypsy — UI Preferences Persistence, Passphrase Validation & First-Launch Seed Notes
 */

import { MIN_PASSPHRASE_LENGTH } from './vault/crypto';
import type { AppState, Note, UiPreferences } from './types';

export const STORAGE_KEY_PREFS = 'crypsy_ui_prefs_v1';

const ALLOWED_AUTO_LOCK_MINUTES = [0, 5, 15, 30, 60] as const;

export const DEFAULT_PREFERENCES: UiPreferences = {
  viewMode: 'grid',
  theme: 'dark',
  boardsSectionExpanded: true,
  tagsSectionExpanded: true,
  guideSectionExpanded: true,
  autoCheckUpdates: false,
  autoLockMinutes: 15,
  lockOnHide: false,
  blockExternalMedia: true,
};

type PrefKey = keyof UiPreferences;

const PREF_VALIDATORS: { [K in PrefKey]: (val: unknown) => val is UiPreferences[K] } = {
  viewMode: (v): v is UiPreferences['viewMode'] => v === 'list' || v === 'grid',
  theme: (v): v is UiPreferences['theme'] => v === 'light' || v === 'dark',
  boardsSectionExpanded: (v): v is boolean => typeof v === 'boolean',
  tagsSectionExpanded: (v): v is boolean => typeof v === 'boolean',
  guideSectionExpanded: (v): v is boolean => typeof v === 'boolean',
  autoCheckUpdates: (v): v is boolean => typeof v === 'boolean',
  autoLockMinutes: (v): v is number =>
    typeof v === 'number' && (ALLOWED_AUTO_LOCK_MINUTES as readonly number[]).includes(v),
  lockOnHide: (v): v is boolean => typeof v === 'boolean',
  blockExternalMedia: (v): v is boolean => typeof v === 'boolean',
};

const PREF_KEYS = Object.keys(DEFAULT_PREFERENCES) as PrefKey[];

export type ParsedPreferences = Partial<UiPreferences>;

export function parseStoredPreferences(raw: string | null): ParsedPreferences {
  if (!raw) return {};
  const prefs = JSON.parse(raw) as Record<string, unknown>;
  if (!prefs || typeof prefs !== 'object') return {};

  const parsed: ParsedPreferences = {};
  for (const key of PREF_KEYS) {
    const val = prefs[key];
    if (PREF_VALIDATORS[key](val)) {
      (parsed as Record<PrefKey, unknown>)[key] = val;
    }
  }
  return parsed;
}

export function loadPreferencesIntoState(state: AppState): void {
  try {
    const parsed = parseStoredPreferences(localStorage.getItem(STORAGE_KEY_PREFS));
    Object.assign(state, parsed);
  } catch (e) {
    console.warn('Failed to load UI prefs:', e);
  }
}

export function savePreferencesFromState(state: AppState): void {
  const out = {} as Record<PrefKey, unknown>;
  for (const key of PREF_KEYS) {
    out[key] = state[key];
  }
  localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(out));
}

const WEAK_PASSPHRASES = new Set([
  'password1234',
  'password12345',
  'password123456',
  'passphrase12',
  '123456789012',
  '1234567890123',
  'qwertyuiopas',
  'qwerty123456',
  'letmein12345',
  'crypsy-local-device-default-key-v1',
]);

export function validateNewPassphrase(pass: string, confirm: string): string | null {
  if (!pass || pass.trim().length === 0) {
    return 'Enter a passphrase to encrypt your vault.';
  }
  if (pass.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`;
  }
  const normalized = pass.trim().toLowerCase();
  if (/^(.)\1+$/.test(pass) || /^(.)\1+$/.test(normalized)) {
    return 'Choose a stronger passphrase (avoid repeating a single character).';
  }
  if (
    WEAK_PASSPHRASES.has(normalized) ||
    '01234567890123456789'.includes(normalized) ||
    '98765432109876543210'.includes(normalized) ||
    'abcdefghijklmnopqrstuvwxyz'.includes(normalized)
  ) {
    return 'Choose a stronger passphrase (avoid common or sequential passphrases).';
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
