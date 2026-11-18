/**
 * Crypsy — Main Application Logic
 * Implements Google Keep-style UX + Cloud Folder Onboarding & Live File Sync:
 * - Search (title, description, tags) with live highlight
 * - Tags (create, filter, assign/remove per note)
 * - Pins (PINNED vs OTHERS sections)
 * - Card (Grid) / List view toggle
 * - Note Title & Description with color themes
 * - Transparent client-side AES-256-GCM encryption
 * - Cloud Folder Provisioning Wizard & Live Auto-Sync (`vault.crypsy.json`)
 */

import { CrypsyCloudSync } from './cloud-sync';
import { CrypsyCrypto } from './crypto';
import type {
  ActiveFilter,
  AppState,
  CloudProviderId,
  EncryptedEnvelope,
  Note,
  NoteColor,
  RestoreConnectionResult,
} from './types';

const APP_VERSION = '1.2.0';
const STORAGE_KEY_VAULT = 'crypsy_encrypted_vault_v1';
const STORAGE_KEY_PREFS = 'crypsy_ui_prefs_v1';
const DEFAULT_DEVICE_SECRET = 'crypsy-local-device-default-key-v1';

window.CRYPSY_VERSION = APP_VERSION;

// Application State
const state: AppState = {
  notes: [],
  tags: ['security', 'ideas', 'work', 'personal'],
  searchQuery: '',
  activeFilter: { type: 'all', tag: null },
  viewMode: 'grid',
  theme: 'dark',
  tagsSectionExpanded: true,
  guideSectionExpanded: true,
  autoCheckUpdates: false,
  passphrase: DEFAULT_DEVICE_SECRET,
  lastEncryptedEnvelope: null,
  selectedProviderId: 'onedrive',
  composer: {
    expanded: false,
    pinned: false,
    color: 'default',
    tags: [],
  },
  editingNoteId: null,
  editingDraft: null,
};

// Seed notes for first-time launch
const SEED_NOTES: Note[] = [
  {
    id: 'note-1',
    title: 'Welcome to Crypsy',
    description:
      'Your notes are decrypted on-device and encrypted with AES-256-GCM before touching storage.\n\nClick "Setup Cloud Folder" in the top bar to walk through placing your encrypted vault and portable app directly inside OneDrive, Google Drive, Dropbox, or iCloud!',
    tags: ['security', 'ideas'],
    pinned: true,
    color: 'teal',
    createdAt: Date.now() - 3600000 * 24,
    updatedAt: Date.now() - 3600000 * 2,
  },
  {
    id: 'note-2',
    title: 'Product Roadmap & Architecture',
    description:
      '1. BYOC Cloud Sync via local cloud folder (vault.crypsy.json + Crypsy-Portable.html)\n2. WebAuthn PRF hardware passkey unlock\n3. Desktop on-demand virtual filesystem hydration\n4. Android SAF DocumentsProvider biometric prompt',
    tags: ['work', 'security'],
    pinned: true,
    color: 'cobalt',
    createdAt: Date.now() - 3600000 * 18,
    updatedAt: Date.now() - 3600000 * 1,
  },
  {
    id: 'note-3',
    title: 'Quick Keyboard Shortcuts',
    description:
      '• Press "/" or Ctrl+K to jump to search\n• Click any note card to open the full editor\n• Toggle between Card Grid and List view in the top-right toolbar\n• Click any #tag chip to filter immediately',
    tags: ['ideas'],
    pinned: false,
    color: 'amber',
    createdAt: Date.now() - 3600000 * 12,
    updatedAt: Date.now() - 3600000 * 5,
  },
  {
    id: 'note-4',
    title: 'Weekend Grocery & Errands',
    description:
      '- Espresso beans (whole bean, medium roast)\n- Sparkling water\n- Olive oil & garlic\n- Pick up hardware security key backup (YubiKey 5C NFC)',
    tags: ['personal'],
    pinned: false,
    color: 'sage',
    createdAt: Date.now() - 3600000 * 6,
    updatedAt: Date.now() - 3600000 * 3,
  },
];

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return el as T;
}

function maybeById<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// DOM Elements
const els = {
  sidebar: byId('sidebar'),
  sidebarToggleBtn: byId<HTMLButtonElement>('sidebarToggleBtn'),
  toggleTagsSectionBtn: maybeById<HTMLButtonElement>('toggleTagsSectionBtn'),
  sidebarTagsContent: maybeById('sidebarTagsContent'),
  sidebarTagsList: byId('sidebarTagsList'),
  newTagForm: byId<HTMLFormElement>('newTagForm'),
  newTagInput: byId<HTMLInputElement>('newTagInput'),
  toggleGuideSectionBtn: maybeById<HTMLButtonElement>('toggleGuideSectionBtn'),
  sidebarGuideContent: maybeById('sidebarGuideContent'),
  countAll: byId('countAll'),
  countPinned: byId('countPinned'),

  searchInput: byId<HTMLInputElement>('searchInput'),
  clearSearchBtn: byId<HTMLButtonElement>('clearSearchBtn'),
  cloudSetupBtn: byId<HTMLButtonElement>('cloudSetupBtn'),
  cloudSetupBtnLabel: byId('cloudSetupBtnLabel'),
  lastUpdatedBadge: maybeById('lastUpdatedBadge'),
  lastUpdatedText: maybeById('lastUpdatedText'),
  viewToggleBtn: byId<HTMLButtonElement>('viewToggleBtn'),
  viewIconList: byId('viewIconList'),
  viewIconGrid: byId('viewIconGrid'),
  themeToggleBtn: byId<HTMLButtonElement>('themeToggleBtn'),
  encryptionBadge: byId('encryptionBadge'),

  reconnectCloudBanner: byId('reconnectCloudBanner'),
  reconnectBannerMsg: byId('reconnectBannerMsg'),
  resumeCloudSyncBtn: byId<HTMLButtonElement>('resumeCloudSyncBtn'),
  changeCloudFolderBtn: byId<HTMLButtonElement>('changeCloudFolderBtn'),

  noteComposer: byId('noteComposer'),
  composerHeader: byId('composerHeader'),
  composerTitle: byId<HTMLInputElement>('composerTitle'),
  composerDescription: byId<HTMLTextAreaElement>('composerDescription'),
  composerPinBtn: byId<HTMLButtonElement>('composerPinBtn'),
  composerTagsRow: byId('composerTagsRow'),
  composerFooter: byId('composerFooter'),
  composerTagBtn: byId<HTMLButtonElement>('composerTagBtn'),
  composerTagPopover: byId('composerTagPopover'),
  composerTagSearch: byId<HTMLInputElement>('composerTagSearch'),
  composerTagOptions: byId('composerTagOptions'),
  composerColorPicker: byId('composerColorPicker'),
  composerCancelBtn: byId<HTMLButtonElement>('composerCancelBtn'),
  composerSaveBtn: byId<HTMLButtonElement>('composerSaveBtn'),

  activeFilterBanner: byId('activeFilterBanner'),
  activeFilterText: byId('activeFilterText'),
  resetFilterBtn: byId<HTMLButtonElement>('resetFilterBtn'),

  notesWorkspace: byId('notesWorkspace'),
  pinnedSection: byId('pinnedSection'),
  pinnedGrid: byId('pinnedGrid'),
  othersSection: byId('othersSection'),
  othersSectionLabel: byId('othersSectionLabel'),
  othersGrid: byId('othersGrid'),
  emptyState: byId('emptyState'),

  editModalBackdrop: byId('editModalBackdrop'),
  editModalCard: byId('editModalCard'),
  editModalTitle: byId<HTMLInputElement>('editModalTitle'),
  editModalDescription: byId<HTMLTextAreaElement>('editModalDescription'),
  editModalPinBtn: byId<HTMLButtonElement>('editModalPinBtn'),
  editModalTagsRow: byId('editModalTagsRow'),
  editModalTimestamp: byId('editModalTimestamp'),
  editModalTagBtn: byId<HTMLButtonElement>('editModalTagBtn'),
  editModalTagPopover: byId('editModalTagPopover'),
  editModalTagSearch: byId<HTMLInputElement>('editModalTagSearch'),
  editModalTagOptions: byId('editModalTagOptions'),
  editModalColorPicker: byId('editModalColorPicker'),
  editModalDeleteBtn: byId<HTMLButtonElement>('editModalDeleteBtn'),
  editModalSaveBtn: byId<HTMLButtonElement>('editModalSaveBtn'),

  // Cloud Onboarding Wizard
  cloudOnboardingBackdrop: byId('cloudOnboardingBackdrop'),
  closeOnboardingBtn: byId<HTMLButtonElement>('closeOnboardingBtn'),
  providerSelectionGrid: byId('providerSelectionGrid'),
  downloadPortableBtn: byId<HTMLButtonElement>('downloadPortableBtn'),
  wizardToStep2Btn: byId<HTMLButtonElement>('wizardToStep2Btn'),
  wizardBackToStep1Btn: byId<HTMLButtonElement>('wizardBackToStep1Btn'),
  selectedProviderTitle: byId('selectedProviderTitle'),
  osPathHintCode: byId('osPathHintCode'),
  copyPathHintBtn: byId<HTMLButtonElement>('copyPathHintBtn'),
  folderPickerHintText: byId('folderPickerHintText'),
  createCrypsySubfolderCb: byId<HTMLInputElement>('createCrypsySubfolderCb'),
  provisionPortableHtmlCb: byId<HTMLInputElement>('provisionPortableHtmlCb'),
  wizardStep2Error: byId('wizardStep2Error'),
  pickAndProvisionBtn: byId<HTMLButtonElement>('pickAndProvisionBtn'),
  connectedProviderHeading: byId('connectedProviderHeading'),
  connectedFolderDetails: byId('connectedFolderDetails'),
  unlinkCloudFolderBtn: byId<HTMLButtonElement>('unlinkCloudFolderBtn'),
  reprovisionAssetsBtn: byId<HTMLButtonElement>('reprovisionAssetsBtn'),
  finishOnboardingBtn: byId<HTMLButtonElement>('finishOnboardingBtn'),
  wizardStep1: byId('wizardStep1'),
  wizardStep2: byId('wizardStep2'),
  wizardStep3: byId('wizardStep3'),

  // Vault Inspector Modal
  vaultModalBackdrop: byId('vaultModalBackdrop'),
  closeVaultModalBtn: byId<HTMLButtonElement>('closeVaultModalBtn'),
  vaultPassphraseInput: byId<HTMLInputElement>('vaultPassphraseInput'),
  updatePassphraseBtn: byId<HTMLButtonElement>('updatePassphraseBtn'),
  lockVaultNowBtn: byId<HTMLButtonElement>('lockVaultNowBtn'),
  ciphertextPreview: byId('ciphertextPreview'),
  exportEncryptedBtn: byId<HTMLButtonElement>('exportEncryptedBtn'),
  importEncryptedInput: byId<HTMLInputElement>('importEncryptedInput'),

  // Updates Modal
  appVersionBadge: maybeById('appVersionBadge'),
  topbarUpdatesBtn: maybeById<HTMLButtonElement>('topbarUpdatesBtn'),
  updatesModalBackdrop: maybeById('updatesModalBackdrop'),
  closeUpdatesModalBtn: maybeById<HTMLButtonElement>('closeUpdatesModalBtn'),
  installedVersionLabel: maybeById('installedVersionLabel'),
  autoCheckUpdatesCb: maybeById<HTMLInputElement>('autoCheckUpdatesCb'),
  updateCheckStatus: maybeById('updateCheckStatus'),
  checkUpdatesNowBtn: maybeById<HTMLButtonElement>('checkUpdatesNowBtn'),

  lockScreenOverlay: byId('lockScreenOverlay'),
  unlockVaultForm: byId<HTMLFormElement>('unlockVaultForm'),
  unlockPassphraseInput: byId<HTMLInputElement>('unlockPassphraseInput'),
  unlockErrorMsg: byId('unlockErrorMsg'),
};

