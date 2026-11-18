/**
 * Crypsy — Main Application Logic
 * Implements Card-Grid Notes + Spatial Boards UX + Cloud Folder Onboarding & Live File Sync:
 * - Search (title, description, tags) with live highlight
 * - Tags (create, filter, assign/remove per note)
 * - Pins (PINNED vs OTHERS sections)
 * - Card (Grid) / List view toggle
 * - Note Title & Description with color themes
 * - Transparent client-side AES-256-GCM encryption
 * - Cloud Folder Provisioning Wizard & Live Auto-Sync (`vault.crypsy.json`)
 */

import { BoardEditorController } from './board-editor';
import { CrypsyCloudSync } from './cloud-sync';
import { ContextMenuController, shouldBypassCustomContextMenu } from './context-menu';
import { CrypsyCrypto } from './crypto';
import {
  extractClipboardImages,
  extractImageUrlFromClipboardHtml,
  extractStandaloneImageUrl,
  noteImageFromFile,
  noteImageFromUrl,
} from './media';
import type {
  ActiveFilter,
  AppState,
  Board,
  CloudProviderId,
  EncryptedEnvelope,
  Note,
  NoteColor,
  NoteImage,
  RestoreConnectionResult,
  VaultPayload,
} from './types';
import {
  APP_VERSION,
  autoResizeTextarea,
  byId,
  escapeHtml,
  formatRelativeTime,
  formatTimestamp,
  getRotatedRectAabb,
  highlightText,
  isEditableElement,
  maybeById,
  renderBoardItemHtml,
} from './utils';

const STORAGE_KEY_VAULT = 'crypsy_encrypted_vault_v1';
const STORAGE_KEY_PREFS = 'crypsy_ui_prefs_v1';
const VAULT_IDB_NAME = 'crypsy_vault_cache_db_v1';
const VAULT_IDB_STORE = 'vault';
const VAULT_IDB_KEY = 'encrypted_envelope';
const DEFAULT_DEVICE_SECRET = 'crypsy-local-device-default-key-v1';

window.CRYPSY_VERSION = APP_VERSION;

// Application State
const state: AppState = {
  notes: [],
  boards: [],
  tags: ['security', 'ideas', 'work', 'personal'],
  searchQuery: '',
  activeFilter: { type: 'all', tag: null },
  viewMode: 'grid',
  theme: 'dark',
  boardsSectionExpanded: true,
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
    images: [],
  },
  editingNoteId: null,
  editingDraft: null,
  activeBoardId: null,
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

// DOM Elements
const els = {
  sidebar: byId('sidebar'),
  sidebarToggleBtn: byId<HTMLButtonElement>('sidebarToggleBtn'),
  toggleBoardsSectionBtn: maybeById<HTMLButtonElement>('toggleBoardsSectionBtn'),
  sidebarBoardsContent: maybeById('sidebarBoardsContent'),
  sidebarBoardsList: maybeById('sidebarBoardsList'),
  newBoardForm: maybeById<HTMLFormElement>('newBoardForm'),
  newBoardInput: maybeById<HTMLInputElement>('newBoardInput'),
  toggleTagsSectionBtn: maybeById<HTMLButtonElement>('toggleTagsSectionBtn'),
  sidebarTagsContent: maybeById('sidebarTagsContent'),
  sidebarTagsList: byId('sidebarTagsList'),
  newTagForm: byId<HTMLFormElement>('newTagForm'),
  newTagInput: byId<HTMLInputElement>('newTagInput'),
  toggleGuideSectionBtn: maybeById<HTMLButtonElement>('toggleGuideSectionBtn'),
  sidebarGuideContent: maybeById('sidebarGuideContent'),
  countAll: byId('countAll'),
  countPinned: byId('countPinned'),
  countBoards: maybeById('countBoards'),
  boardsActionBar: maybeById('boardsActionBar'),
  createBoardHeroBtn: maybeById<HTMLButtonElement>('createBoardHeroBtn'),
  composerWrapper: maybeById('composerWrapper'),

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
  composerImagesRow: maybeById('composerImagesRow'),
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
  composerImageBtn: maybeById<HTMLButtonElement>('composerImageBtn'),
  composerImagePopover: maybeById('composerImagePopover'),
  composerUploadImageBtn: maybeById<HTMLButtonElement>('composerUploadImageBtn'),
  composerImageFileInput: maybeById<HTMLInputElement>('composerImageFileInput'),
  composerImageUrlInput: maybeById<HTMLInputElement>('composerImageUrlInput'),
  composerAddImageUrlBtn: maybeById<HTMLButtonElement>('composerAddImageUrlBtn'),
  composerImageStatus: maybeById('composerImageStatus'),
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
  emptyStateTitle: maybeById('emptyStateTitle'),
  emptyStateSubtitle: maybeById('emptyStateSubtitle'),

  editModalBackdrop: byId('editModalBackdrop'),
  editModalCard: byId('editModalCard'),
  editModalImagesRow: maybeById('editModalImagesRow'),
  editModalTitle: byId<HTMLInputElement>('editModalTitle'),
  editModalDescription: byId<HTMLTextAreaElement>('editModalDescription'),
  editModalPinBtn: byId<HTMLButtonElement>('editModalPinBtn'),
  editModalTagsRow: byId('editModalTagsRow'),
  editModalTimestamp: byId('editModalTimestamp'),
  editModalTagBtn: byId<HTMLButtonElement>('editModalTagBtn'),
  editModalTagPopover: byId('editModalTagPopover'),
  editModalTagSearch: byId<HTMLInputElement>('editModalTagSearch'),
  editModalTagOptions: byId('editModalTagOptions'),
  editModalImageBtn: maybeById<HTMLButtonElement>('editModalImageBtn'),
  editModalImagePopover: maybeById('editModalImagePopover'),
  editModalUploadImageBtn: maybeById<HTMLButtonElement>('editModalUploadImageBtn'),
  editModalImageFileInput: maybeById<HTMLInputElement>('editModalImageFileInput'),
  editModalImageUrlInput: maybeById<HTMLInputElement>('editModalImageUrlInput'),
  editModalAddImageUrlBtn: maybeById<HTMLButtonElement>('editModalAddImageUrlBtn'),
  editModalImageStatus: maybeById('editModalImageStatus'),
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

  imageLightboxBackdrop: maybeById('imageLightboxBackdrop'),
  closeLightboxBtn: maybeById<HTMLButtonElement>('closeLightboxBtn'),
  lightboxImage: maybeById<HTMLImageElement>('lightboxImage'),
};

// List continuation helper
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
  boardsSectionExpanded?: unknown;
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
    if (typeof prefs.boardsSectionExpanded === 'boolean') {
      state.boardsSectionExpanded = prefs.boardsSectionExpanded;
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
      boardsSectionExpanded: state.boardsSectionExpanded,
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
let boardPersistTimer: number | null = null;

function openVaultCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(VAULT_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_IDB_STORE)) {
        db.createObjectStore(VAULT_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveVaultEnvelopeToCache(envelope: EncryptedEnvelope): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY_VAULT, JSON.stringify(envelope));
  } catch {
    // QuotaExceededError when vault has large images; IndexedDB stores full envelope below
  }
  try {
    const db = await openVaultCacheDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VAULT_IDB_STORE, 'readwrite');
      tx.objectStore(VAULT_IDB_STORE).put(envelope, VAULT_IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore IDB failure if localStorage succeeded
  }
}