// Utility helpers
function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightText(text: string, query: string): string {
  const safe = escapeHtml(text);
  if (!query || !query.trim()) return safe;
  const cleanQ = query.trim().replace(/^#/, '');
  if (!cleanQ) return safe;
  const escapedRegex = cleanQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedRegex})`, 'gi');
  return safe.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(ms: number): string {
  if (!ms) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return formatTimestamp(ms);
}

function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(textarea.scrollHeight, 32)}px`;
}

function handleListEnterKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) {
    return;
  }

  const textarea = e.currentTarget as HTMLTextAreaElement;
  const value = textarea.value;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIdx = value.indexOf('\n', end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const lineBeforeCursor = value.slice(lineStart, start);
  const lineAfterCursor = value.slice(end, lineEnd);

  let nextPrefix: string | null = null;
  let isEmptyItem = false;

  const taskMatch = lineBeforeCursor.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/);
  if (taskMatch) {
    isEmptyItem = (taskMatch[4] ?? '').trim() === '' && lineAfterCursor.trim() === '';
    nextPrefix = `${taskMatch[1] ?? ''}${taskMatch[2] ?? '-'} [ ] `;
  } else {
    const ulMatch = lineBeforeCursor.match(/^(\s*)([-*+•])\s+(.*)$/);
    if (ulMatch) {
      isEmptyItem = (ulMatch[3] ?? '').trim() === '' && lineAfterCursor.trim() === '';
      nextPrefix = `${ulMatch[1] ?? ''}${ulMatch[2] ?? '-'} `;
    } else {
      const olMatch = lineBeforeCursor.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
      if (olMatch) {
        isEmptyItem = (olMatch[4] ?? '').trim() === '' && lineAfterCursor.trim() === '';
        const nextNum = parseInt(olMatch[2] ?? '0', 10) + 1;
        nextPrefix = `${olMatch[1] ?? ''}${nextNum}${olMatch[3] ?? '.'} `;
      }
    }
  }

  if (nextPrefix === null) return;

  e.preventDefault();
  if (isEmptyItem) {
    textarea.value = value.slice(0, lineStart) + value.slice(lineEnd);
    textarea.selectionStart = textarea.selectionEnd = lineStart;
  } else {
    const insertion = `\n${nextPrefix}`;
    textarea.value = value.slice(0, start) + insertion + value.slice(end);
    const nextPos = start + insertion.length;
    textarea.selectionStart = textarea.selectionEnd = nextPos;
  }
  autoResizeTextarea(textarea);
}

// Preferences
interface StoredPrefs {
  viewMode?: unknown;
  theme?: unknown;
  tagsSectionExpanded?: unknown;
  guideSectionExpanded?: unknown;
  autoCheckUpdates?: unknown;
}

function loadPreferences(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFS);
    if (!raw) return;
    const prefs = JSON.parse(raw) as StoredPrefs;
    if (prefs.viewMode === 'list' || prefs.viewMode === 'grid') {
      state.viewMode = prefs.viewMode;
    }
    if (prefs.theme === 'light' || prefs.theme === 'dark') {
      state.theme = prefs.theme;
    }
    if (typeof prefs.tagsSectionExpanded === 'boolean') {
      state.tagsSectionExpanded = prefs.tagsSectionExpanded;
    }
    if (typeof prefs.guideSectionExpanded === 'boolean') {
      state.guideSectionExpanded = prefs.guideSectionExpanded;
    }
    if (typeof prefs.autoCheckUpdates === 'boolean') {
      state.autoCheckUpdates = prefs.autoCheckUpdates;
    }
  } catch (e) {
    console.warn('Failed to load UI prefs:', e);
  }
}

function savePreferences(): void {
  localStorage.setItem(
    STORAGE_KEY_PREFS,
    JSON.stringify({
      viewMode: state.viewMode,
      theme: state.theme,
      tagsSectionExpanded: state.tagsSectionExpanded,
      guideSectionExpanded: state.guideSectionExpanded,
      autoCheckUpdates: state.autoCheckUpdates,
    })
  );
}

function compareSemver(a: string, b: string): number {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
}

async function checkForUpdates(silent = false): Promise<void> {
  if (!els.updateCheckStatus) return;
  if (!silent) {
    els.updateCheckStatus.className = 'update-status-box';
    els.updateCheckStatus.textContent = 'Checking GitHub Releases...';
  }

  try {
    const res = await fetch('https://api.github.com/repos/kurtisnotcurtis/crypsy/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('No published GitHub Releases found yet.');
      }
      throw new Error(`GitHub API returned ${res.status}`);
    }

    const release = (await res.json()) as GitHubReleaseResponse;
    const latestTag = release.tag_name || release.name || '';
    const isNewer = compareSemver(latestTag, APP_VERSION) > 0;
    const portableAsset = Array.isArray(release.assets)
      ? release.assets.find((a) => a.name && a.name.toLowerCase().includes('portable'))
      : undefined;
    const downloadUrl =
      portableAsset?.browser_download_url ||
      release.html_url ||
      'https://github.com/kurtisnotcurtis/crypsy/releases/latest';

    if (isNewer) {
      if (els.appVersionBadge) {
        els.appVersionBadge.classList.add('update-available');
        els.appVersionBadge.textContent = `v${APP_VERSION} • Update`;
        els.appVersionBadge.title = `Update available: ${latestTag}`;
      }
      els.updateCheckStatus.className = 'update-status-box has-update';
      els.updateCheckStatus.innerHTML = `
        <div><strong>Update available: ${escapeHtml(latestTag)}</strong> (installed: v${escapeHtml(APP_VERSION)})</div>
        <div class="update-actions-row">
          <a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer" class="btn-primary" style="text-decoration:none;">Download ${escapeHtml(latestTag)}</a>
          <a href="${escapeHtml(release.html_url || downloadUrl)}" target="_blank" rel="noopener noreferrer" class="btn-link">Release Notes</a>
        </div>
      `;
    } else {
      if (els.appVersionBadge) {
        els.appVersionBadge.classList.remove('update-available');
        els.appVersionBadge.textContent = `v${APP_VERSION}`;
      }
      els.updateCheckStatus.className = 'update-status-box up-to-date';
      els.updateCheckStatus.innerHTML = `You're up to date on <strong>v${escapeHtml(APP_VERSION)}</strong> (latest: ${escapeHtml(latestTag || `v${APP_VERSION}`)}).`;
    }
  } catch (err) {
    if (!silent) {
      els.updateCheckStatus.className = 'update-status-box error';
      const msg = err instanceof Error ? err.message : 'Network error';
      els.updateCheckStatus.textContent = `Could not check for updates: ${msg || 'Network error'}`;
    }
  }
}

// Persistence & Cloud Sync
async function persistEncryptedVault(): Promise<void> {
  const payload = {
    notes: state.notes,
    tags: state.tags,
  };
  const envelope = await CrypsyCrypto.encryptPayload(payload, state.passphrase);
  state.lastEncryptedEnvelope = envelope;
  localStorage.setItem(STORAGE_KEY_VAULT, JSON.stringify(envelope));

  if (CrypsyCloudSync.isConnected()) {
    try {
      await CrypsyCloudSync.writeVaultToCloudFolder(envelope);
      updateCloudStatusUI();
    } catch (e) {
      console.warn('Failed writing vault to cloud folder:', e);
    }
  }

  updateVaultInspectorUI();
}

async function tryLoadEnvelope(envelope: EncryptedEnvelope): Promise<boolean> {
  state.lastEncryptedEnvelope = envelope;
  localStorage.setItem(STORAGE_KEY_VAULT, JSON.stringify(envelope));
  try {
    const decrypted = await CrypsyCrypto.decryptPayload(envelope, state.passphrase);
    state.notes = Array.isArray(decrypted.notes) ? decrypted.notes : [];
    state.tags = Array.isArray(decrypted.tags) ? decrypted.tags : [];
    renderAll();
    return true;
  } catch {
    els.lockScreenOverlay.classList.remove('hidden');
    els.unlockPassphraseInput.focus();
    return false;
  }
}

async function initVault(): Promise<void> {
  loadPreferences();
  applyThemeUI();
  applyViewModeUI();
  applySidebarSectionsUI();

  // Listen for external cloud folder updates (e.g. synced from another device)
  CrypsyCloudSync.onExternalUpdate(async (externalEnvelope) => {
    await tryLoadEnvelope(externalEnvelope);
    updateCloudStatusUI();
  });

  // Check if running from a cloud folder and pre-select provider if detected
  const detectedCloud = CrypsyCloudSync.detectRunningCloudLocation();
  if (detectedCloud && detectedCloud.providerId) {
    state.selectedProviderId = detectedCloud.providerId;
  }

  // Check if a cloud folder was previously linked
  const cloudState = await CrypsyCloudSync.restoreSavedConnection();
  updateCloudStatusUI(cloudState);

  setInterval(updateLastUpdatedUI, 30000);

  if (els.autoCheckUpdatesCb) {
    els.autoCheckUpdatesCb.checked = state.autoCheckUpdates;
  }
  if (els.installedVersionLabel) {
    els.installedVersionLabel.textContent = `v${APP_VERSION}`;
  }
  if (state.autoCheckUpdates) {
    void checkForUpdates(true);
  }

  if (cloudState.status === 'connected') {
    const cloudEnvelope = await CrypsyCloudSync.readVaultFromCloudFolder();
    if (cloudEnvelope) {
      await tryLoadEnvelope(cloudEnvelope);
      updateLastUpdatedUI();
      return;
    }
  }

  const storedRaw = localStorage.getItem(STORAGE_KEY_VAULT);
  if (!storedRaw) {
    state.notes = SEED_NOTES;
    await persistEncryptedVault();
    renderAll();
    return;
  }

  try {
    const envelope = JSON.parse(storedRaw) as EncryptedEnvelope;
    await tryLoadEnvelope(envelope);
  } catch {
    state.notes = SEED_NOTES;
    await persistEncryptedVault();
    renderAll();
  }
}

function updateLastUpdatedUI(): void {
  if (!els.lastUpdatedBadge || !els.lastUpdatedText) return;

  const meta = CrypsyCloudSync.getSavedProviderMeta();
  const isConnected = CrypsyCloudSync.isConnected();
  const fileModifiedMs = CrypsyCloudSync.getLastKnownFileModified();
  const envelopeUpdatedMs =
    state.lastEncryptedEnvelope && state.lastEncryptedEnvelope.updatedAt
      ? Date.parse(state.lastEncryptedEnvelope.updatedAt)
      : 0;
  const syncedAtMs = meta && meta.lastSyncedAt ? Date.parse(meta.lastSyncedAt) : 0;
  const latestNoteMs = state.notes.reduce((max, n) => Math.max(max, n.updatedAt || 0), 0);

  const bestTimestamp = isConnected
    ? Math.max(fileModifiedMs || 0, syncedAtMs || 0, envelopeUpdatedMs || 0)
    : Math.max(envelopeUpdatedMs || 0, latestNoteMs || 0);

  if (!bestTimestamp) {
    els.lastUpdatedBadge.classList.add('hidden');
    return;
  }

  const rel = formatRelativeTime(bestTimestamp);
  const fullDate = new Date(bestTimestamp).toLocaleString();
  const prefix = isConnected ? 'Synced' : 'Updated';

  els.lastUpdatedBadge.classList.remove('hidden');
  els.lastUpdatedBadge.classList.toggle('synced', isConnected);
  els.lastUpdatedText.textContent = `${prefix} ${rel}`;
  els.lastUpdatedBadge.title = `${prefix} at ${fullDate}`;
}