async function loadVaultEnvelopeFromCache(): Promise<EncryptedEnvelope | null> {
  try {
    const db = await openVaultCacheDB();
    const fromIdb = await new Promise<EncryptedEnvelope | null>((resolve, reject) => {
      const tx = db.transaction(VAULT_IDB_STORE, 'readonly');
      const req = tx.objectStore(VAULT_IDB_STORE).get(VAULT_IDB_KEY);
      req.onsuccess = () => resolve((req.result as EncryptedEnvelope | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (fromIdb) return fromIdb;
  } catch {
    // Fallback to localStorage
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_VAULT);
    return raw ? (JSON.parse(raw) as EncryptedEnvelope) : null;
  } catch {
    return null;
  }
}

function scheduleBoardPersist(immediate = false): void {
  if (boardPersistTimer !== null) {
    window.clearTimeout(boardPersistTimer);
    boardPersistTimer = null;
  }
  if (immediate) {
    void persistEncryptedVault();
    return;
  }
  boardPersistTimer = window.setTimeout(() => {
    boardPersistTimer = null;
    void persistEncryptedVault();
  }, 500);
}

function applyDecryptedPayload(decrypted: VaultPayload): void {
  state.notes = Array.isArray(decrypted.notes) ? decrypted.notes : [];
  state.tags = Array.isArray(decrypted.tags) ? decrypted.tags : [];
  state.boards = Array.isArray(decrypted.boards) ? decrypted.boards : [];
  if (state.activeBoardId && !state.boards.some((b) => b.id === state.activeBoardId)) {
    state.activeBoardId = null;
  }
}

async function persistEncryptedVault(): Promise<void> {
  if (boardPersistTimer !== null) {
    window.clearTimeout(boardPersistTimer);
    boardPersistTimer = null;
  }
  const payload: VaultPayload = {
    notes: state.notes,
    tags: state.tags,
    boards: state.boards,
  };
  const envelope = await CrypsyCrypto.encryptPayload(payload, state.passphrase);
  state.lastEncryptedEnvelope = envelope;
  await saveVaultEnvelopeToCache(envelope);

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
  await saveVaultEnvelopeToCache(envelope);
  try {
    const decrypted = await CrypsyCrypto.decryptPayload(envelope, state.passphrase);
    applyDecryptedPayload(decrypted);
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
    if (boardEditor.isGestureActive()) return;
    const loaded = await tryLoadEnvelope(externalEnvelope);
    if (loaded) {
      boardEditor.refreshFromExternal();
    }
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

  const cachedEnvelope = await loadVaultEnvelopeFromCache();
  if (!cachedEnvelope) {
    state.notes = SEED_NOTES;
    state.boards = [];
    await persistEncryptedVault();
    renderAll();
    return;
  }

  await tryLoadEnvelope(cachedEnvelope);
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
  const latestBoardMs = state.boards.reduce((max, b) => Math.max(max, b.updatedAt || 0), 0);

  const bestTimestamp = isConnected
    ? Math.max(fileModifiedMs || 0, syncedAtMs || 0, envelopeUpdatedMs || 0)
    : Math.max(envelopeUpdatedMs || 0, latestNoteMs || 0, latestBoardMs || 0);

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
  if (els.toggleBoardsSectionBtn && els.sidebarBoardsContent) {
    els.toggleBoardsSectionBtn.setAttribute('aria-expanded', String(state.boardsSectionExpanded));
    els.toggleBoardsSectionBtn.title = state.boardsSectionExpanded
      ? 'Collapse Boards'
      : 'Expand Boards';
    els.sidebarBoardsContent.classList.toggle('hidden', !state.boardsSectionExpanded);
  }
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

// Shared Custom Context Menu & Spatial Boards Controller
const contextMenu = new ContextMenuController();

const boardEditor = new BoardEditorController({
  getBoard: () => state.boards.find((b) => b.id === state.activeBoardId) ?? null,
  getSearchQuery: () => state.searchQuery,
  getAllTags: () => state.tags,
  contextMenu,
  isLocked: () => !els.lockScreenOverlay.classList.contains('hidden'),
  onAddTagToVault: (tag) => {
    const clean = tag.trim().toLowerCase().replace(/^#/, '');
    if (clean && !state.tags.includes(clean)) {
      state.tags.push(clean);
    }
  },
  renderTagPopoverOptions,
  updateColorDots,
  onBoardMutated: (board, immediate = false) => {
    board.updatedAt = Date.now();
    renderSidebar();
    renderNotes();
    updateLastUpdatedUI();
    scheduleBoardPersist(immediate);
  },
  onDeleteBoard: (boardId) => {
    void deleteBoard(boardId);
  },
  onCloseBoard: () => {
    if (boardPersistTimer !== null) {
      void persistEncryptedVault();
    }
    state.activeBoardId = null;
    renderAll();
  },
  onOpenLightbox: (src) => {
    openLightbox(src);
  },
});

async function createBoard(rawTitle?: string): Promise<void> {
  const now = Date.now();
  const trimmed = (rawTitle ?? '').trim();
  const initialTags =
    state.activeFilter.type === 'tag' && state.activeFilter.tag ? [state.activeFilter.tag] : [];
  const board: Board = {
    id: `board-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title: trimmed || `Untitled Board ${state.boards.length + 1}`,
    tags: initialTags,
    pinned: false,
    color: 'default',
    viewport: { panX: 0, panY: 0, zoom: 1 },
    items: [],
    createdAt: now,
    updatedAt: now,
  };
  state.boards.unshift(board);
  state.boardsSectionExpanded = true;
  state.activeFilter = { type: 'boards', tag: null };
  savePreferences();
  applySidebarSectionsUI();
  await persistEncryptedVault();
  openBoardEditor(board.id);
}

function openBoardEditor(boardId: string): void {
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return;
  state.activeBoardId = board.id;
  renderAll();
  boardEditor.open(board);
}

async function deleteBoard(boardId: string): Promise<void> {
  state.boards = state.boards.filter((b) => b.id !== boardId);
  if (state.activeBoardId === boardId) {
    state.activeBoardId = null;
    if (boardEditor.isOpen()) {
      boardEditor.close();
    }
  }
  await persistEncryptedVault();
  renderAll();
}

async function toggleNotePin(noteId: string): Promise<void> {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;
  note.pinned = !note.pinned;
  note.updatedAt = Date.now();
  await persistEncryptedVault();
  renderAll();
}

async function deleteNote(noteId: string): Promise<void> {
  state.notes = state.notes.filter((n) => n.id !== noteId);
  await persistEncryptedVault();
  renderAll();
}

async function duplicateNote(noteId: string): Promise<void> {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;
  const now = Date.now();
  const clone: Note = {
    id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title: note.title ? `${note.title} (Copy)` : 'Untitled (Copy)',
    description: note.description,
    images: note.images ? note.images.map((img) => ({ ...img })) : [],
    tags: [...(note.tags || [])],
    pinned: false,
    color: note.color,
    createdAt: now,
    updatedAt: now,
  };
  const idx = state.notes.findIndex((n) => n.id === noteId);
  state.notes.splice(idx >= 0 ? idx + 1 : 0, 0, clone);
  await persistEncryptedVault();
  renderAll();
}

async function setNoteColor(noteId: string, color: NoteColor): Promise<void> {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note || note.color === color) return;
  note.color = color;
  note.updatedAt = Date.now();
  await persistEncryptedVault();
  renderAll();
}

async function toggleBoardPin(boardId: string): Promise<void> {
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return;
  board.pinned = !board.pinned;
  board.updatedAt = Date.now();
  await persistEncryptedVault();
  renderAll();
}

async function duplicateBoard(boardId: string): Promise<void> {
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return;
  const now = Date.now();
  const clone: Board = {
    id: `board-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title: board.title ? `${board.title} (Copy)` : 'Untitled Board (Copy)',
    tags: [...(board.tags || [])],
    pinned: false,
    color: board.color,
    viewport: { ...board.viewport },
    items: board.items.map((item) => ({
      ...(JSON.parse(JSON.stringify(item)) as typeof item),
      id: `bi-${now}-${Math.random().toString(36).slice(2, 7)}`,
    })),
    createdAt: now,
    updatedAt: now,
  };
  const idx = state.boards.findIndex((b) => b.id === boardId);
  state.boards.splice(idx >= 0 ? idx + 1 : 0, 0, clone);
  await persistEncryptedVault();
  renderAll();
}

async function setBoardColor(boardId: string, color: NoteColor): Promise<void> {
  const board = state.boards.find((b) => b.id === boardId);
  if (!board || board.color === color) return;
  board.color = color;
  board.updatedAt = Date.now();
  await persistEncryptedVault();
  renderAll();
}

async function deleteTag(tagToDelete: string): Promise<void> {
  state.tags = state.tags.filter((t) => t !== tagToDelete);
  state.notes.forEach((n) => {
    n.tags = (n.tags || []).filter((t) => t !== tagToDelete);
  });
  state.boards.forEach((b) => {
    b.tags = (b.tags || []).filter((t) => t !== tagToDelete);
  });
  if (state.activeFilter.tag === tagToDelete) {
    state.activeFilter = { type: 'all', tag: null };
  }
  await persistEncryptedVault();
  renderAll();
}

async function renameTag(oldTag: string, rawNextTag: string): Promise<void> {
  const nextTag = rawNextTag.trim().toLowerCase().replace(/^#/, '');
  if (!nextTag || nextTag === oldTag) {
    renderSidebar();
    return;
  }

  if (state.tags.includes(nextTag)) {
    state.tags = state.tags.filter((t) => t !== oldTag);
  } else {
    state.tags = state.tags.map((t) => (t === oldTag ? nextTag : t));
  }

  const replaceTagList = (tags: string[] | undefined): string[] => {
    const out: string[] = [];
    for (const t of tags || []) {
      const mapped = t === oldTag ? nextTag : t;
      if (!out.includes(mapped)) out.push(mapped);
    }
    return out;
  };

  state.notes.forEach((n) => {
    n.tags = replaceTagList(n.tags);
  });
  state.boards.forEach((b) => {
    b.tags = replaceTagList(b.tags);
  });

  if (state.activeFilter.type === 'tag' && state.activeFilter.tag === oldTag) {
    state.activeFilter = { type: 'tag', tag: nextTag };
  }

  await persistEncryptedVault();
  renderAll();
}

function startInlineSidebarRename(
  rowEl: HTMLElement,
  initialValue: string,
  onCommit: (nextValue: string) => void | Promise<void>
): void {
  const labelSpan = rowEl.querySelector<HTMLElement>('.nav-label');
  if (!labelSpan) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sidebar-inline-rename-input';
  input.value = initialValue;
  labelSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const val = input.value;
    if (save) {
      void onCommit(val);
    } else {
      renderSidebar();
    }
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function openNoteContextMenu(clientX: number, clientY: number, note: Note): void {
  contextMenu.open(clientX, clientY, [
    {
      type: 'action',
      id: 'edit-note',
      label: 'Edit Note',
      onSelect: () => openEditModal(note.id),
    },
    {
      type: 'action',
      id: 'pin-note',
      label: note.pinned ? 'Unpin Note' : 'Pin Note',
      onSelect: () => toggleNotePin(note.id),
    },
    {
      type: 'action',
      id: 'dup-note',
      label: 'Duplicate Note',
      onSelect: () => duplicateNote(note.id),
    },
    {
      type: 'action',
      id: 'copy-note',
      label: 'Copy Note Text',
      onSelect: () => {
        const text = [note.title, note.description].filter(Boolean).join('\n\n');
        if (text && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).catch(() => {});
        }
      },
    },
    { type: 'divider' },
    {
      type: 'color-row',
      label: 'Tint',
      activeColor: note.color || 'default',
      onSelectColor: (c) => setNoteColor(note.id, c),
    },
    { type: 'divider' },
    {
      type: 'action',
      id: 'delete-note',
      label: 'Delete Note',
      danger: true,
      onSelect: () => deleteNote(note.id),
    },
  ]);
}

function openBoardContextMenu(
  clientX: number,
  clientY: number,
  board: Board,
  sidebarRowEl?: HTMLElement
): void {
  contextMenu.open(clientX, clientY, [
    {
      type: 'action',
      id: 'open-board',
      label: 'Open Board',
      onSelect: () => openBoardEditor(board.id),
    },
    ...(sidebarRowEl
      ? [
          {
            type: 'action' as const,
            id: 'rename-board',
            label: 'Rename Board...',
            onSelect: () =>
              startInlineSidebarRename(sidebarRowEl, board.title || 'Untitled Board', async (val) => {
                const nextTitle = val.trim();
                if (nextTitle && nextTitle !== board.title) {
                  board.title = nextTitle;
                  board.updatedAt = Date.now();
                  await persistEncryptedVault();
                  renderAll();
                  if (state.activeBoardId === board.id) {
                    boardEditor.refreshFromExternal();
                  }
                } else {
                  renderSidebar();
                }
              }),
          },
        ]
      : []),
    {
      type: 'action',
      id: 'pin-board',
      label: board.pinned ? 'Unpin Board' : 'Pin Board',
      onSelect: () => toggleBoardPin(board.id),
    },
    {
      type: 'action',
      id: 'dup-board',
      label: 'Duplicate Board',
      onSelect: () => duplicateBoard(board.id),
    },
    { type: 'divider' },
    {
      type: 'color-row',
      label: 'Theme',
      activeColor: board.color || 'default',
      onSelectColor: (c) => setBoardColor(board.id, c),
    },
    { type: 'divider' },
    {
      type: 'action',
      id: 'delete-board',
      label: 'Delete Board',
      danger: true,
      onSelect: () => deleteBoard(board.id),
    },
  ]);
}

// Filtering & Search
function getFilteredNotes(): Note[] {
  if (state.activeFilter.type === 'boards') return [];

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

function getFilteredBoards(): Board[] {
  const q = state.searchQuery.trim().toLowerCase();
  const cleanTagQuery = q.startsWith('#') ? q.slice(1) : q;

  // Keep default All Notes view Notes-only unless searching
  if (state.activeFilter.type === 'all' && !q) {
    return [];
  }

  return state.boards
    .filter((board) => {
      if (state.activeFilter.type === 'pinned' && !board.pinned) return false;
      if (
        state.activeFilter.type === 'tag' &&
        state.activeFilter.tag &&
        !(board.tags || []).includes(state.activeFilter.tag)
      ) {
        return false;
      }

      if (!q) return true;

      const titleMatch = (board.title || '').toLowerCase().includes(q);
      const tagMatch = (board.tags || []).some((t) => t.toLowerCase().includes(cleanTagQuery));
      const itemMatch = (board.items || []).some((item) => {
        if (item.type === 'text') return item.content.toLowerCase().includes(q);
        if (item.type === 'link') {
          return (
            item.url.toLowerCase().includes(q) ||
            (item.label || '').toLowerCase().includes(q) ||
            (item.description || '').toLowerCase().includes(q)
          );
        }
        if (item.type === 'image') return (item.image.alt || '').toLowerCase().includes(q);
        return false;
      });
      return titleMatch || tagMatch || itemMatch;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Render Functions
function renderSidebar(): void {
  els.countAll.textContent = String(state.notes.length);
  const pinnedCount =
    state.notes.filter((n) => n.pinned).length + state.boards.filter((b) => b.pinned).length;
  els.countPinned.textContent = String(pinnedCount);
  if (els.countBoards) {
    els.countBoards.textContent = String(state.boards.length);
  }

  document.querySelectorAll('.sidebar-nav .nav-item[data-filter-type]').forEach((btn) => {
    const filterType = btn.getAttribute('data-filter-type');
    const isActive =
      state.activeFilter.type === filterType &&
      !state.activeFilter.tag &&
      !(filterType === 'boards' && state.activeBoardId);
    btn.classList.toggle('active', isActive);
  });

  if (els.sidebarBoardsList) {
    const sortedBoards = [...state.boards].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    els.sidebarBoardsList.innerHTML = sortedBoards
      .map((board) => {
        const isActive = state.activeBoardId === board.id;
        return `
          <div class="nav-item sidebar-board-item ${isActive ? 'active' : ''}" data-open-board="${escapeHtml(board.id)}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="3" y="3" width="8" height="8" rx="1.5"></rect>
              <rect x="13" y="3" width="8" height="5" rx="1.5"></rect>
              <rect x="13" y="10" width="8" height="11" rx="1.5"></rect>
              <rect x="3" y="13" width="8" height="8" rx="1.5"></rect>
            </svg>
            <span class="nav-label">${escapeHtml(board.title || 'Untitled Board')}</span>
            <span class="nav-count">${board.items.length}</span>
            <button type="button" class="tag-delete-btn" data-delete-board="${escapeHtml(board.id)}" title="Delete board">&times;</button>
          </div>
        `;
      })
      .join('');
  }

  els.sidebarTagsList.innerHTML = state.tags
    .map((tag) => {
      const count =
        state.notes.filter((n) => n.tags.includes(tag)).length +
        state.boards.filter((b) => (b.tags || []).includes(tag)).length;
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
  const isBoardsView = state.activeFilter.type === 'boards';
  if (els.boardsActionBar) {
    els.boardsActionBar.classList.toggle('hidden', !isBoardsView);
  }
  if (els.composerWrapper) {
    els.composerWrapper.classList.toggle('hidden', isBoardsView);
  }

  const parts: string[] = [];
  if (state.activeFilter.type === 'pinned') {
    parts.push('Filtered by: <strong>Pinned</strong>');
  } else if (isBoardsView && state.searchQuery.trim()) {
    parts.push('Scope: <strong>Boards</strong>');
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
    const imgMatch = rawLine
      .trim()
      .match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)$/i);
    if (imgMatch && imgMatch[2]) {
      const altText = imgMatch[1] ?? '';
      const imgSrc = imgMatch[2];
      out.push(
        `<img class="md-inline-image" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(altText || 'Inline note image')}" data-lightbox-src="${escapeHtml(imgSrc)}" referrerpolicy="no-referrer" loading="lazy" />`
      );
      return;
    }
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
  const images = Array.isArray(note.images) ? note.images : [];
  const imagesHtml =
    images.length > 0
      ? `<div class="note-card-images ${images.length === 1 ? 'single-image' : ''}">` +
        images
          .map(
            (img) => `
            <div class="note-image-item">
              <img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt || 'Note image')}" data-lightbox-src="${escapeHtml(img.src)}" referrerpolicy="no-referrer" loading="lazy" />
              <span class="note-image-badge">${img.sourceType === 'external' ? 'External URL' : 'Encrypted WebP'}</span>
            </div>
          `
          )
          .join('') +
        `</div>`
      : '';

  const tagsHtml = (note.tags || [])
    .map(
      (tag) =>
        `<span class="tag-chip" data-filter-tag="${escapeHtml(tag)}" title="Filter by #${escapeHtml(tag)}">#${highlightText(tag, q)}</span>`
    )
    .join('');

  return `
    <article class="note-card" data-note-id="${escapeHtml(note.id)}" data-color="${escapeHtml(note.color || 'default')}">
      ${imagesHtml}
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

function renderBoardMinimapHtml(board: Board): string {
  const colorAttr = escapeHtml(board.color || 'default');
  const items = Array.isArray(board.items) ? board.items : [];
  if (items.length === 0) {
    return `<div class="board-card-minimap" data-color="${colorAttr}"><div class="board-minimap-empty">Empty board canvas</div></div>`;
  }

  const q = state.searchQuery;
  const originX = items.reduce((m, it) => Math.min(m, it.x), Infinity);
  const originY = items.reduce((m, it) => Math.min(m, it.y), Infinity);
  const sorted = [...items].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  const itemsHtml = sorted
    .map((item) =>
      renderBoardItemHtml(item, q, {
        minimap: true,
        offsetX: originX,
        offsetY: originY,
      })
    )
    .join('');

  return `<div class="board-card-minimap" data-color="${colorAttr}"><div class="board-minimap-world">${itemsHtml}</div></div>`;
}

function fitBoardMinimaps(): void {
  document.querySelectorAll<HTMLElement>('.board-card-minimap').forEach((container) => {
    const world = container.querySelector<HTMLElement>('.board-minimap-world');
    if (!world) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;

    const itemEls = Array.from(world.children).filter((el): el is HTMLElement =>
      el.classList.contains('board-item')
    );
    if (itemEls.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of itemEls) {
      const w = el.offsetWidth || parseFloat(el.style.width) || 220;
      const h = el.offsetHeight || parseFloat(el.style.height) || 60;
      const x = el.offsetLeft;
      const y = el.offsetTop;
      const rot = parseFloat(el.getAttribute('data-rotation') || '0');
      const aabb = getRotatedRectAabb(x, y, w, h, rot);
      minX = Math.min(minX, aabb.minX);
      minY = Math.min(minY, aabb.minY);
      maxX = Math.max(maxX, aabb.maxX);
      maxY = Math.max(maxY, aabb.maxY);
    }

    const pad = 28;
    const boxMinX = minX - pad;
    const boxMinY = minY - pad;
    const boxW = Math.max(200, maxX - minX + pad * 2);
    const boxH = Math.max(100, maxY - minY + pad * 2);

    const scale = Math.min(cw / boxW, ch / boxH, 0.85);
    const tx = (cw - boxW * scale) / 2 - boxMinX * scale;
    const ty = (ch - boxH * scale) / 2 - boxMinY * scale;
    world.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
  });
}

function createBoardCardHtml(board: Board): string {
  const q = state.searchQuery;
  const titleHtml = board.title ? highlightText(board.title, q) : '';
  const tagsHtml = (board.tags || [])
    .map(
      (tag) =>
        `<span class="tag-chip" data-filter-tag="${escapeHtml(tag)}" title="Filter by #${escapeHtml(tag)}">#${highlightText(tag, q)}</span>`
    )
    .join('');

  const itemCount = board.items.length;

  return `
    <article class="note-card board-card" data-board-id="${escapeHtml(board.id)}" data-color="${escapeHtml(board.color || 'default')}">
      ${renderBoardMinimapHtml(board)}
      <div class="note-card-header">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
          <h3 class="note-card-title">${titleHtml || '<span style="color:var(--text-muted);font-weight:400">Untitled Board</span>'}</h3>
          <span class="board-card-badge">Board</span>
        </div>
        <button
          type="button"
          class="icon-btn pin-btn note-card-pin ${board.pinned ? 'active' : ''}"
          data-toggle-board-pin="${escapeHtml(board.id)}"
          title="${board.pinned ? 'Unpin board' : 'Pin board'}"
          aria-label="${board.pinned ? 'Unpin board' : 'Pin board'}"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 17v5"></path>
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>
          </svg>
        </button>
      </div>

      ${tagsHtml ? `<div class="note-tags-row">${tagsHtml}</div>` : ''}

      <div class="note-card-footer">
        <span class="note-card-date">${itemCount} item${itemCount === 1 ? '' : 's'} &bull; Edited ${formatTimestamp(board.updatedAt)}</span>
        <button
          type="button"
          class="icon-btn danger-btn"
          data-delete-board="${escapeHtml(board.id)}"
          title="Delete board"
          aria-label="Delete board"
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

type WorkspaceCardEntry =
  | { kind: 'note'; item: Note; pinned: boolean; updatedAt: number }
  | { kind: 'board'; item: Board; pinned: boolean; updatedAt: number };

function renderWorkspaceCardHtml(entry: WorkspaceCardEntry): string {
  return entry.kind === 'board' ? createBoardCardHtml(entry.item) : createNoteCardHtml(entry.item);
}

function renderNotes(): void {
  const entries: WorkspaceCardEntry[] = [
    ...getFilteredNotes().map((item) => ({
      kind: 'note' as const,
      item,
      pinned: item.pinned,
      updatedAt: item.updatedAt,
    })),
    ...getFilteredBoards().map((item) => ({
      kind: 'board' as const,
      item,
      pinned: item.pinned,
      updatedAt: item.updatedAt,
    })),
  ].sort((a, b) => b.updatedAt - a.updatedAt);

  const pinnedEntries = entries.filter((e) => e.pinned);
  const otherEntries = entries.filter((e) => !e.pinned);

  if (entries.length === 0) {
    els.pinnedSection.classList.add('hidden');
    els.othersSection.classList.add('hidden');
    if (els.emptyStateTitle) {
      els.emptyStateTitle.textContent =
        state.activeFilter.type === 'boards' ? 'No encrypted boards yet' : 'No encrypted notes found';
    }
    if (els.emptyStateSubtitle) {
      els.emptyStateSubtitle.textContent =
        state.activeFilter.type === 'boards'
          ? 'Create a spatial board above or from the Boards menu in the sidebar.'
          : 'Create a note above or try adjusting your search or tag filter.';
    }
    els.emptyState.classList.remove('hidden');
    return;
  }

  els.emptyState.classList.add('hidden');

  if (pinnedEntries.length > 0) {
    els.pinnedSection.classList.remove('hidden');
    els.pinnedGrid.innerHTML = pinnedEntries.map(renderWorkspaceCardHtml).join('');
  } else {
    els.pinnedSection.classList.add('hidden');
    els.pinnedGrid.innerHTML = '';
  }

  if (otherEntries.length > 0) {
    els.othersSection.classList.remove('hidden');
    els.othersSectionLabel.classList.toggle('hidden', pinnedEntries.length === 0);
    els.othersGrid.innerHTML = otherEntries.map(renderWorkspaceCardHtml).join('');
  } else {
    els.othersSection.classList.add('hidden');
    els.othersGrid.innerHTML = '';
  }

  fitBoardMinimaps();
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
    images: [],
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
  els.composerImagePopover?.classList.add('hidden');
  if (els.composerImagesRow) {
    els.composerImagesRow.classList.add('hidden');
    els.composerImagesRow.innerHTML = '';
  }
  updateColorDots(els.composerColorPicker, 'default');
}

function renderComposerImages(): void {
  if (!els.composerImagesRow) return;
  if (state.composer.images.length === 0) {
    els.composerImagesRow.classList.add('hidden');
    els.composerImagesRow.innerHTML = '';
    return;
  }
  els.composerImagesRow.classList.remove('hidden');
  els.composerImagesRow.classList.toggle('single-image', state.composer.images.length === 1);
  els.composerImagesRow.innerHTML = state.composer.images
    .map(
      (img) => `
      <div class="note-edit-image-item">
        <img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt || 'Note image')}" data-lightbox-src="${escapeHtml(img.src)}" referrerpolicy="no-referrer" />
        <span class="note-image-badge">${img.sourceType === 'external' ? 'External URL' : 'Encrypted WebP'}</span>
        <button type="button" class="note-image-remove-btn" data-remove-composer-image="${escapeHtml(img.id)}" title="Remove image" aria-label="Remove image">&times;</button>
      </div>
    `
    )
    .join('');
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
  if (!title && !description && state.composer.images.length === 0) {
    resetComposer();
    return;
  }

  const now = Date.now();
  const newNote: Note = {
    id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    description,
    images: [...state.composer.images],
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
    images: [...(note.images || [])],
  };

  els.editModalTitle.value = state.editingDraft.title;
  els.editModalDescription.value = state.editingDraft.description;
  els.editModalCard.setAttribute('data-color', state.editingDraft.color);
  els.editModalPinBtn.classList.toggle('active', state.editingDraft.pinned);
  els.editModalTimestamp.textContent = `Edited ${formatTimestamp(note.updatedAt)}`;
  updateColorDots(els.editModalColorPicker, state.editingDraft.color);
  renderEditModalImages();
  renderEditModalTags();

  els.editModalTagPopover.classList.add('hidden');
  els.editModalImagePopover?.classList.add('hidden');
  els.editModalBackdrop.classList.remove('hidden');
  autoResizeTextarea(els.editModalDescription);
  els.editModalDescription.focus();
}

function renderEditModalImages(): void {
  if (!els.editModalImagesRow || !state.editingDraft) return;
  if (state.editingDraft.images.length === 0) {
    els.editModalImagesRow.classList.add('hidden');
    els.editModalImagesRow.innerHTML = '';
    return;
  }
  els.editModalImagesRow.classList.remove('hidden');
  els.editModalImagesRow.classList.toggle('single-image', state.editingDraft.images.length === 1);
  els.editModalImagesRow.innerHTML = state.editingDraft.images
    .map(
      (img) => `
      <div class="note-edit-image-item">
        <img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt || 'Note image')}" data-lightbox-src="${escapeHtml(img.src)}" referrerpolicy="no-referrer" />
        <span class="note-image-badge">${img.sourceType === 'external' ? 'External URL' : 'Encrypted WebP'}</span>
        <button type="button" class="note-image-remove-btn" data-remove-modal-image="${escapeHtml(img.id)}" title="Remove image" aria-label="Remove image">&times;</button>
      </div>
    `
    )
    .join('');
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
      JSON.stringify(existing.tags) !== JSON.stringify(state.editingDraft.tags) ||
      JSON.stringify(existing.images || []) !== JSON.stringify(state.editingDraft.images);

    if (changed) {
      state.notes[idx] = {
        ...existing,
        title: newTitle,
        description: newDesc,
        pinned: state.editingDraft.pinned,
        color: state.editingDraft.color,
        tags: [...state.editingDraft.tags],
        images: [...state.editingDraft.images],
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
  const env = state.lastEncryptedEnvelope;
  const displayEnvelope =
    env.ciphertext && env.ciphertext.length > 1200
      ? {
          ...env,
          ciphertext: `${env.ciphertext.slice(0, 600)}... [${env.ciphertext.length.toLocaleString()} base64 chars encrypted]`,
        }
      : env;
  els.ciphertextPreview.textContent = JSON.stringify(displayEnvelope, null, 2);
}

function openLightbox(src: string): void {
  if (!els.imageLightboxBackdrop || !els.lightboxImage || !src) return;
  els.lightboxImage.src = src;
  els.imageLightboxBackdrop.classList.remove('hidden');
}

function closeLightbox(): void {
  if (!els.imageLightboxBackdrop || !els.lightboxImage) return;
  els.imageLightboxBackdrop.classList.add('hidden');
  els.lightboxImage.src = '';
}

// Event Listeners
function bindEvents(): void {
  // Sidebar toggle
  els.sidebarToggleBtn.addEventListener('click', () => {
    els.sidebar.classList.toggle('collapsed');
    fitBoardMinimaps();
    window.setTimeout(fitBoardMinimaps, 220);
  });

  // Sidebar navigation (All / Pinned / Boards)
  document.querySelectorAll('.sidebar-nav .nav-item[data-filter-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-filter-type');
      if (type === 'all' || type === 'pinned' || type === 'boards') {
        state.activeFilter = { type, tag: null };
        if (boardEditor.isOpen()) {
          boardEditor.close();
          return;
        }
        renderAll();
      }
    });
  });

  // Sidebar Boards expand, list & creation
  els.toggleBoardsSectionBtn?.addEventListener('click', () => {
    state.boardsSectionExpanded = !state.boardsSectionExpanded;
    applySidebarSectionsUI();
    savePreferences();
  });

  els.newBoardForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = els.newBoardInput?.value ?? '';
    if (els.newBoardInput) els.newBoardInput.value = '';
    await createBoard(raw);
  });

  els.createBoardHeroBtn?.addEventListener('click', () => {
    void createBoard();
  });

  els.sidebarBoardsList?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const deleteBtn = target.closest('[data-delete-board]');
    if (deleteBtn) {
      e.stopPropagation();
      const boardId = deleteBtn.getAttribute('data-delete-board');
      if (boardId) {
        await deleteBoard(boardId);
      }
      return;
    }

    const boardItem = target.closest('[data-open-board]');
    if (boardItem) {
      const boardId = boardItem.getAttribute('data-open-board');
      if (boardId) {
        state.activeFilter = { type: 'boards', tag: null };
        openBoardEditor(boardId);
      }
    }
  });

  // Sidebar tags click & delete
  els.sidebarTagsList.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const deleteBtn = target.closest('[data-delete-tag]');
    if (deleteBtn) {
      e.stopPropagation();
      const tagToDelete = deleteBtn.getAttribute('data-delete-tag');
      if (tagToDelete) {
        await deleteTag(tagToDelete);
      }
      return;
    }

    const tagItem = target.closest('[data-tag]');
    if (tagItem) {
      const tag = tagItem.getAttribute('data-tag');
      if (!tag) return;
      state.activeFilter = { type: 'tag', tag };
      if (boardEditor.isOpen()) {
        boardEditor.close();
        return;
      }
      renderAll();
    }
  });

  els.sidebarBoardsList?.addEventListener('contextmenu', (e) => {
    if (shouldBypassCustomContextMenu(e, els.lockScreenOverlay)) return;
    const target = e.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-open-board]');
    if (!row) return;
    const boardId = row.getAttribute('data-open-board');
    const board = state.boards.find((b) => b.id === boardId);
    if (!board) return;
    e.preventDefault();
    openBoardContextMenu(e.clientX, e.clientY, board, row);
  });

  els.sidebarTagsList.addEventListener('contextmenu', (e) => {
    if (shouldBypassCustomContextMenu(e, els.lockScreenOverlay)) return;
    const target = e.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-tag]');
    if (!row) return;
    const tag = row.getAttribute('data-tag');
    if (!tag) return;
    e.preventDefault();
    contextMenu.open(e.clientX, e.clientY, [
      {
        type: 'action',
        id: 'filter-tag',
        label: `Filter by #${tag}`,
        onSelect: () => {
          state.activeFilter = { type: 'tag', tag };
          if (boardEditor.isOpen()) {
            boardEditor.close();
            return;
          }
          renderAll();
        },
      },
      {
        type: 'action',
        id: 'rename-tag',
        label: 'Rename Tag...',
        onSelect: () => startInlineSidebarRename(row, tag, (next) => renameTag(tag, next)),
      },
      { type: 'divider' },
      {
        type: 'action',
        id: 'delete-tag',
        label: `Delete #${tag}`,
        danger: true,
        onSelect: () => deleteTag(tag),
      },
    ]);
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
    fitBoardMinimaps();
    savePreferences();
  });

  window.addEventListener('resize', fitBoardMinimaps);
  els.notesWorkspace.addEventListener(
    'load',
    (e) => {
      if ((e.target as HTMLElement | null)?.closest('.board-card-minimap')) {
        fitBoardMinimaps();
      }
    },
    true
  );

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

      try {
        await CrypsyCloudSync.provisionCloudFolderAssets(includeHtml);
      } catch (assetErr) {
        if (includeHtml) {
          await CrypsyCloudSync.provisionCloudFolderAssets(false);
          console.warn('Could not bundle Crypsy-Portable.html in browser:', assetErr);
        } else {
          throw assetErr;
        }
      }
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
      alert(e instanceof Error ? e.message : 'Could not update Crypsy-Portable.html.');
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
    try {
      const html = await CrypsyCloudSync.buildSelfContainedHtmlInBrowser();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Crypsy-Portable.html';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not build Crypsy-Portable.html.');
    }
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

  // Image Attachment Helpers (Clipboard Paste, Drag & Drop, File Upload, URL Import)
  const attachImageToTarget = (targetMode: 'composer' | 'modal', img: NoteImage): void => {
    if (targetMode === 'modal' && state.editingDraft) {
      state.editingDraft.images.push(img);
      renderEditModalImages();
    } else {
      expandComposer();
      state.composer.images.push(img);
      renderComposerImages();
    }
  };

  const setPopoverImageStatus = (
    targetMode: 'composer' | 'modal',
    msg: string,
    isError = false
  ): void => {
    const statusEl = targetMode === 'modal' ? els.editModalImageStatus : els.composerImageStatus;
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
  };

  const handleImageFiles = async (
    targetMode: 'composer' | 'modal',
    files: Iterable<File>
  ): Promise<void> => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const noteImg = await noteImageFromFile(file);
        attachImageToTarget(targetMode, noteImg);
      } catch (err) {
        console.warn('Could not process image file:', err);
      }
    }
  };

  const handleClipboardPaste = async (
    e: ClipboardEvent,
    targetMode: 'composer' | 'modal'
  ): Promise<boolean> => {
    const cd = e.clipboardData;
    if (!cd) return false;

    const imageFiles = extractClipboardImages(cd);
    if (imageFiles.length > 0) {
      e.preventDefault();
      await handleImageFiles(targetMode, imageFiles);
      return true;
    }

    const plainText = cd.getData('text/plain');
    const extractedUrl = extractStandaloneImageUrl(plainText);
    if (extractedUrl) {
      e.preventDefault();
      try {
        const noteImg = await noteImageFromUrl(extractedUrl.url, extractedUrl.alt);
        attachImageToTarget(targetMode, noteImg);
        return true;
      } catch {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          const start = active.selectionStart ?? active.value.length;
          const end = active.selectionEnd ?? active.value.length;
          active.value = active.value.slice(0, start) + plainText + active.value.slice(end);
        }
        return false;
      }
    }

    if (!plainText.trim()) {
      const htmlData = cd.getData('text/html');
      const htmlImg = extractImageUrlFromClipboardHtml(htmlData);
      if (htmlImg) {
        e.preventDefault();
        try {
          const noteImg = await noteImageFromUrl(htmlImg.url, htmlImg.alt);
          attachImageToTarget(targetMode, noteImg);
          return true;
        } catch {
          return false;
        }
      }
    }

    return false;
  };

  // Composer Image Popover & Controls
  els.composerImageBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!els.composerImagePopover) return;
    const isHidden = els.composerImagePopover.classList.contains('hidden');
    els.composerTagPopover.classList.add('hidden');
    if (isHidden) {
      setPopoverImageStatus('composer', 'Tip: Paste images or URLs directly with Ctrl+V');
      els.composerImagePopover.classList.remove('hidden');
      els.composerImageUrlInput?.focus();
    } else {
      els.composerImagePopover.classList.add('hidden');
    }
  });

  els.composerUploadImageBtn?.addEventListener('click', () => {
    els.composerImageFileInput?.click();
  });

  els.composerImageFileInput?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      await handleImageFiles('composer', Array.from(input.files));
      els.composerImagePopover?.classList.add('hidden');
    }
    input.value = '';
  });

  const submitComposerImageUrl = async (): Promise<void> => {
    const raw = els.composerImageUrlInput?.value.trim() ?? '';
    if (!raw) return;
    setPopoverImageStatus('composer', 'Downloading & processing image...');
    try {
      const noteImg = await noteImageFromUrl(raw);
      attachImageToTarget('composer', noteImg);
      if (els.composerImageUrlInput) els.composerImageUrlInput.value = '';
      setPopoverImageStatus(
        'composer',
        noteImg.sourceType === 'embedded'
          ? 'Downloaded & encrypted as WebP!'
          : 'Linked external image (CORS restricted download).'
      );
      setTimeout(() => {
        els.composerImagePopover?.classList.add('hidden');
      }, 700);
    } catch (err) {
      setPopoverImageStatus(
        'composer',
        err instanceof Error ? err.message : 'Could not load image URL.',
        true
      );
    }
  };

  els.composerAddImageUrlBtn?.addEventListener('click', () => {
    void submitComposerImageUrl();
  });

  els.composerImageUrlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitComposerImageUrl();
    }
  });

  els.composerImagesRow?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const rmBtn = target.closest('[data-remove-composer-image]');
    if (rmBtn) {
      e.stopPropagation();
      const imgId = rmBtn.getAttribute('data-remove-composer-image');
      state.composer.images = state.composer.images.filter((img) => img.id !== imgId);
      renderComposerImages();
      return;
    }
    const lightImg = target.closest('[data-lightbox-src]');
    if (lightImg) {
      e.stopPropagation();
      openLightbox(lightImg.getAttribute('data-lightbox-src') ?? '');
    }
  });

  els.noteComposer.addEventListener('paste', (e) => {
    if (e.target === els.composerImageUrlInput) return;
    void handleClipboardPaste(e, 'composer');
  });

  els.noteComposer.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      els.noteComposer.classList.add('drag-over');
    }
  });

  els.noteComposer.addEventListener('dragleave', () => {
    els.noteComposer.classList.remove('drag-over');
  });

  els.noteComposer.addEventListener('drop', async (e) => {
    els.noteComposer.classList.remove('drag-over');
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      await handleImageFiles('composer', Array.from(e.dataTransfer.files));
    }
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
      els.composerImagePopover &&
      !els.composerImagePopover.contains(target) &&
      target !== els.composerImageBtn &&
      !els.composerImageBtn?.contains(target)
    ) {
      els.composerImagePopover.classList.add('hidden');
    }
    if (
      target &&
      !els.editModalTagPopover.contains(target) &&
      target !== els.editModalTagBtn
    ) {
      els.editModalTagPopover.classList.add('hidden');
    }
    if (
      target &&
      els.editModalImagePopover &&
      !els.editModalImagePopover.contains(target) &&
      target !== els.editModalImageBtn &&
      !els.editModalImageBtn?.contains(target)
    ) {
      els.editModalImagePopover.classList.add('hidden');
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

    const boardPinBtn = target.closest('[data-toggle-board-pin]');
    if (boardPinBtn) {
      e.stopPropagation();
      const id = boardPinBtn.getAttribute('data-toggle-board-pin');
      if (id) await toggleBoardPin(id);
      return;
    }

    const deleteBoardBtn = target.closest('[data-delete-board]');
    if (deleteBoardBtn) {
      e.stopPropagation();
      const id = deleteBoardBtn.getAttribute('data-delete-board');
      if (id) await deleteBoard(id);
      return;
    }

    const pinBtn = target.closest('[data-toggle-pin]');
    if (pinBtn) {
      e.stopPropagation();
      const id = pinBtn.getAttribute('data-toggle-pin');
      if (id) await toggleNotePin(id);
      return;
    }

    const deleteBtn = target.closest('[data-delete-note]');
    if (deleteBtn) {
      e.stopPropagation();
      const id = deleteBtn.getAttribute('data-delete-note');
      if (id) await deleteNote(id);
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

    const lightboxEl = target.closest('[data-lightbox-src]');
    if (lightboxEl) {
      e.stopPropagation();
      openLightbox(lightboxEl.getAttribute('data-lightbox-src') ?? '');
      return;
    }

    const card = target.closest('.note-card');
    if (card) {
      const boardId = card.getAttribute('data-board-id');
      if (boardId) {
        openBoardEditor(boardId);
        return;
      }
      const noteId = card.getAttribute('data-note-id');
      if (noteId) {
        openEditModal(noteId);
      }
    }
  });

  els.notesWorkspace.addEventListener('contextmenu', (e) => {
    if (shouldBypassCustomContextMenu(e, els.lockScreenOverlay)) return;
    const target = e.target as HTMLElement | null;
    const card = target?.closest('.note-card');
    if (!card) return;

    const boardId = card.getAttribute('data-board-id');
    if (boardId) {
      const board = state.boards.find((b) => b.id === boardId);
      if (!board) return;
      e.preventDefault();
      openBoardContextMenu(e.clientX, e.clientY, board);
      return;
    }

    const noteId = card.getAttribute('data-note-id');
    if (noteId) {
      const note = state.notes.find((n) => n.id === noteId);
      if (!note) return;
      e.preventDefault();
      openNoteContextMenu(e.clientX, e.clientY, note);
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

  // Edit Modal Image Popover & Controls
  els.editModalImageBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.editingDraft || !els.editModalImagePopover) return;
    const isHidden = els.editModalImagePopover.classList.contains('hidden');
    els.editModalTagPopover.classList.add('hidden');
    if (isHidden) {
      setPopoverImageStatus('modal', 'Tip: Paste images or URLs directly with Ctrl+V');
      els.editModalImagePopover.classList.remove('hidden');
      els.editModalImageUrlInput?.focus();
    } else {
      els.editModalImagePopover.classList.add('hidden');
    }
  });

  els.editModalUploadImageBtn?.addEventListener('click', () => {
    els.editModalImageFileInput?.click();
  });

  els.editModalImageFileInput?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      await handleImageFiles('modal', Array.from(input.files));
      els.editModalImagePopover?.classList.add('hidden');
    }
    input.value = '';
  });

  const submitModalImageUrl = async (): Promise<void> => {
    const raw = els.editModalImageUrlInput?.value.trim() ?? '';
    if (!raw || !state.editingDraft) return;
    setPopoverImageStatus('modal', 'Downloading & processing image...');
    try {
      const noteImg = await noteImageFromUrl(raw);
      attachImageToTarget('modal', noteImg);
      if (els.editModalImageUrlInput) els.editModalImageUrlInput.value = '';
      setPopoverImageStatus(
        'modal',
        noteImg.sourceType === 'embedded'
          ? 'Downloaded & encrypted as WebP!'
          : 'Linked external image (CORS restricted download).'
      );
      setTimeout(() => {
        els.editModalImagePopover?.classList.add('hidden');
      }, 700);
    } catch (err) {
      setPopoverImageStatus(
        'modal',
        err instanceof Error ? err.message : 'Could not load image URL.',
        true
      );
    }
  };

  els.editModalAddImageUrlBtn?.addEventListener('click', () => {
    void submitModalImageUrl();
  });

  els.editModalImageUrlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitModalImageUrl();
    }
  });

  els.editModalImagesRow?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || !state.editingDraft) return;
    const rmBtn = target.closest('[data-remove-modal-image]');
    if (rmBtn) {
      e.stopPropagation();
      const imgId = rmBtn.getAttribute('data-remove-modal-image');
      state.editingDraft.images = state.editingDraft.images.filter((img) => img.id !== imgId);
      renderEditModalImages();
      return;
    }
    const lightImg = target.closest('[data-lightbox-src]');
    if (lightImg) {
      e.stopPropagation();
      openLightbox(lightImg.getAttribute('data-lightbox-src') ?? '');
    }
  });

  els.editModalCard.addEventListener('paste', (e) => {
    if (e.target === els.editModalImageUrlInput) return;
    void handleClipboardPaste(e, 'modal');
  });

  els.editModalCard.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      els.editModalCard.classList.add('drag-over');
    }
  });

  els.editModalCard.addEventListener('dragleave', () => {
    els.editModalCard.classList.remove('drag-over');
  });

  els.editModalCard.addEventListener('drop', async (e) => {
    els.editModalCard.classList.remove('drag-over');
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      await handleImageFiles('modal', Array.from(e.dataTransfer.files));
    }
  });

  // Global paste (routes to active Board Editor, or to modal/composer when not typing in inputs)
  document.addEventListener('paste', (e) => {
    if (boardEditor.isOpen()) {
      void boardEditor.handlePaste(e);
      return;
    }
    const target = e.target as Node | null;
    if (target && (els.noteComposer.contains(target) || els.editModalCard.contains(target))) {
      return;
    }
    if (isEditableElement(document.activeElement)) {
      return;
    }
    const mode = !els.editModalBackdrop.classList.contains('hidden') ? 'modal' : 'composer';
    void handleClipboardPaste(e, mode);
  });

  // Lightbox close handlers
  els.closeLightboxBtn?.addEventListener('click', () => {
    closeLightbox();
  });

  els.imageLightboxBackdrop?.addEventListener('click', (e) => {
    if (e.target === els.imageLightboxBackdrop) {
      closeLightbox();
    }
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
      const envelope = state.lastEncryptedEnvelope ?? (await loadVaultEnvelopeFromCache());
      if (!envelope) throw new Error('No vault found');
      const decrypted = await CrypsyCrypto.decryptPayload(envelope, attempt);
      state.passphrase = attempt;
      applyDecryptedPayload(decrypted);
      els.lockScreenOverlay.classList.add('hidden');
      els.unlockErrorMsg.classList.add('hidden');
      renderAll();
      boardEditor.refreshFromExternal();
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
    if (!els.lockScreenOverlay.classList.contains('hidden')) {
      return;
    }

    if (contextMenu.handleKeyDown(e)) {
      return;
    }

    if (e.key === 'Escape') {
      if (
        els.imageLightboxBackdrop &&
        !els.imageLightboxBackdrop.classList.contains('hidden')
      ) {
        closeLightbox();
        return;
      }
      if (boardEditor.handleEscapeKey()) {
        return;
      }
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
      return;
    }

    if (
      (!els.imageLightboxBackdrop || els.imageLightboxBackdrop.classList.contains('hidden')) &&
      boardEditor.handleKeyDown(e)
    ) {
      return;
    }

    const isTyping = isEditableElement(document.activeElement);
    if (
      !boardEditor.isOpen() &&
      ((e.key === '/' && !isTyping) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))
    ) {
      e.preventDefault();
      els.searchInput.focus();
    }
  });

  document.addEventListener('keyup', (e) => {
    boardEditor.handleKeyUp(e);
  });
}

// Boot
bindEvents();
void initVault();