function updateCloudStatusUI(restoredState?: Pick<RestoreConnectionResult, 'status'>): void {
  const meta = CrypsyCloudSync.getSavedProviderMeta();
  const isConnected =
    CrypsyCloudSync.isConnected() && (!restoredState || restoredState.status === 'connected');
  const detectedCloud = CrypsyCloudSync.detectRunningCloudLocation();

  if (restoredState && restoredState.status === 'needs_permission' && meta) {
    els.reconnectBannerMsg.innerHTML = `Linked to <strong>${escapeHtml(meta.providerName)} (${escapeHtml(meta.folderName)})</strong>. Click to resume live auto-sync.`;
    els.reconnectCloudBanner.classList.remove('hidden');
    els.cloudSetupBtn.classList.remove('synced', 'detected');
    els.cloudSetupBtnLabel.textContent = `Resume ${meta.providerName}`;
    updateLastUpdatedUI();
    return;
  }

  els.reconnectCloudBanner.classList.add('hidden');

  if (isConnected && meta) {
    els.cloudSetupBtn.classList.remove('detected');
    els.cloudSetupBtn.classList.add('synced');
    els.cloudSetupBtnLabel.textContent = `${meta.providerName}: /${meta.folderName}`;
    els.cloudSetupBtn.title = `Live auto-sync active with ${meta.providerName} (/${meta.folderName})`;
  } else if (detectedCloud && detectedCloud.providerName) {
    els.cloudSetupBtn.classList.remove('synced');
    els.cloudSetupBtn.classList.add('detected');
    els.cloudSetupBtnLabel.textContent = `In ${detectedCloud.providerName} (Link Sync)`;
    els.cloudSetupBtn.title = `Running from your ${detectedCloud.providerName} folder — click to link live auto-sync for vault.crypsy.json`;
  } else if (detectedCloud && detectedCloud.isPortableFile) {
    els.cloudSetupBtn.classList.remove('synced');
    els.cloudSetupBtn.classList.add('detected');
    els.cloudSetupBtnLabel.textContent = 'Portable Mode (Link Sync)';
    els.cloudSetupBtn.title =
      'Running as a local portable file — click to link your cloud folder for live auto-sync';
  } else {
    els.cloudSetupBtn.classList.remove('synced', 'detected');
    els.cloudSetupBtnLabel.textContent = 'Setup Cloud Folder';
    els.cloudSetupBtn.title = 'Connect or manage synced cloud provider folder';
  }

  updateLastUpdatedUI();
}

// Theme & View Mode UI
function applyThemeUI(): void {
  document.documentElement.setAttribute('data-theme', state.theme);
}

function applyViewModeUI(): void {
  if (state.viewMode === 'list') {
    els.notesWorkspace.classList.remove('view-grid');
    els.notesWorkspace.classList.add('view-list');
    els.viewIconList.classList.add('hidden');
    els.viewIconGrid.classList.remove('hidden');
    els.viewToggleBtn.title = 'Switch to Card Grid view';
  } else {
    els.notesWorkspace.classList.remove('view-list');
    els.notesWorkspace.classList.add('view-grid');
    els.viewIconGrid.classList.add('hidden');
    els.viewIconList.classList.remove('hidden');
    els.viewToggleBtn.title = 'Switch to List view';
  }
}

function applySidebarSectionsUI(): void {
  if (els.toggleTagsSectionBtn && els.sidebarTagsContent) {
    els.toggleTagsSectionBtn.setAttribute('aria-expanded', String(state.tagsSectionExpanded));
    els.toggleTagsSectionBtn.title = state.tagsSectionExpanded ? 'Collapse Tags' : 'Expand Tags';
    els.sidebarTagsContent.classList.toggle('hidden', !state.tagsSectionExpanded);
  }
  if (els.toggleGuideSectionBtn && els.sidebarGuideContent) {
    els.toggleGuideSectionBtn.setAttribute('aria-expanded', String(state.guideSectionExpanded));
    els.toggleGuideSectionBtn.title = state.guideSectionExpanded
      ? 'Collapse Quick Guide'
      : 'Expand Quick Guide';
    els.sidebarGuideContent.classList.toggle('hidden', !state.guideSectionExpanded);
  }
}

// Filtering & Search
function getFilteredNotes(): Note[] {
  const q = state.searchQuery.trim().toLowerCase();
  const cleanTagQuery = q.startsWith('#') ? q.slice(1) : q;

  return state.notes
    .filter((note) => {
      if (state.activeFilter.type === 'pinned' && !note.pinned) return false;
      if (
        state.activeFilter.type === 'tag' &&
        state.activeFilter.tag &&
        !note.tags.includes(state.activeFilter.tag)
      ) {
        return false;
      }

      if (!q) return true;

      const titleMatch = (note.title || '').toLowerCase().includes(q);
      const descMatch = (note.description || '').toLowerCase().includes(q);
      const tagMatch = (note.tags || []).some((t) => t.toLowerCase().includes(cleanTagQuery));
      return titleMatch || descMatch || tagMatch;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Render Functions
function renderSidebar(): void {
  els.countAll.textContent = String(state.notes.length);
  els.countPinned.textContent = String(state.notes.filter((n) => n.pinned).length);

  document.querySelectorAll('.sidebar-nav > .nav-item').forEach((btn) => {
    const filterType = btn.getAttribute('data-filter-type');
    const isActive = state.activeFilter.type === filterType && !state.activeFilter.tag;
    btn.classList.toggle('active', isActive);
  });

  els.sidebarTagsList.innerHTML = state.tags
    .map((tag) => {
      const count = state.notes.filter((n) => n.tags.includes(tag)).length;
      const isActive = state.activeFilter.type === 'tag' && state.activeFilter.tag === tag;
      return `
        <div class="nav-item ${isActive ? 'active' : ''}" data-tag="${escapeHtml(tag)}">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
            <line x1="7" y1="7" x2="7.01" y2="7"></line>
          </svg>
          <span class="nav-label">#${escapeHtml(tag)}</span>
          <span class="nav-count">${count}</span>
          <button type="button" class="tag-delete-btn" data-delete-tag="${escapeHtml(tag)}" title="Delete tag">&times;</button>
        </div>
      `;
    })
    .join('');
}

function renderFilterBanner(): void {
  const parts: string[] = [];
  if (state.activeFilter.type === 'pinned') {
    parts.push('Filtered by: <strong>Pinned</strong>');
  } else if (state.activeFilter.type === 'tag' && state.activeFilter.tag) {
    parts.push(`Filtered by tag: <strong>#${escapeHtml(state.activeFilter.tag)}</strong>`);
  }
  if (state.searchQuery.trim()) {
    parts.push(`Search: <strong>"${escapeHtml(state.searchQuery.trim())}"</strong>`);
  }

  if (parts.length > 0) {
    els.activeFilterText.innerHTML = parts.join(' &bull; ');
    els.activeFilterBanner.classList.remove('hidden');
  } else {
    els.activeFilterBanner.classList.add('hidden');
  }
}

function renderMarkdownDescription(noteId: string, text: string, query: string): string {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  const out: string[] = [];
  let listType: 'ul' | 'ol' | 'task' | null = null;
  let listStart = 1;

  const closeList = (): void => {
    if (!listType) return;
    out.push(listType === 'ol' ? '</ol>' : '</ul>');
    listType = null;
    listStart = 1;
  };

  lines.forEach((rawLine, idx) => {
    const taskMatch = rawLine.match(/^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
      if (listType !== 'task') {
        closeList();
        listType = 'task';
        out.push('<ul class="md-list md-task-list">');
      }
      const checked = (taskMatch[2] ?? '').toLowerCase() === 'x';
      const contentHtml = highlightText(taskMatch[3] ?? '', query);
      out.push(
        `<li class="md-task-item">` +
          `<input type="checkbox" class="md-checkbox" data-toggle-checkbox="${escapeHtml(noteId)}" data-line-index="${idx}" ${checked ? 'checked' : ''} aria-label="Toggle task" />` +
          `<span class="${checked ? 'md-task-done' : ''}">${contentHtml}</span>` +
          `</li>`
      );
      return;
    }

    const ulMatch = rawLine.match(/^(\s*)(?:[-*+•])\s+(.*)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        out.push('<ul class="md-list">');
      }
      out.push(`<li>${highlightText(ulMatch[2] ?? '', query)}</li>`);
      return;
    }

    const olMatch = rawLine.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (olMatch) {
      const num = parseInt(olMatch[2] ?? '1', 10);
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        listStart = Number.isFinite(num) && num > 0 ? num : 1;
        const startAttr = listStart !== 1 ? ` start="${listStart}"` : '';
        out.push(`<ol class="md-list"${startAttr}>`);
      }
      out.push(`<li>${highlightText(olMatch[3] ?? '', query)}</li>`);
      return;
    }

    closeList();
    if (rawLine.trim() === '') {
      out.push('<div class="md-spacer"></div>');
    } else {
      out.push(`<div class="md-line">${highlightText(rawLine, query)}</div>`);
    }
  });

  closeList();
  return out.join('');
}

async function toggleNoteCheckbox(noteId: string, lineIndex: number): Promise<void> {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note || typeof note.description !== 'string') return;
  const lines = note.description.split(/\r?\n/);
  if (lineIndex < 0 || lineIndex >= lines.length) return;

  const line = lines[lineIndex];
  if (line === undefined) return;
  const match = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s*.*)$/);
  if (!match) return;

  const nextState = (match[2] ?? ' ').toLowerCase() === 'x' ? ' ' : 'x';
  lines[lineIndex] = `${match[1] ?? ''}${nextState}${match[3] ?? ''}`;
  note.description = lines.join('\n');
  note.updatedAt = Date.now();
  await persistEncryptedVault();
  renderAll();
}

function createNoteCardHtml(note: Note): string {
  const q = state.searchQuery;
  const titleHtml = note.title ? highlightText(note.title, q) : '';
  const descHtml = note.description ? renderMarkdownDescription(note.id, note.description, q) : '';

  const tagsHtml = (note.tags || [])
    .map(
      (tag) =>
        `<span class="tag-chip" data-filter-tag="${escapeHtml(tag)}" title="Filter by #${escapeHtml(tag)}">#${highlightText(tag, q)}</span>`
    )
    .join('');

  return `
    <article class="note-card" data-note-id="${escapeHtml(note.id)}" data-color="${escapeHtml(note.color || 'default')}">
      <div class="note-card-header">
        <h3 class="note-card-title">${titleHtml || '<span style="color:var(--text-muted);font-weight:400">Untitled</span>'}</h3>
        <button
          type="button"
          class="icon-btn pin-btn note-card-pin ${note.pinned ? 'active' : ''}"
          data-toggle-pin="${escapeHtml(note.id)}"
          title="${note.pinned ? 'Unpin note' : 'Pin note'}"
          aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 17v5"></path>
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>
          </svg>
        </button>
      </div>

      ${descHtml ? `<div class="note-card-desc">${descHtml}</div>` : ''}

      ${tagsHtml ? `<div class="note-tags-row">${tagsHtml}</div>` : ''}

      <div class="note-card-footer">
        <span class="note-card-date">Edited ${formatTimestamp(note.updatedAt)}</span>
        <button
          type="button"
          class="icon-btn danger-btn"
          data-delete-note="${escapeHtml(note.id)}"
          title="Delete note"
          aria-label="Delete note"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </article>
  `;
}

function renderNotes(): void {
  const filtered = getFilteredNotes();
  const pinnedNotes = filtered.filter((n) => n.pinned);
  const otherNotes = filtered.filter((n) => !n.pinned);

  if (filtered.length === 0) {
    els.pinnedSection.classList.add('hidden');
    els.othersSection.classList.add('hidden');
    els.emptyState.classList.remove('hidden');
    return;
  }

  els.emptyState.classList.add('hidden');

  if (pinnedNotes.length > 0) {
    els.pinnedSection.classList.remove('hidden');
    els.pinnedGrid.innerHTML = pinnedNotes.map(createNoteCardHtml).join('');
  } else {
    els.pinnedSection.classList.add('hidden');
    els.pinnedGrid.innerHTML = '';
  }

  if (otherNotes.length > 0) {
    els.othersSection.classList.remove('hidden');
    els.othersSectionLabel.classList.toggle('hidden', pinnedNotes.length === 0);
    els.othersGrid.innerHTML = otherNotes.map(createNoteCardHtml).join('');
  } else {
    els.othersSection.classList.add('hidden');
    els.othersGrid.innerHTML = '';
  }
}

function renderAll(): void {
  renderSidebar();
  renderFilterBanner();
  renderNotes();
  updateVaultInspectorUI();
  updateLastUpdatedUI();
}

// Composer Functions
function expandComposer(): void {
  if (state.composer.expanded) return;
  state.composer.expanded = true;
  els.composerHeader.classList.remove('hidden');
  els.composerFooter.classList.remove('hidden');
  if (
    state.activeFilter.type === 'tag' &&
    state.activeFilter.tag &&
    !state.composer.tags.includes(state.activeFilter.tag)
  ) {
    state.composer.tags.push(state.activeFilter.tag);
  }
  renderComposerTags();
}

function resetComposer(): void {
  state.composer = {
    expanded: false,
    pinned: false,
    color: 'default',
    tags: [],
  };
  els.composerTitle.value = '';
  els.composerDescription.value = '';
  els.composerDescription.style.height = 'auto';
  els.noteComposer.setAttribute('data-color', 'default');
  els.composerPinBtn.classList.remove('active');
  els.composerHeader.classList.add('hidden');
  els.composerFooter.classList.add('hidden');
  els.composerTagsRow.classList.add('hidden');
  els.composerTagPopover.classList.add('hidden');
  updateColorDots(els.composerColorPicker, 'default');
}

function renderComposerTags(): void {
  if (state.composer.tags.length === 0) {
    els.composerTagsRow.classList.add('hidden');
    els.composerTagsRow.innerHTML = '';
    return;
  }
  els.composerTagsRow.classList.remove('hidden');
  els.composerTagsRow.innerHTML = state.composer.tags
    .map(
      (t) => `
      <span class="tag-chip">
        #${escapeHtml(t)}
        <button type="button" class="tag-chip-remove" data-remove-composer-tag="${escapeHtml(t)}">&times;</button>
      </span>
    `
    )
    .join('');
}

async function saveComposerNote(): Promise<void> {
  const title = els.composerTitle.value.trim();
  const description = els.composerDescription.value.trim();
  if (!title && !description) {
    resetComposer();
    return;
  }

  const now = Date.now();
  const newNote: Note = {
    id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    description,
    tags: [...state.composer.tags],
    pinned: state.composer.pinned,
    color: state.composer.color,
    createdAt: now,
    updatedAt: now,
  };

  state.notes.unshift(newNote);
  resetComposer();
  await persistEncryptedVault();
  renderAll();
}

function updateColorDots(pickerEl: HTMLElement, activeColor: NoteColor): void {
  pickerEl.querySelectorAll('.color-dot').forEach((dot) => {
    dot.classList.toggle('active', dot.getAttribute('data-color') === activeColor);
  });
}

// Tag Popover Helper
function renderTagPopoverOptions(
  optionsContainer: HTMLElement,
  searchValue: string,
  selectedTags: string[],
  onToggleTag: (tag: string) => void
): void {
  const q = searchValue.trim().toLowerCase().replace(/^#/, '');
  const matchingTags = state.tags.filter((t) => t.toLowerCase().includes(q));

  let html = matchingTags
    .map((tag) => {
      const checked = selectedTags.includes(tag) ? 'checked' : '';
      return `
        <label class="popover-option">
          <input type="checkbox" value="${escapeHtml(tag)}" ${checked} />
          <span>#${escapeHtml(tag)}</span>
        </label>
      `;
    })
    .join('');

  if (q && !state.tags.some((t) => t.toLowerCase() === q)) {
    html += `
      <div class="popover-option" data-create-tag="${escapeHtml(q)}" style="color:var(--accent);font-weight:600">
        + Create "#${escapeHtml(q)}"
      </div>
    `;
  }

  optionsContainer.innerHTML =
    html || '<div style="font-size:0.8rem;color:var(--text-muted);padding:4px;">No tags yet</div>';

  optionsContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      onToggleTag(cb.value);
    });
  });

  const createEl = optionsContainer.querySelector('[data-create-tag]');
  if (createEl) {
    createEl.addEventListener('click', () => {
      const newTag = createEl.getAttribute('data-create-tag');
      if (!newTag) return;
      if (!state.tags.includes(newTag)) {
        state.tags.push(newTag);
      }
      onToggleTag(newTag);
    });
  }
}

// Edit Note Modal
function openEditModal(noteId: string): void {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;

  state.editingNoteId = noteId;
  state.editingDraft = {
    title: note.title,
    description: note.description,
    pinned: note.pinned,
    color: note.color || 'default',
    tags: [...(note.tags || [])],
  };

  els.editModalTitle.value = state.editingDraft.title;
  els.editModalDescription.value = state.editingDraft.description;
  els.editModalCard.setAttribute('data-color', state.editingDraft.color);
  els.editModalPinBtn.classList.toggle('active', state.editingDraft.pinned);
  els.editModalTimestamp.textContent = `Edited ${formatTimestamp(note.updatedAt)}`;
  updateColorDots(els.editModalColorPicker, state.editingDraft.color);
  renderEditModalTags();

  els.editModalTagPopover.classList.add('hidden');
  els.editModalBackdrop.classList.remove('hidden');
  autoResizeTextarea(els.editModalDescription);
  els.editModalDescription.focus();
}

function renderEditModalTags(): void {
  if (!state.editingDraft) return;
  els.editModalTagsRow.innerHTML = state.editingDraft.tags
    .map(
      (t) => `
      <span class="tag-chip">
        #${escapeHtml(t)}
        <button type="button" class="tag-chip-remove" data-remove-modal-tag="${escapeHtml(t)}">&times;</button>
      </span>
    `
    )
    .join('');
}

async function saveAndCloseEditModal(): Promise<void> {
  if (!state.editingNoteId || !state.editingDraft) {
    els.editModalBackdrop.classList.add('hidden');
    return;
  }

  const idx = state.notes.findIndex((n) => n.id === state.editingNoteId);
  const existing = idx !== -1 ? state.notes[idx] : undefined;
  if (existing) {
    const newTitle = els.editModalTitle.value.trim();
    const newDesc = els.editModalDescription.value.trim();

    const changed =
      existing.title !== newTitle ||
      existing.description !== newDesc ||
      existing.pinned !== state.editingDraft.pinned ||
      existing.color !== state.editingDraft.color ||
      JSON.stringify(existing.tags) !== JSON.stringify(state.editingDraft.tags);

    if (changed) {
      state.notes[idx] = {
        ...existing,
        title: newTitle,
        description: newDesc,
        pinned: state.editingDraft.pinned,
        color: state.editingDraft.color,
        tags: [...state.editingDraft.tags],
        updatedAt: Date.now(),
      };
      await persistEncryptedVault();
    }
  }

  state.editingNoteId = null;
  state.editingDraft = null;
  els.editModalBackdrop.classList.add('hidden');
  renderAll();
}

// Cloud Onboarding Wizard Logic
function setWizardStep(stepNum: 1 | 2 | 3): void {
  document.querySelectorAll('[data-step-indicator]').forEach((el) => {
    const n = Number(el.getAttribute('data-step-indicator'));
    el.classList.toggle('active', n === stepNum);
  });

  els.wizardStep1.classList.toggle('hidden', stepNum !== 1);
  els.wizardStep2.classList.toggle('hidden', stepNum !== 2);
  els.wizardStep3.classList.toggle('hidden', stepNum !== 3);
  els.wizardStep2Error.classList.add('hidden');

  if (stepNum === 2) {
    const provider =
      CrypsyCloudSync.PROVIDERS[state.selectedProviderId] ?? CrypsyCloudSync.PROVIDERS.custom;
    els.selectedProviderTitle.textContent = `Typical ${provider.name} Location on Your OS:`;
    els.osPathHintCode.textContent = CrypsyCloudSync.getProviderPathHint(state.selectedProviderId);
    els.folderPickerHintText.textContent = provider.folderHint;
  }

  if (stepNum === 3) {
    const meta = CrypsyCloudSync.getSavedProviderMeta();
    if (meta) {
      els.connectedProviderHeading.textContent = `Connected to ${meta.providerName} (/${meta.folderName})`;
      els.connectedFolderDetails.textContent = `Your encrypted vault and portable app files are placed inside "${meta.parentFolderName}/${meta.folderName}".`;
    }
  }
}

function openCloudOnboardingModal(): void {
  const meta = CrypsyCloudSync.getSavedProviderMeta();
  if (CrypsyCloudSync.isConnected() && meta) {
    state.selectedProviderId = meta.providerId || 'onedrive';
    setWizardStep(3);
  } else {
    setWizardStep(1);
  }
  els.cloudOnboardingBackdrop.classList.remove('hidden');
}

function updateVaultInspectorUI(): void {
  if (!state.lastEncryptedEnvelope) return;
  els.ciphertextPreview.textContent = JSON.stringify(state.lastEncryptedEnvelope, null, 2);
}

// Event Listeners
function bindEvents(): void {
  // Sidebar toggle
  els.sidebarToggleBtn.addEventListener('click', () => {
    els.sidebar.classList.toggle('collapsed');
  });

  // Sidebar navigation (All / Pinned)
  document.querySelectorAll('.sidebar-nav > .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-filter-type');
      if (type === 'all' || type === 'pinned') {
        state.activeFilter = { type, tag: null };
        renderAll();
      }
    });
  });

  // Sidebar tags click & delete
  els.sidebarTagsList.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const deleteBtn = target.closest('[data-delete-tag]');
    if (deleteBtn) {
      e.stopPropagation();
      const tagToDelete = deleteBtn.getAttribute('data-delete-tag');
      if (!tagToDelete) return;
      state.tags = state.tags.filter((t) => t !== tagToDelete);
      state.notes.forEach((n) => {
        n.tags = (n.tags || []).filter((t) => t !== tagToDelete);
      });
      if (state.activeFilter.tag === tagToDelete) {
        state.activeFilter = { type: 'all', tag: null };
      }
      await persistEncryptedVault();
      renderAll();
      return;
    }

    const tagItem = target.closest('[data-tag]');
    if (tagItem) {
      const tag = tagItem.getAttribute('data-tag');
      if (!tag) return;
      state.activeFilter = { type: 'tag', tag };
      renderAll();
    }
  });

  // Create new tag in sidebar
  els.newTagForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = els.newTagInput.value.trim().toLowerCase().replace(/^#/, '');
    if (!raw) return;
    if (!state.tags.includes(raw)) {
      state.tags.push(raw);
      await persistEncryptedVault();
    }
    els.newTagInput.value = '';
    state.activeFilter = { type: 'tag', tag: raw };
    renderAll();
  });

  // Expand / collapse sidebar sections
  els.toggleTagsSectionBtn?.addEventListener('click', () => {
    state.tagsSectionExpanded = !state.tagsSectionExpanded;
    applySidebarSectionsUI();
    savePreferences();
  });

  els.toggleGuideSectionBtn?.addEventListener('click', () => {
    state.guideSectionExpanded = !state.guideSectionExpanded;
    applySidebarSectionsUI();
    savePreferences();
  });

  // Search input
  els.searchInput.addEventListener('input', () => {
    state.searchQuery = els.searchInput.value;
    els.clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
    renderFilterBanner();
    renderNotes();
  });

  els.clearSearchBtn.addEventListener('click', () => {
    state.searchQuery = '';
    els.searchInput.value = '';
    els.clearSearchBtn.classList.add('hidden');
    renderFilterBanner();
    renderNotes();
    els.searchInput.focus();
  });

  // Reset filter banner
  els.resetFilterBtn.addEventListener('click', () => {
    state.activeFilter = { type: 'all', tag: null } satisfies ActiveFilter;
    state.searchQuery = '';
    els.searchInput.value = '';
    els.clearSearchBtn.classList.add('hidden');
    renderAll();
  });

  // View toggle
  els.viewToggleBtn.addEventListener('click', () => {
    state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid';
    applyViewModeUI();
    savePreferences();
  });

  // Theme toggle
  els.themeToggleBtn.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyThemeUI();
    savePreferences();
  });

  // Cloud Setup & Reconnect Banner
  els.cloudSetupBtn.addEventListener('click', () => {
    openCloudOnboardingModal();
  });

  els.resumeCloudSyncBtn.addEventListener('click', async () => {
    const ok = await CrypsyCloudSync.reconnectSavedHandle();
    if (ok) {
      const existingCloudVault = await CrypsyCloudSync.readVaultFromCloudFolder();
      if (existingCloudVault) {
        await tryLoadEnvelope(existingCloudVault);
      } else {
        await persistEncryptedVault();
      }
      updateCloudStatusUI({ status: 'connected' });
    }
  });

  els.changeCloudFolderBtn.addEventListener('click', () => {
    setWizardStep(1);
    els.cloudOnboardingBackdrop.classList.remove('hidden');
  });

  // Cloud Onboarding Wizard events
  els.closeOnboardingBtn.addEventListener('click', () => {
    els.cloudOnboardingBackdrop.classList.add('hidden');
  });

  els.cloudOnboardingBackdrop.addEventListener('click', (e) => {
    if (e.target === els.cloudOnboardingBackdrop) {
      els.cloudOnboardingBackdrop.classList.add('hidden');
    }
  });

  els.providerSelectionGrid.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const card = target?.closest('[data-provider]');
    if (!card) return;
    const providerId = card.getAttribute('data-provider') as CloudProviderId | null;
    if (!providerId) return;
    state.selectedProviderId = providerId;
    els.providerSelectionGrid.querySelectorAll('.provider-card').forEach((c) => {
      c.classList.toggle('active', c === card);
    });
  });

  els.wizardToStep2Btn.addEventListener('click', () => {
    setWizardStep(2);
  });

  els.wizardBackToStep1Btn.addEventListener('click', () => {
    setWizardStep(1);
  });

  els.copyPathHintBtn.addEventListener('click', async () => {
    const rawPath = (els.osPathHintCode.textContent ?? '').split('   or   ')[0]?.trim() ?? '';
    try {
      await navigator.clipboard.writeText(rawPath);
      els.copyPathHintBtn.textContent = 'Copied!';
      setTimeout(() => {
        els.copyPathHintBtn.textContent = 'Copy Path';
      }, 1500);
    } catch {
      // ignore clipboard failure
    }
  });

  els.pickAndProvisionBtn.addEventListener('click', async () => {
    els.wizardStep2Error.classList.add('hidden');
    const createSub = els.createCrypsySubfolderCb.checked;
    const includeHtml = els.provisionPortableHtmlCb.checked;

    try {
      await CrypsyCloudSync.pickCloudFolder(state.selectedProviderId, createSub);

      // Check if an encrypted vault already exists in that cloud folder
      const existingEnvelope = await CrypsyCloudSync.readVaultFromCloudFolder();
      if (existingEnvelope) {
        await tryLoadEnvelope(existingEnvelope);
      } else {
        await persistEncryptedVault();
      }

      await CrypsyCloudSync.provisionCloudFolderAssets(includeHtml);
      updateCloudStatusUI({ status: 'connected' });
      setWizardStep(3);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      els.wizardStep2Error.textContent =
        err instanceof Error ? err.message : 'Could not link cloud folder.';
      els.wizardStep2Error.classList.remove('hidden');
    }
  });

  els.reprovisionAssetsBtn.addEventListener('click', async () => {
    try {
      await CrypsyCloudSync.provisionCloudFolderAssets(true);
      await persistEncryptedVault();
      els.reprovisionAssetsBtn.textContent = 'Files Updated!';
      setTimeout(() => {
        els.reprovisionAssetsBtn.textContent = 'Re-write Portable Files';
      }, 1600);
    } catch (e) {
      console.warn('Re-provision failed:', e);
    }
  });

  els.unlinkCloudFolderBtn.addEventListener('click', async () => {
    await CrypsyCloudSync.unlinkCloudFolder();
    updateCloudStatusUI({ status: 'unlinked' });
    setWizardStep(1);
  });

  els.finishOnboardingBtn.addEventListener('click', () => {
    els.cloudOnboardingBackdrop.classList.add('hidden');
  });

  els.downloadPortableBtn.addEventListener('click', async () => {
    const html = await CrypsyCloudSync.buildSelfContainedHtmlInBrowser();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Crypsy-Portable.html';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Composer expand & auto-resize
  els.composerDescription.addEventListener('focus', () => {
    expandComposer();
  });

  els.composerDescription.addEventListener('input', () => {
    autoResizeTextarea(els.composerDescription);
  });
  els.composerDescription.addEventListener('keydown', handleListEnterKeydown);

  els.composerPinBtn.addEventListener('click', () => {
    state.composer.pinned = !state.composer.pinned;
    els.composerPinBtn.classList.toggle('active', state.composer.pinned);
  });

  els.composerColorPicker.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const dot = target?.closest('.color-dot');
    if (!dot) return;
    const color = (dot.getAttribute('data-color') ?? 'default') as NoteColor;
    state.composer.color = color;
    els.noteComposer.setAttribute('data-color', color);
    updateColorDots(els.composerColorPicker, color);
  });

  // Composer Tag Popover
  const toggleComposerTag = (tag: string): void => {
    if (state.composer.tags.includes(tag)) {
      state.composer.tags = state.composer.tags.filter((t) => t !== tag);
    } else {
      state.composer.tags.push(tag);
    }
    renderComposerTags();
    renderSidebar();
    renderTagPopoverOptions(
      els.composerTagOptions,
      els.composerTagSearch.value,
      state.composer.tags,
      toggleComposerTag
    );
  };

  els.composerTagBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = els.composerTagPopover.classList.contains('hidden');
    if (isHidden) {
      els.composerTagSearch.value = '';
      renderTagPopoverOptions(
        els.composerTagOptions,
        '',
        state.composer.tags,
        toggleComposerTag
      );
      els.composerTagPopover.classList.remove('hidden');
      els.composerTagSearch.focus();
    } else {
      els.composerTagPopover.classList.add('hidden');
    }
  });

  els.composerTagSearch.addEventListener('input', () => {
    renderTagPopoverOptions(
      els.composerTagOptions,
      els.composerTagSearch.value,
      state.composer.tags,
      toggleComposerTag
    );
  });

  els.composerTagsRow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const rmBtn = target?.closest('[data-remove-composer-tag]');
    if (!rmBtn) return;
    const tag = rmBtn.getAttribute('data-remove-composer-tag');
    if (!tag) return;
    state.composer.tags = state.composer.tags.filter((t) => t !== tag);
    renderComposerTags();
  });

  els.composerSaveBtn.addEventListener('click', () => {
    void saveComposerNote();
  });

  els.composerCancelBtn.addEventListener('click', () => {
    resetComposer();
  });

  // Click outside composer to auto-save
  document.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (state.composer.expanded && target && !els.noteComposer.contains(target)) {
      void saveComposerNote();
    }
    if (
      target &&
      !els.composerTagPopover.contains(target) &&
      target !== els.composerTagBtn
    ) {
      els.composerTagPopover.classList.add('hidden');
    }
    if (
      target &&
      !els.editModalTagPopover.contains(target) &&
      target !== els.editModalTagBtn
    ) {
      els.editModalTagPopover.classList.add('hidden');
    }
  });

  // Card interactions
  els.notesWorkspace.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const checkbox = target.closest('[data-toggle-checkbox]');
    if (checkbox) {
      e.stopPropagation();
      const noteId = checkbox.getAttribute('data-toggle-checkbox');
      const lineIndexRaw = checkbox.getAttribute('data-line-index');
      if (noteId && lineIndexRaw !== null) {
        await toggleNoteCheckbox(noteId, parseInt(lineIndexRaw, 10));
      }
      return;
    }

    const pinBtn = target.closest('[data-toggle-pin]');
    if (pinBtn) {
      e.stopPropagation();
      const id = pinBtn.getAttribute('data-toggle-pin');
      const note = state.notes.find((n) => n.id === id);
      if (note) {
        note.pinned = !note.pinned;
        note.updatedAt = Date.now();
        await persistEncryptedVault();
        renderAll();
      }
      return;
    }

    const deleteBtn = target.closest('[data-delete-note]');
    if (deleteBtn) {
      e.stopPropagation();
      const id = deleteBtn.getAttribute('data-delete-note');
      state.notes = state.notes.filter((n) => n.id !== id);
      await persistEncryptedVault();
      renderAll();
      return;
    }

    const tagChip = target.closest('[data-filter-tag]');
    if (tagChip) {
      e.stopPropagation();
      const tag = tagChip.getAttribute('data-filter-tag');
      if (tag) {
        state.activeFilter = { type: 'tag', tag };
        renderAll();
      }
      return;
    }

    const card = target.closest('.note-card');
    if (card) {
      const noteId = card.getAttribute('data-note-id');
      if (noteId) {
        openEditModal(noteId);
      }
    }
  });

  // Edit Modal interactions
  els.editModalDescription.addEventListener('input', () => {
    autoResizeTextarea(els.editModalDescription);
  });
  els.editModalDescription.addEventListener('keydown', handleListEnterKeydown);

  els.editModalPinBtn.addEventListener('click', () => {
    if (!state.editingDraft) return;
    state.editingDraft.pinned = !state.editingDraft.pinned;
    els.editModalPinBtn.classList.toggle('active', state.editingDraft.pinned);
  });

  els.editModalColorPicker.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const dot = target?.closest('.color-dot');
    if (!dot || !state.editingDraft) return;
    const color = (dot.getAttribute('data-color') ?? 'default') as NoteColor;
    state.editingDraft.color = color;
    els.editModalCard.setAttribute('data-color', color);
    updateColorDots(els.editModalColorPicker, color);
  });

  const toggleModalTag = (tag: string): void => {
    if (!state.editingDraft) return;
    if (state.editingDraft.tags.includes(tag)) {
      state.editingDraft.tags = state.editingDraft.tags.filter((t) => t !== tag);
    } else {
      state.editingDraft.tags.push(tag);
    }
    renderEditModalTags();
    renderSidebar();
    renderTagPopoverOptions(
      els.editModalTagOptions,
      els.editModalTagSearch.value,
      state.editingDraft.tags,
      toggleModalTag
    );
  };

  els.editModalTagBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.editingDraft) return;
    const isHidden = els.editModalTagPopover.classList.contains('hidden');
    if (isHidden) {
      els.editModalTagSearch.value = '';
      renderTagPopoverOptions(
        els.editModalTagOptions,
        '',
        state.editingDraft.tags,
        toggleModalTag
      );
      els.editModalTagPopover.classList.remove('hidden');
      els.editModalTagSearch.focus();
    } else {
      els.editModalTagPopover.classList.add('hidden');
    }
  });

  els.editModalTagSearch.addEventListener('input', () => {
    if (!state.editingDraft) return;
    renderTagPopoverOptions(
      els.editModalTagOptions,
      els.editModalTagSearch.value,
      state.editingDraft.tags,
      toggleModalTag
    );
  });

  els.editModalTagsRow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const rmBtn = target?.closest('[data-remove-modal-tag]');
    if (!rmBtn || !state.editingDraft) return;
    const tag = rmBtn.getAttribute('data-remove-modal-tag');
    if (!tag) return;
    state.editingDraft.tags = state.editingDraft.tags.filter((t) => t !== tag);
    renderEditModalTags();
  });

  els.editModalDeleteBtn.addEventListener('click', async () => {
    if (!state.editingNoteId) return;
    state.notes = state.notes.filter((n) => n.id !== state.editingNoteId);
    state.editingNoteId = null;
    state.editingDraft = null;
    els.editModalBackdrop.classList.add('hidden');
    await persistEncryptedVault();
    renderAll();
  });

  els.editModalSaveBtn.addEventListener('click', () => {
    void saveAndCloseEditModal();
  });

  els.editModalBackdrop.addEventListener('click', (e) => {
    if (e.target === els.editModalBackdrop) {
      void saveAndCloseEditModal();
    }
  });

  // Vault Inspector Modal
  const openVaultModal = (): void => {
    updateVaultInspectorUI();
    els.vaultModalBackdrop.classList.remove('hidden');
  };
  els.encryptionBadge.addEventListener('click', openVaultModal);

  els.closeVaultModalBtn.addEventListener('click', () => {
    els.vaultModalBackdrop.classList.add('hidden');
  });

  els.vaultModalBackdrop.addEventListener('click', (e) => {
    if (e.target === els.vaultModalBackdrop) {
      els.vaultModalBackdrop.classList.add('hidden');
    }
  });

  els.updatePassphraseBtn.addEventListener('click', async () => {
    const nextPass = els.vaultPassphraseInput.value.trim();
    if (!nextPass) return;
    state.passphrase = nextPass;
    els.vaultPassphraseInput.value = '';
    await persistEncryptedVault();
  });

  els.lockVaultNowBtn.addEventListener('click', () => {
    els.vaultModalBackdrop.classList.add('hidden');
    els.unlockErrorMsg.classList.add('hidden');
    els.unlockPassphraseInput.value = '';
    els.lockScreenOverlay.classList.remove('hidden');
    els.unlockPassphraseInput.focus();
  });

  els.unlockVaultForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const attempt = els.unlockPassphraseInput.value;
    try {
      const storedRaw = localStorage.getItem(STORAGE_KEY_VAULT);
      if (!storedRaw) throw new Error('No vault found');
      const envelope = JSON.parse(storedRaw) as EncryptedEnvelope;
      const decrypted = await CrypsyCrypto.decryptPayload(envelope, attempt);
      state.passphrase = attempt;
      state.notes = decrypted.notes || [];
      state.tags = decrypted.tags || [];
      els.lockScreenOverlay.classList.add('hidden');
      els.unlockErrorMsg.classList.add('hidden');
      renderAll();
    } catch {
      els.unlockErrorMsg.classList.remove('hidden');
    }
  });

  els.exportEncryptedBtn.addEventListener('click', () => {
    if (!state.lastEncryptedEnvelope) return;
    const blob = new Blob([JSON.stringify(state.lastEncryptedEnvelope, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crypsy-vault-${new Date().toISOString().slice(0, 10)}.crypsy.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  els.importEncryptedInput.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const envelope = JSON.parse(text) as EncryptedEnvelope;
      const ok = await tryLoadEnvelope(envelope);
      if (ok && CrypsyCloudSync.isConnected()) {
        await CrypsyCloudSync.writeVaultToCloudFolder(envelope);
      }
      els.vaultModalBackdrop.classList.add('hidden');
    } catch {
      alert('Invalid .crypsy vault file.');
    } finally {
      els.importEncryptedInput.value = '';
    }
  });

  // Updates Modal
  const openUpdatesModal = (): void => {
    if (els.autoCheckUpdatesCb) {
      els.autoCheckUpdatesCb.checked = state.autoCheckUpdates;
    }
    if (els.installedVersionLabel) {
      els.installedVersionLabel.textContent = `v${APP_VERSION}`;
    }
    els.updatesModalBackdrop?.classList.remove('hidden');
  };
  if (els.appVersionBadge) {
    els.appVersionBadge.addEventListener('click', openUpdatesModal);
  }
  if (els.topbarUpdatesBtn) {
    els.topbarUpdatesBtn.addEventListener('click', openUpdatesModal);
  }
  if (els.closeUpdatesModalBtn) {
    els.closeUpdatesModalBtn.addEventListener('click', () => {
      els.updatesModalBackdrop?.classList.add('hidden');
    });
  }
  if (els.updatesModalBackdrop) {
    els.updatesModalBackdrop.addEventListener('click', (e) => {
      if (e.target === els.updatesModalBackdrop) {
        els.updatesModalBackdrop?.classList.add('hidden');
      }
    });
  }
  if (els.autoCheckUpdatesCb) {
    els.autoCheckUpdatesCb.addEventListener('change', () => {
      if (!els.autoCheckUpdatesCb) return;
      state.autoCheckUpdates = els.autoCheckUpdatesCb.checked;
      savePreferences();
      if (state.autoCheckUpdates) {
        void checkForUpdates(false);
      }
    });
  }
  if (els.checkUpdatesNowBtn) {
    els.checkUpdatesNowBtn.addEventListener('click', () => {
      void checkForUpdates(false);
    });
  }

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.editModalBackdrop.classList.contains('hidden')) {
        void saveAndCloseEditModal();
      } else if (!els.cloudOnboardingBackdrop.classList.contains('hidden')) {
        els.cloudOnboardingBackdrop.classList.add('hidden');
      } else if (!els.vaultModalBackdrop.classList.contains('hidden')) {
        els.vaultModalBackdrop.classList.add('hidden');
      } else if (
        els.updatesModalBackdrop &&
        !els.updatesModalBackdrop.classList.contains('hidden')
      ) {
        els.updatesModalBackdrop.classList.add('hidden');
      } else if (state.composer.expanded) {
        void saveComposerNote();
      }
    }

    const tag = document.activeElement ? document.activeElement.tagName : '';
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA';
    if (
      (e.key === '/' && !isTyping) ||
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')
    ) {
      e.preventDefault();
      els.searchInput.focus();
    }
  });
}

// Boot
bindEvents();
void initVault();
