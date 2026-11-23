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

import {
  buildBoardContextMenuEntries,
  buildNoteContextMenuEntries,
} from './ui/app-context-menus';
import { BoardEditorController } from './board/editor';
import {
  createBoardCardHtml,
  createNoteCardHtml,
  fitBoardMinimaps,
  renderImageOrPrivacyPlaceholderHtml as renderCardImageOrPlaceholder,
} from './ui/card-render';
import {
  captureCleanPortableTemplate,
  detectRunningCloudLocation,
  getConnectionStatus,
  getLastKnownFileModified,
  getSavedProviderMeta,
  isConnected,
  isNativeApp,
  markRemoteStampAccepted,
  onExternalUpdate,
  readVaultFromCloudFolder,
  reconnectSavedHandle,
  restoreSavedConnection,
  shareVaultWithNativeSheet,
  writeVaultToCloudFolder,
} from './vault/cloud-sync';
import { CloudWizardController } from './ui/cloud-wizard';
import { ContextMenuController, shouldBypassCustomContextMenu } from './ui/context-menu';
import { isValidEncryptedEnvelope } from './vault/crypto';
import { LockScreenController } from './vault/lock-screen';
import { toggleCheckboxLine } from './markdown';
import { bindNoteDraftSurface } from './ui/note-draft-surface';
import {
  DEFAULT_PREFERENCES,
  createSeedNotes,
  loadPreferencesIntoState,
  savePreferencesFromState,
  validateNewPassphrase,
} from './preferences';
import { filterBoards, filterNotes } from './search-filter';
import type {
  ActiveFilter,
  AppState,
  Board,
  CloudConnectionStatus,
  Note,
  NoteColor,
  NoteImage,
  VaultPayload,
  VaultSaveStatus,
} from './types';
import { UpdatesController } from './ui/updates';
import {
  autoResizeTextarea,
  byId,
  createId,
  escapeHtml,
  formatRelativeTime,
  formatTimestamp,
  isEditableElement,
  isExternalHttpUrl,
  normalizeTag,
} from './utils';
import { createBrowserVaultCache } from './vault/cache';
import { VaultModalController } from './vault/modal';
import {
  createNewBoard,
  deleteTagInVault,
  duplicateBoardInList,
  duplicateNoteInList,
  renameTagInVault,
} from './vault/mutations';
import { VaultSession, type PendingSyncConflict } from './vault/session';

// Snapshot pristine portable HTML before any vault data is decrypted or rendered
captureCleanPortableTemplate();

const sessionAllowedExternalUrls = new Set<string>();
let lastActivityAt = Date.now();

// Application State
const state: AppState = {
  ...DEFAULT_PREFERENCES,
  notes: [],
  boards: [],
  tags: ['security', 'ideas', 'work', 'personal'],
  searchQuery: '',
  activeFilter: { type: 'all', tag: null },
  passphrase: null,
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

// DOM Elements (all verified present in index.html)
const els = {
  sidebar: byId('sidebar'),
  sidebarToggleBtn: byId<HTMLButtonElement>('sidebarToggleBtn'),
  toggleBoardsSectionBtn: byId<HTMLButtonElement>('toggleBoardsSectionBtn'),
  sidebarBoardsContent: byId('sidebarBoardsContent'),
  sidebarBoardsList: byId('sidebarBoardsList'),
  newBoardForm: byId<HTMLFormElement>('newBoardForm'),
  newBoardInput: byId<HTMLInputElement>('newBoardInput'),
  toggleTagsSectionBtn: byId<HTMLButtonElement>('toggleTagsSectionBtn'),
  sidebarTagsContent: byId('sidebarTagsContent'),
  sidebarTagsList: byId('sidebarTagsList'),
  newTagForm: byId<HTMLFormElement>('newTagForm'),
  newTagInput: byId<HTMLInputElement>('newTagInput'),
  toggleGuideSectionBtn: byId<HTMLButtonElement>('toggleGuideSectionBtn'),
  sidebarGuideContent: byId('sidebarGuideContent'),
  countAll: byId('countAll'),
  countPinned: byId('countPinned'),
  countBoards: byId('countBoards'),
  boardsActionBar: byId('boardsActionBar'),
  createBoardHeroBtn: byId<HTMLButtonElement>('createBoardHeroBtn'),
  composerWrapper: byId('composerWrapper'),

  searchInput: byId<HTMLInputElement>('searchInput'),
  clearSearchBtn: byId<HTMLButtonElement>('clearSearchBtn'),
  cloudSetupBtn: byId<HTMLButtonElement>('cloudSetupBtn'),
  cloudSetupBtnLabel: byId('cloudSetupBtnLabel'),
  lastUpdatedBadge: byId('lastUpdatedBadge'),
  lastUpdatedText: byId('lastUpdatedText'),
  viewToggleBtn: byId<HTMLButtonElement>('viewToggleBtn'),
  viewIconList: byId('viewIconList'),
  viewIconGrid: byId('viewIconGrid'),
  themeToggleBtn: byId<HTMLButtonElement>('themeToggleBtn'),
  themeIconSun: byId('themeIconSun'),
  themeIconMoon: byId('themeIconMoon'),
  themeToggleLabel: byId('themeToggleLabel'),
  encryptionBadge: byId('encryptionBadge'),

  reconnectCloudBanner: byId('reconnectCloudBanner'),
  reconnectBannerMsg: byId('reconnectBannerMsg'),
  resumeCloudSyncBtn: byId<HTMLButtonElement>('resumeCloudSyncBtn'),
  changeCloudFolderBtn: byId<HTMLButtonElement>('changeCloudFolderBtn'),

  syncConflictBanner: byId('syncConflictBanner'),
  syncConflictMsg: byId('syncConflictMsg'),
  conflictMergeBtn: byId<HTMLButtonElement>('conflictMergeBtn'),
  conflictKeepLocalBtn: byId<HTMLButtonElement>('conflictKeepLocalBtn'),
  conflictKeepRemoteBtn: byId<HTMLButtonElement>('conflictKeepRemoteBtn'),

  noteComposer: byId('noteComposer'),
  composerImagesRow: byId('composerImagesRow'),
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
  composerImageBtn: byId<HTMLButtonElement>('composerImageBtn'),
  composerImagePopover: byId('composerImagePopover'),
  composerUploadImageBtn: byId<HTMLButtonElement>('composerUploadImageBtn'),
  composerImageFileInput: byId<HTMLInputElement>('composerImageFileInput'),
  composerImageUrlInput: byId<HTMLInputElement>('composerImageUrlInput'),
  composerAddImageUrlBtn: byId<HTMLButtonElement>('composerAddImageUrlBtn'),
  composerImageStatus: byId('composerImageStatus'),
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
  emptyStateTitle: byId('emptyStateTitle'),
  emptyStateSubtitle: byId('emptyStateSubtitle'),

  editModalBackdrop: byId('editModalBackdrop'),
  editModalCard: byId('editModalCard'),
  editModalImagesRow: byId('editModalImagesRow'),
  editModalTitle: byId<HTMLInputElement>('editModalTitle'),
  editModalDescription: byId<HTMLTextAreaElement>('editModalDescription'),
  editModalPinBtn: byId<HTMLButtonElement>('editModalPinBtn'),
  editModalTagsRow: byId('editModalTagsRow'),
  editModalTimestamp: byId('editModalTimestamp'),
  editModalTagBtn: byId<HTMLButtonElement>('editModalTagBtn'),
  editModalTagPopover: byId('editModalTagPopover'),
  editModalTagSearch: byId<HTMLInputElement>('editModalTagSearch'),
  editModalTagOptions: byId('editModalTagOptions'),
  editModalImageBtn: byId<HTMLButtonElement>('editModalImageBtn'),
  editModalImagePopover: byId('editModalImagePopover'),
  editModalUploadImageBtn: byId<HTMLButtonElement>('editModalUploadImageBtn'),
  editModalImageFileInput: byId<HTMLInputElement>('editModalImageFileInput'),
  editModalImageUrlInput: byId<HTMLInputElement>('editModalImageUrlInput'),
  editModalAddImageUrlBtn: byId<HTMLButtonElement>('editModalAddImageUrlBtn'),
  editModalImageStatus: byId('editModalImageStatus'),
  editModalColorPicker: byId('editModalColorPicker'),
  editModalDeleteBtn: byId<HTMLButtonElement>('editModalDeleteBtn'),
  editModalSaveBtn: byId<HTMLButtonElement>('editModalSaveBtn'),

  topbarLockBtn: byId<HTMLButtonElement>('topbarLockBtn'),
  imageLightboxBackdrop: byId('imageLightboxBackdrop'),
  closeLightboxBtn: byId<HTMLButtonElement>('closeLightboxBtn'),
  lightboxImage: byId<HTMLImageElement>('lightboxImage'),
};

// Preferences
function loadPreferences(): void {
  loadPreferencesIntoState(state);
}

function savePreferences(): void {
  savePreferencesFromState(state);
}

// Persistence debounce for board edits
let boardPersistTimer: number | null = null;

function clearBoardPersistTimer(): boolean {
  if (boardPersistTimer !== null) {
    window.clearTimeout(boardPersistTimer);
    boardPersistTimer = null;
    return true;
  }
  return false;
}

function scheduleBoardPersist(immediate = false): void {
  clearBoardPersistTimer();
  if (immediate) {
    void persistEncryptedVault().catch((err) => {
      console.warn('Board persist failed:', err);
    });
    return;
  }
  boardPersistTimer = window.setTimeout(() => {
    boardPersistTimer = null;
    void persistEncryptedVault().catch((err) => {
      console.warn('Debounced board persist failed:', err);
    });
  }, 500);
}

/**
 * Synchronously commits any open edit modal, composer draft, or board text edit into `state`.
 * Returns `true` if any data changed (so `lockVault` persists before clearing state).
 */
function commitOpenDraftsToState(): boolean {
  let dirty = clearBoardPersistTimer();

  if (boardEditor.isOpen() && boardEditor.commitPendingEdits()) {
    dirty = true;
  }

  if (state.editingNoteId && state.editingDraft) {
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
        dirty = true;
      }
    }
    state.editingNoteId = null;
    state.editingDraft = null;
    els.editModalBackdrop.classList.add('hidden');
  }

  if (state.composer.expanded) {
    const title = els.composerTitle.value.trim();
    const description = els.composerDescription.value.trim();
    if (title || description || state.composer.images.length > 0) {
      const now = Date.now();
      state.notes.unshift({
        id: createId('note'),
        title,
        description,
        images: [...state.composer.images],
        tags: [...state.composer.tags],
        pinned: state.composer.pinned,
        color: state.composer.color,
        createdAt: now,
        updatedAt: now,
      });
      dirty = true;
    }
    resetComposer();
  }

  return dirty;
}

function clearSensitiveStateAndDom(): void {
  clearBoardPersistTimer();
  sessionAllowedExternalUrls.clear();
  state.notes = [];
  state.boards = [];
  state.tags = [];
  state.activeBoardId = null;
  state.editingNoteId = null;
  state.editingDraft = null;
  state.searchQuery = '';
  els.searchInput.value = '';
  els.clearSearchBtn.classList.add('hidden');

  boardEditor.clearSensitiveMemory();
  contextMenu.close();
  resetComposer();
  closeLightbox();
  els.editModalTitle.value = '';
  els.editModalDescription.value = '';
  els.editModalImagesRow.innerHTML = '';
  els.editModalTagsRow.innerHTML = '';
  els.editModalTimestamp.textContent = '';
  els.composerTagSearch.value = '';
  els.editModalTagSearch.value = '';
  els.composerImageUrlInput.value = '';
  els.editModalImageUrlInput.value = '';
  els.newBoardInput.value = '';
  els.newTagInput.value = '';
  els.activeFilterText.innerHTML = '';
  els.activeFilterBanner.classList.add('hidden');

  els.editModalBackdrop.classList.add('hidden');
  vaultModal.clearSensitiveUI();
  cloudWizard.close();
  updatesController.close();

  els.pinnedSection.classList.add('hidden');
  els.othersSection.classList.add('hidden');
  els.emptyState.classList.add('hidden');
  els.pinnedGrid.innerHTML = '';
  els.othersGrid.innerHTML = '';
  els.sidebarBoardsList.innerHTML = '';
  els.sidebarTagsList.innerHTML = '';
  els.countAll.textContent = '0';
  els.countPinned.textContent = '0';
  els.countBoards.textContent = '0';
}

function renderConflictBanner(conflict: PendingSyncConflict | null): void {
  if (!conflict) {
    els.syncConflictBanner.classList.add('hidden');
    return;
  }
  els.syncConflictMsg.textContent = conflict.message;
  els.syncConflictBanner.classList.remove('hidden');
}

// Vault Session Engine (Load / Save / Sync / Conflict / Lock)
const vaultSession: VaultSession = new VaultSession({
  cache: createBrowserVaultCache(),
  cloud: {
    isConnected,
    getConnectionStatus,
    readVault: readVaultFromCloudFolder,
    writeVault: writeVaultToCloudFolder,
    markRemoteStampAccepted,
    reconnectSavedHandle,
  },
  host: {
    get passphrase() {
      return state.passphrase;
    },
    set passphrase(v: string | null) {
      state.passphrase = v;
    },
    get lastEncryptedEnvelope() {
      return state.lastEncryptedEnvelope;
    },
    set lastEncryptedEnvelope(v) {
      state.lastEncryptedEnvelope = v;
    },
    getPayloadSnapshot: (): VaultPayload => ({
      notes: state.notes,
      tags: state.tags,
      boards: state.boards,
    }),
    applyPayload: (payload: VaultPayload) => {
      state.notes = payload.notes;
      state.tags = payload.tags;
      state.boards = payload.boards ?? [];
      if (state.activeBoardId && !state.boards.some((b) => b.id === state.activeBoardId)) {
        state.activeBoardId = null;
      }
    },
    hasLocalContent: () => state.notes.length > 0 || state.boards.length > 0,
    isBusyEditing: () =>
      boardEditor.isGestureActive() ||
      boardEditor.isEditingText() ||
      state.editingNoteId !== null ||
      state.composer.expanded,
    commitOpenDrafts: commitOpenDraftsToState,
    clearSensitiveStateAndDom,
    renderAll: () => renderAll(),
    refreshBoardFromExternal: () => boardEditor.refreshFromExternal(),
    showLockScreen: (mode, errorMsg, options) => lockScreen.setMode(mode, errorMsg, options),
    hideLockScreen: () => lockScreen.hide(),
    onSaveStatusChanged: (status) => {
      updateLastUpdatedUI(status);
      vaultModal.updateCiphertextPreview();
    },
    onCloudStatusChanged: (status) => updateCloudStatusUI(status),
    onConflictChanged: (conflict) => renderConflictBanner(conflict),
    confirmAction: (message) => window.confirm(message),
  },
});

async function persistEncryptedVault(): Promise<void> {
  clearBoardPersistTimer();
  await vaultSession.persist();
}

/**
 * Shared mutation helper: applies state mutation, renders IMMEDIATELY before I/O,
 * then persists encrypted vault in the background/awaited path with surfaced status.
 */
async function commitMutation(mutate: () => boolean | void): Promise<void> {
  const result = mutate();
  if (result === false) return;
  renderAll();
  try {
    await persistEncryptedVault();
  } catch (err) {
    console.warn('Vault save failed:', err);
  }
}

async function lockVault(flushPending = false, errorMsg?: string): Promise<void> {
  await vaultSession.lock({ flushPending, ...(errorMsg ? { errorMsg } : {}) });
}

async function initVault(): Promise<void> {
  loadPreferences();
  applyThemeUI();
  applyViewModeUI();
  applySidebarSectionsUI();
  if (typeof window !== 'undefined' && window.innerWidth <= 768) {
    els.sidebar.classList.add('collapsed');
  }

  onExternalUpdate(async (externalEnvelope, stamp) => {
    await vaultSession.handleExternalUpdate(externalEnvelope, stamp);
    updateCloudStatusUI();
  });

  const detectedCloud = detectRunningCloudLocation();
  if (detectedCloud && detectedCloud.providerId) {
    state.selectedProviderId = detectedCloud.providerId;
  }

  const cloudState = await restoreSavedConnection();
  updateCloudStatusUI(cloudState.status);

  setInterval(() => updateLastUpdatedUI(), 30000);
  updatesController.init();

  await vaultSession.init(cloudState.status);
  updateLastUpdatedUI();
}

function updateLastUpdatedUI(status: VaultSaveStatus = vaultSession.getSaveStatus()): void {
  els.lastUpdatedBadge.classList.remove('synced', 'saving', 'warning', 'error');

  if (status.state === 'saving') {
    els.lastUpdatedBadge.classList.remove('hidden');
    els.lastUpdatedBadge.classList.add('saving');
    els.lastUpdatedText.textContent = 'Saving...';
    els.lastUpdatedBadge.title = 'Encrypting and saving vault...';
    return;
  }

  if (status.state === 'failed') {
    els.lastUpdatedBadge.classList.remove('hidden');
    els.lastUpdatedBadge.classList.add('error');
    els.lastUpdatedText.textContent = 'Save failed';
    els.lastUpdatedBadge.title = status.message;
    return;
  }

  if (status.state === 'conflict') {
    els.lastUpdatedBadge.classList.remove('hidden');
    els.lastUpdatedBadge.classList.add('error');
    els.lastUpdatedText.textContent = 'Sync conflict';
    els.lastUpdatedBadge.title = status.message;
    return;
  }

  if (status.state === 'needs_permission') {
    els.lastUpdatedBadge.classList.remove('hidden');
    els.lastUpdatedBadge.classList.add('warning');
    els.lastUpdatedText.textContent = 'Saved locally (paused)';
    els.lastUpdatedBadge.title = status.message;
    return;
  }

  const meta = getSavedProviderMeta();
  const connected = isConnected();
  const fileModifiedMs = getLastKnownFileModified();
  const envelopeUpdatedMs =
    state.lastEncryptedEnvelope && state.lastEncryptedEnvelope.updatedAt
      ? Date.parse(state.lastEncryptedEnvelope.updatedAt)
      : 0;
  const syncedAtMs = meta && meta.lastSyncedAt ? Date.parse(meta.lastSyncedAt) : 0;
  const latestNoteMs = state.notes.reduce((max, n) => Math.max(max, n.updatedAt || 0), 0);
  const latestBoardMs = state.boards.reduce((max, b) => Math.max(max, b.updatedAt || 0), 0);
  const savedAtMs = status.state === 'saved' ? status.at : 0;

  const bestTimestamp = connected
    ? Math.max(fileModifiedMs || 0, syncedAtMs || 0, envelopeUpdatedMs || 0, savedAtMs)
    : Math.max(envelopeUpdatedMs || 0, latestNoteMs || 0, latestBoardMs || 0, savedAtMs);

  if (!bestTimestamp) {
    els.lastUpdatedBadge.classList.add('hidden');
    return;
  }

  const rel = formatRelativeTime(bestTimestamp);
  const fullDate = new Date(bestTimestamp).toLocaleString();
  const prefix = connected ? 'Synced' : 'Saved';

  els.lastUpdatedBadge.classList.remove('hidden');
  els.lastUpdatedBadge.classList.toggle('synced', connected);
  els.lastUpdatedText.textContent = `${prefix} ${rel}`;
  els.lastUpdatedBadge.title = `${prefix} at ${fullDate}`;
}

function updateCloudStatusUI(explicitStatus?: CloudConnectionStatus): void {
  const status = explicitStatus ?? getConnectionStatus();
  const meta = getSavedProviderMeta();
  const detectedCloud = detectRunningCloudLocation();

  if (status === 'needs_permission' && meta) {
    els.reconnectBannerMsg.innerHTML = `Linked to <strong>${escapeHtml(meta.providerName)} (${escapeHtml(meta.folderName)})</strong>. Click to resume live auto-sync.`;
    els.reconnectCloudBanner.classList.remove('hidden');
    els.cloudSetupBtn.classList.remove('synced', 'detected');
    els.cloudSetupBtnLabel.textContent = `Resume ${meta.providerName}`;
    els.cloudSetupBtn.title = `Permission needed to sync with ${meta.providerName} (/${meta.folderName})`;
    updateLastUpdatedUI();
    return;
  }

  els.reconnectCloudBanner.classList.add('hidden');

  if (status === 'connected' && meta) {
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
  const isLight = state.theme === 'light';
  const metaTheme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', isLight ? '#ffffff' : '#202124');
  }
  els.themeToggleLabel.textContent = isLight ? 'Light mode' : 'Dark mode';
  els.themeIconSun.classList.toggle('hidden', isLight);
  els.themeIconMoon.classList.toggle('hidden', !isLight);
  els.themeToggleBtn.title = isLight ? 'Switch to Dark theme' : 'Switch to Light theme';
  els.themeToggleBtn.setAttribute('aria-pressed', String(isLight));
}

function closeSidebarIfMobile(): void {
  if (typeof window !== 'undefined' && window.innerWidth <= 768) {
    els.sidebar.classList.add('collapsed');
  }
}

async function shareOrDownloadVaultJson(): Promise<void> {
  if (!state.lastEncryptedEnvelope) return;
  const filename = `crypsy-vault-${new Date().toISOString().slice(0, 10)}.crypsy.json`;

  if (isNativeApp()) {
    try {
      await shareVaultWithNativeSheet(state.lastEncryptedEnvelope, filename);
      return;
    } catch (err) {
      if (err instanceof Error && /cancel|abort/i.test(err.message)) return;
    }
  }

  const jsonText = JSON.stringify(state.lastEncryptedEnvelope, null, 2);

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof File === 'function') {
    try {
      const vaultFile = new File([jsonText], filename, { type: 'application/json' });
      const canShareFiles =
        typeof navigator.canShare !== 'function' || navigator.canShare({ files: [vaultFile] });
      if (canShareFiles) {
        await navigator.share({
          files: [vaultFile],
          title: 'Crypsy Encrypted Vault',
        });
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }

  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function importEncryptedVaultFile(file: File, backdropToClose?: HTMLElement): Promise<void> {
  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (!isValidEncryptedEnvelope(parsed)) {
      throw new Error('Invalid .crypsy vault file: missing or malformed encryption fields.');
    }
    const outcome = await vaultSession.importEnvelope(parsed, {
      requireConfirmIfNonEmpty: true,
      source: 'file',
    });
    if (outcome !== 'cancelled') {
      backdropToClose?.classList.add('hidden');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid .crypsy vault file.';
    if (lockScreen.isOpen()) {
      lockScreen.showError(msg);
    } else {
      alert(msg);
    }
  }
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
  els.toggleBoardsSectionBtn.setAttribute('aria-expanded', String(state.boardsSectionExpanded));
  els.toggleBoardsSectionBtn.title = state.boardsSectionExpanded
    ? 'Collapse Boards'
    : 'Expand Boards';
  els.sidebarBoardsContent.classList.toggle('hidden', !state.boardsSectionExpanded);

  els.toggleTagsSectionBtn.setAttribute('aria-expanded', String(state.tagsSectionExpanded));
  els.toggleTagsSectionBtn.title = state.tagsSectionExpanded ? 'Collapse Tags' : 'Expand Tags';
  els.sidebarTagsContent.classList.toggle('hidden', !state.tagsSectionExpanded);

  els.toggleGuideSectionBtn.setAttribute('aria-expanded', String(state.guideSectionExpanded));
  els.toggleGuideSectionBtn.title = state.guideSectionExpanded
    ? 'Collapse Quick Guide'
    : 'Expand Quick Guide';
  els.sidebarGuideContent.classList.toggle('hidden', !state.guideSectionExpanded);
}

// Shared Custom Context Menu, Cloud Wizard, Updates & Spatial Boards Controllers
const contextMenu = new ContextMenuController();

const cloudWizard = new CloudWizardController({
  getSelectedProviderId: () => state.selectedProviderId,
  setSelectedProviderId: (id) => {
    state.selectedProviderId = id;
  },
  onLoadCloudEnvelope: (envelope) =>
    vaultSession.importEnvelope(envelope, { source: 'cloud' }),
  persistEncryptedVault,
  updateCloudStatusUI,
  shareOrDownloadVaultJson,
  importEncryptedVaultFile,
});

const updatesController = new UpdatesController({
  getAutoCheckUpdates: () => state.autoCheckUpdates,
  setAutoCheckUpdates: (enabled) => {
    state.autoCheckUpdates = enabled;
    savePreferences();
  },
});

const vaultModal = new VaultModalController({
  getLastEnvelope: () => state.lastEncryptedEnvelope,
  getAutoLockMinutes: () => state.autoLockMinutes,
  setAutoLockMinutes: (minutes) => {
    state.autoLockMinutes = minutes;
    lastActivityAt = Date.now();
    savePreferences();
  },
  getLockOnHide: () => state.lockOnHide,
  setLockOnHide: (enabled) => {
    state.lockOnHide = enabled;
    savePreferences();
  },
  getBlockExternalMedia: () => state.blockExternalMedia,
  setBlockExternalMedia: (enabled) => {
    state.blockExternalMedia = enabled;
    if (enabled) {
      sessionAllowedExternalUrls.clear();
    }
    savePreferences();
    renderNotes();
    renderComposerImages();
    renderEditModalImages();
    if (boardEditor.isOpen()) {
      boardEditor.refreshFromExternal();
    }
  },
  validateNewPassphrase,
  onRekeyPassphrase: async (nextPassphrase) => {
    const prev = state.passphrase;
    state.passphrase = nextPassphrase;
    try {
      await persistEncryptedVault();
    } catch (err) {
      state.passphrase = prev;
      throw err;
    }
  },
  onLockNow: async () => {
    await lockVault(true);
  },
  onExportVault: shareOrDownloadVaultJson,
  onImportVaultFile: importEncryptedVaultFile,
});

const lockScreen: LockScreenController = new LockScreenController({
  isPendingCloudPermission: () => getConnectionStatus() === 'needs_permission',
  getSelectedProviderId: () => state.selectedProviderId,
  validateNewPassphrase,
  onCreateOrUpgradeVault: async (mode, passphrase) => {
    await vaultSession.createOrUpgradeVault(mode, passphrase, {
      notes: createSeedNotes(),
      tags: ['security', 'ideas', 'work', 'personal'],
      boards: [],
    });
  },
  onUnlockVault: async (passphrase) => {
    await vaultSession.unlockWithPassphrase(passphrase);
  },
  onTryLegacyUpgrade: () => vaultSession.tryBeginLegacyUpgrade(),
  onCancelPendingImport: () => vaultSession.cancelPendingImport(),
  onResumeCloudSync: () => vaultSession.resumeCloudSync(),
  onCloudStatusConnected: () => updateCloudStatusUI('connected'),
  onLoadCloudEnvelope: async (envelope) => {
    await vaultSession.importEnvelope(envelope, { source: 'cloud' });
  },
  onImportVaultFile: (file) => importEncryptedVaultFile(file),
});

const boardEditor: BoardEditorController = new BoardEditorController({
  getBoard: () => state.boards.find((b) => b.id === state.activeBoardId) ?? null,
  getSearchQuery: () => state.searchQuery,
  getAllTags: () => state.tags,
  contextMenu,
  isLocked: () => lockScreen.isOpen(),
  onAddTagToVault: (tag) => {
    const clean = normalizeTag(tag);
    if (clean && !state.tags.includes(clean)) {
      state.tags.push(clean);
    }
  },
  renderTagPopoverOptions,
  updateColorDots,
  onBoardMutated: (board, immediate = false) => {
    board.updatedAt = Date.now();
    renderSidebar();
    if (!boardEditor.isOpen()) {
      renderNotes();
    }
    updateLastUpdatedUI();
    scheduleBoardPersist(immediate);
  },
  onDeleteBoard: (boardId) => {
    void deleteBoard(boardId);
  },
  onCloseBoard: () => {
    if (clearBoardPersistTimer()) {
      void persistEncryptedVault().catch((err) => {
        console.warn('Board close persist failed:', err);
      });
    }
    state.activeBoardId = null;
    renderAll();
    void vaultSession.flushPendingExternalUpdate();
  },
  onIdleForSync: () => {
    void vaultSession.flushPendingExternalUpdate();
  },
  onOpenLightbox: (src) => {
    openLightbox(src);
  },
  isExternalImageAllowed: (url) => isExternalImageAllowed(url),
  onAllowExternalUrl: (url) => {
    sessionAllowedExternalUrls.add(url);
  },
});

function isExternalImageAllowed(src: string): boolean {
  if (!isExternalHttpUrl(src)) return true;
  if (!state.blockExternalMedia) return true;
  return sessionAllowedExternalUrls.has(src);
}

function renderImageOrPrivacyPlaceholderHtml(
  src: string,
  alt: string,
  options: { className?: string; lazy?: boolean } = {}
): string {
  return renderCardImageOrPlaceholder(src, alt, isExternalImageAllowed, options);
}

async function createBoard(rawTitle?: string): Promise<void> {
  const initialTag = state.activeFilter.type === 'tag' ? state.activeFilter.tag : null;
  const board = createNewBoard(state.boards.length, rawTitle, initialTag);
  state.boards.unshift(board);
  state.boardsSectionExpanded = true;
  state.activeFilter = { type: 'boards', tag: null };
  savePreferences();
  applySidebarSectionsUI();
  openBoardEditor(board.id);
  try {
    await persistEncryptedVault();
  } catch (err) {
    console.warn('Failed to persist new board:', err);
  }
}

function openBoardEditor(boardId: string): void {
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return;
  state.activeBoardId = board.id;
  renderAll();
  boardEditor.open(board);
}

async function deleteBoard(boardId: string): Promise<void> {
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return;
  const label = board.title.trim() || 'Untitled Board';
  if (!window.confirm(`Delete board "${label}"? This cannot be undone.`)) {
    return;
  }
  await commitMutation(() => {
    state.boards = state.boards.filter((b) => b.id !== boardId);
    if (state.activeBoardId === boardId) {
      state.activeBoardId = null;
      if (boardEditor.isOpen()) {
        boardEditor.close();
      }
    }
  });
}

async function toggleNotePin(noteId: string): Promise<void> {
  await commitMutation(() => {
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) return false;
    note.pinned = !note.pinned;
    note.updatedAt = Date.now();
  });
}

async function deleteNote(noteId: string): Promise<boolean> {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return false;
  const label = note.title.trim() || 'Untitled note';
  if (!window.confirm(`Delete note "${label}"? This cannot be undone.`)) {
    return false;
  }
  await commitMutation(() => {
    state.notes = state.notes.filter((n) => n.id !== noteId);
  });
  return true;
}

async function duplicateNote(noteId: string): Promise<void> {
  await commitMutation(() => Boolean(duplicateNoteInList(state.notes, noteId)));
}

async function setNoteColor(noteId: string, color: NoteColor): Promise<void> {
  await commitMutation(() => {
    const note = state.notes.find((n) => n.id === noteId);
    if (!note || note.color === color) return false;
    note.color = color;
    note.updatedAt = Date.now();
  });
}

async function toggleBoardPin(boardId: string): Promise<void> {
  await commitMutation(() => {
    const board = state.boards.find((b) => b.id === boardId);
    if (!board) return false;
    board.pinned = !board.pinned;
    board.updatedAt = Date.now();
  });
}

async function duplicateBoard(boardId: string): Promise<void> {
  await commitMutation(() => Boolean(duplicateBoardInList(state.boards, boardId)));
}

async function setBoardColor(boardId: string, color: NoteColor): Promise<void> {
  await commitMutation(() => {
    const board = state.boards.find((b) => b.id === boardId);
    if (!board || board.color === color) return false;
    board.color = color;
    board.updatedAt = Date.now();
  });
}

async function deleteTag(tagToDelete: string): Promise<void> {
  await commitMutation(() => {
    deleteTagInVault(state, tagToDelete);
  });
}

async function renameTag(oldTag: string, rawNextTag: string): Promise<void> {
  const changed = renameTagInVault(state, oldTag, rawNextTag);
  if (!changed) {
    renderSidebar();
    return;
  }
  await commitMutation(() => true);
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
  contextMenu.open(
    clientX,
    clientY,
    buildNoteContextMenuEntries(note, {
      onEdit: () => openEditModal(note.id),
      onTogglePin: () => toggleNotePin(note.id),
      onDuplicate: () => duplicateNote(note.id),
      onCopyText: () => {
        const text = [note.title, note.description].filter(Boolean).join('\n\n');
        if (text && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).catch(() => {});
        }
      },
      onSetColor: (c) => setNoteColor(note.id, c),
      onDelete: () => void deleteNote(note.id),
    })
  );
}

function openBoardContextMenu(
  clientX: number,
  clientY: number,
  board: Board,
  sidebarRowEl?: HTMLElement
): void {
  const onRename = sidebarRowEl
    ? () =>
        startInlineSidebarRename(sidebarRowEl, board.title || 'Untitled Board', async (val) => {
          const nextTitle = val.trim();
          if (nextTitle && nextTitle !== board.title) {
            await commitMutation(() => {
              board.title = nextTitle;
              board.updatedAt = Date.now();
            });
            if (state.activeBoardId === board.id) {
              boardEditor.refreshFromExternal();
            }
          } else {
            renderSidebar();
          }
        })
    : undefined;

  contextMenu.open(
    clientX,
    clientY,
    buildBoardContextMenuEntries(board, {
      onOpen: () => openBoardEditor(board.id),
      ...(onRename ? { onRename } : {}),
      onTogglePin: () => toggleBoardPin(board.id),
      onDuplicate: () => duplicateBoard(board.id),
      onSetColor: (c) => setBoardColor(board.id, c),
      onDelete: () => void deleteBoard(board.id),
    })
  );
}

// Filtering & Search
function getFilteredNotes(): Note[] {
  return filterNotes(state.notes, state.activeFilter, state.searchQuery);
}

function getFilteredBoards(): Board[] {
  return filterBoards(state.boards, state.activeFilter, state.searchQuery);
}

// Render Functions
function renderSidebar(): void {
  els.countAll.textContent = String(state.notes.length);
  const pinnedCount =
    state.notes.filter((n) => n.pinned).length + state.boards.filter((b) => b.pinned).length;
  els.countPinned.textContent = String(pinnedCount);
  els.countBoards.textContent = String(state.boards.length);

  document.querySelectorAll('.sidebar-nav .nav-item[data-filter-type]').forEach((btn) => {
    const filterType = btn.getAttribute('data-filter-type');
    const isActive =
      state.activeFilter.type === filterType &&
      !state.activeFilter.tag &&
      !(filterType === 'boards' && state.activeBoardId);
    btn.classList.toggle('active', isActive);
  });

  const sortedBoards = [...state.boards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  els.sidebarBoardsList.innerHTML = sortedBoards
    .map((board) => {
      const isActive = state.activeBoardId === board.id;
      const itemCount = Number(board.items.length) || 0;
      return `
        <div class="nav-item sidebar-board-item ${isActive ? 'active' : ''}" data-open-board="${escapeHtml(board.id)}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="3" y="3" width="8" height="8" rx="1.5"></rect>
            <rect x="13" y="3" width="8" height="5" rx="1.5"></rect>
            <rect x="13" y="10" width="8" height="11" rx="1.5"></rect>
            <rect x="3" y="13" width="8" height="8" rx="1.5"></rect>
          </svg>
          <span class="nav-label">${escapeHtml(board.title || 'Untitled Board')}</span>
          <span class="nav-count">${itemCount}</span>
          <button type="button" class="tag-delete-btn" data-delete-board="${escapeHtml(board.id)}" title="Delete board">&times;</button>
        </div>
      `;
    })
    .join('');

  els.sidebarTagsList.innerHTML = state.tags
    .map((tag) => {
      const count =
        state.notes.filter((n) => n.tags.includes(tag)).length +
        state.boards.filter((b) => b.tags.includes(tag)).length;
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
  els.boardsActionBar.classList.toggle('hidden', !isBoardsView);
  els.composerWrapper.classList.toggle('hidden', isBoardsView);

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

async function toggleNoteCheckbox(noteId: string, lineIndex: number): Promise<void> {
  await commitMutation(() => {
    const note = state.notes.find((n) => n.id === noteId);
    if (!note || typeof note.description !== 'string') return false;
    const nextDesc = toggleCheckboxLine(note.description, lineIndex);
    if (nextDesc === null) return false;
    note.description = nextDesc;
    note.updatedAt = Date.now();
  });
}

type WorkspaceCardEntry =
  | { kind: 'note'; item: Note; pinned: boolean; updatedAt: number }
  | { kind: 'board'; item: Board; pinned: boolean; updatedAt: number };

function renderWorkspaceCardHtml(entry: WorkspaceCardEntry): string {
  return entry.kind === 'board'
    ? createBoardCardHtml(entry.item, state.searchQuery, isExternalImageAllowed)
    : createNoteCardHtml(entry.item, state.searchQuery, isExternalImageAllowed);
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
    els.emptyStateTitle.textContent =
      state.activeFilter.type === 'boards' ? 'No encrypted boards yet' : 'No encrypted notes found';
    els.emptyStateSubtitle.textContent =
      state.activeFilter.type === 'boards'
        ? 'Create a spatial board above or from the Boards menu in the sidebar.'
        : 'Create a note above or try adjusting your search or tag filter.';
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
  vaultModal.updateCiphertextPreview();
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
  els.composerImagePopover.classList.add('hidden');
  els.composerImagesRow.classList.add('hidden');
  els.composerImagesRow.innerHTML = '';
  updateColorDots(els.composerColorPicker, 'default');
}

function renderDraftImages(rowEl: HTMLElement, images: NoteImage[], removeAttr: string): void {
  if (images.length === 0) {
    rowEl.classList.add('hidden');
    rowEl.innerHTML = '';
    return;
  }
  rowEl.classList.remove('hidden');
  rowEl.classList.toggle('single-image', images.length === 1);
  rowEl.innerHTML = images
    .map(
      (img) => `
      <div class="note-edit-image-item">
        ${renderImageOrPrivacyPlaceholderHtml(img.src, img.alt || 'Note image')}
        <span class="note-image-badge">${img.sourceType === 'external' ? 'External URL' : 'Encrypted WebP'}</span>
        <button type="button" class="note-image-remove-btn" ${removeAttr}="${escapeHtml(img.id)}" title="Remove image" aria-label="Remove image">&times;</button>
      </div>
    `
    )
    .join('');
}

function renderDraftTags(
  rowEl: HTMLElement,
  tags: string[],
  removeAttr: string,
  hideWhenEmpty = false
): void {
  if (hideWhenEmpty && tags.length === 0) {
    rowEl.classList.add('hidden');
    rowEl.innerHTML = '';
    return;
  }
  if (hideWhenEmpty) {
    rowEl.classList.remove('hidden');
  }
  rowEl.innerHTML = tags
    .map(
      (t) => `
      <span class="tag-chip">
        #${escapeHtml(t)}
        <button type="button" class="tag-chip-remove" ${removeAttr}="${escapeHtml(t)}">&times;</button>
      </span>
    `
    )
    .join('');
}

function renderComposerImages(): void {
  renderDraftImages(els.composerImagesRow, state.composer.images, 'data-remove-composer-image');
}

function renderComposerTags(): void {
  renderDraftTags(els.composerTagsRow, state.composer.tags, 'data-remove-composer-tag', true);
}

async function saveComposerNote(): Promise<void> {
  const title = els.composerTitle.value.trim();
  const description = els.composerDescription.value.trim();
  if (!title && !description && state.composer.images.length === 0) {
    resetComposer();
    await vaultSession.flushPendingExternalUpdate();
    return;
  }

  const now = Date.now();
  const newNote: Note = {
    id: createId('note'),
    title,
    description,
    images: [...state.composer.images],
    tags: [...state.composer.tags],
    pinned: state.composer.pinned,
    color: state.composer.color,
    createdAt: now,
    updatedAt: now,
  };

  resetComposer();
  await commitMutation(() => {
    state.notes.unshift(newNote);
  });
  await vaultSession.flushPendingExternalUpdate();
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
  const q = normalizeTag(searchValue);
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
    tags: [...note.tags],
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
  els.editModalImagePopover.classList.add('hidden');
  els.editModalBackdrop.classList.remove('hidden');
  autoResizeTextarea(els.editModalDescription);
  els.editModalDescription.focus();
}

function renderEditModalImages(): void {
  if (!state.editingDraft) return;
  renderDraftImages(els.editModalImagesRow, state.editingDraft.images, 'data-remove-modal-image');
}

function renderEditModalTags(): void {
  if (!state.editingDraft) return;
  renderDraftTags(els.editModalTagsRow, state.editingDraft.tags, 'data-remove-modal-tag');
}

async function saveAndCloseEditModal(): Promise<void> {
  if (!state.editingNoteId || !state.editingDraft) {
    els.editModalBackdrop.classList.add('hidden');
    return;
  }

  const idx = state.notes.findIndex((n) => n.id === state.editingNoteId);
  const existing = idx !== -1 ? state.notes[idx] : undefined;
  let changed = false;

  if (existing) {
    const newTitle = els.editModalTitle.value.trim();
    const newDesc = els.editModalDescription.value.trim();

    changed =
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
    }
  }

  state.editingNoteId = null;
  state.editingDraft = null;
  els.editModalBackdrop.classList.add('hidden');
  renderAll();

  if (changed) {
    try {
      await persistEncryptedVault();
    } catch (err) {
      console.warn('Failed to persist edited note:', err);
    }
  }

  await vaultSession.flushPendingExternalUpdate();
}

function openLightbox(src: string): void {
  if (!src) return;
  els.lightboxImage.src = src;
  els.imageLightboxBackdrop.classList.remove('hidden');
}

function closeLightbox(): void {
  els.imageLightboxBackdrop.classList.add('hidden');
  els.lightboxImage.src = '';
}

// Event Listeners
function bindEvents(): void {
  els.sidebarToggleBtn.addEventListener('click', () => {
    els.sidebar.classList.toggle('collapsed');
    fitBoardMinimaps();
    window.setTimeout(fitBoardMinimaps, 220);
  });

  document.querySelectorAll('.sidebar-nav .nav-item[data-filter-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-filter-type');
      if (type === 'all' || type === 'pinned' || type === 'boards') {
        state.activeFilter = { type, tag: null };
        closeSidebarIfMobile();
        if (boardEditor.isOpen()) {
          boardEditor.close();
          return;
        }
        renderAll();
      }
    });
  });

  document.querySelector('.main-content')?.addEventListener('click', () => {
    closeSidebarIfMobile();
  });

  els.toggleBoardsSectionBtn.addEventListener('click', () => {
    state.boardsSectionExpanded = !state.boardsSectionExpanded;
    applySidebarSectionsUI();
    savePreferences();
  });

  els.newBoardForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = els.newBoardInput.value;
    els.newBoardInput.value = '';
    await createBoard(raw);
  });

  els.createBoardHeroBtn.addEventListener('click', () => {
    void createBoard();
  });

  els.sidebarBoardsList.addEventListener('click', async (e) => {
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
        closeSidebarIfMobile();
        openBoardEditor(boardId);
      }
    }
  });

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
      closeSidebarIfMobile();
      if (boardEditor.isOpen()) {
        boardEditor.close();
        return;
      }
      renderAll();
    }
  });

  els.sidebarBoardsList.addEventListener('contextmenu', (e) => {
    if (shouldBypassCustomContextMenu(e, lockScreen.getOverlayEl())) return;
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
    if (shouldBypassCustomContextMenu(e, lockScreen.getOverlayEl())) return;
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

  els.newTagForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = normalizeTag(els.newTagInput.value);
    if (!raw) return;
    els.newTagInput.value = '';
    state.activeFilter = { type: 'tag', tag: raw };
    if (!state.tags.includes(raw)) {
      await commitMutation(() => {
        state.tags.push(raw);
      });
    } else {
      renderAll();
    }
  });

  els.toggleTagsSectionBtn.addEventListener('click', () => {
    state.tagsSectionExpanded = !state.tagsSectionExpanded;
    applySidebarSectionsUI();
    savePreferences();
  });

  els.toggleGuideSectionBtn.addEventListener('click', () => {
    state.guideSectionExpanded = !state.guideSectionExpanded;
    applySidebarSectionsUI();
    savePreferences();
  });

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

  els.resetFilterBtn.addEventListener('click', () => {
    state.activeFilter = { type: 'all', tag: null } satisfies ActiveFilter;
    state.searchQuery = '';
    els.searchInput.value = '';
    els.clearSearchBtn.classList.add('hidden');
    renderAll();
  });

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

  els.themeToggleBtn.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyThemeUI();
    savePreferences();
  });

  // Cloud Setup, Reconnect Banner & Conflict Resolution Banner
  els.cloudSetupBtn.addEventListener('click', () => {
    cloudWizard.open();
  });

  els.resumeCloudSyncBtn.addEventListener('click', async () => {
    const res = await vaultSession.resumeCloudSync();
    if (res.error) {
      alert(res.error);
    }
  });

  els.changeCloudFolderBtn.addEventListener('click', () => {
    cloudWizard.open(1);
  });

  els.conflictMergeBtn.addEventListener('click', async () => {
    try {
      await vaultSession.resolveConflict('merge');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not merge conflicting vault changes.');
    }
  });

  els.conflictKeepLocalBtn.addEventListener('click', async () => {
    if (!window.confirm('Overwrite the cloud vault file with your local copy?')) return;
    try {
      await vaultSession.resolveConflict('keep_local');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not push local vault to cloud.');
    }
  });

  els.conflictKeepRemoteBtn.addEventListener('click', async () => {
    if (!window.confirm('Discard unsynced local changes and load the cloud copy?')) return;
    try {
      await vaultSession.resolveConflict('keep_remote');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not load cloud vault copy.');
    }
  });

  // Composer & Edit-Modal shared draft surface wiring
  els.composerDescription.addEventListener('focus', () => {
    expandComposer();
  });

  const composerSurface = bindNoteDraftSurface({
    surfaceEl: els.noteComposer,
    descriptionEl: els.composerDescription,
    pinBtn: els.composerPinBtn,
    colorPickerEl: els.composerColorPicker,
    tagBtn: els.composerTagBtn,
    tagPopover: els.composerTagPopover,
    tagSearch: els.composerTagSearch,
    tagOptions: els.composerTagOptions,
    tagsRow: els.composerTagsRow,
    removeTagAttr: 'data-remove-composer-tag',
    imageBtn: els.composerImageBtn,
    imagePopover: els.composerImagePopover,
    imageStatus: els.composerImageStatus,
    uploadImageBtn: els.composerUploadImageBtn,
    imageFileInput: els.composerImageFileInput,
    imageUrlInput: els.composerImageUrlInput,
    addImageUrlBtn: els.composerAddImageUrlBtn,
    imagesRow: els.composerImagesRow,
    removeImageAttr: 'data-remove-composer-image',
    getDraft: () => state.composer,
    onBeforeAttachImage: expandComposer,
    onRenderTags: renderComposerTags,
    onRenderImages: renderComposerImages,
    onTagsChanged: renderSidebar,
    onUpdateColorDots: updateColorDots,
    onRenderTagPopoverOptions: renderTagPopoverOptions,
    onOpenLightbox: openLightbox,
  });

  const editModalSurface = bindNoteDraftSurface({
    surfaceEl: els.editModalCard,
    descriptionEl: els.editModalDescription,
    pinBtn: els.editModalPinBtn,
    colorPickerEl: els.editModalColorPicker,
    tagBtn: els.editModalTagBtn,
    tagPopover: els.editModalTagPopover,
    tagSearch: els.editModalTagSearch,
    tagOptions: els.editModalTagOptions,
    tagsRow: els.editModalTagsRow,
    removeTagAttr: 'data-remove-modal-tag',
    imageBtn: els.editModalImageBtn,
    imagePopover: els.editModalImagePopover,
    imageStatus: els.editModalImageStatus,
    uploadImageBtn: els.editModalUploadImageBtn,
    imageFileInput: els.editModalImageFileInput,
    imageUrlInput: els.editModalImageUrlInput,
    addImageUrlBtn: els.editModalAddImageUrlBtn,
    imagesRow: els.editModalImagesRow,
    removeImageAttr: 'data-remove-modal-image',
    getDraft: () => state.editingDraft,
    onRenderTags: renderEditModalTags,
    onRenderImages: renderEditModalImages,
    onTagsChanged: renderSidebar,
    onUpdateColorDots: updateColorDots,
    onRenderTagPopoverOptions: renderTagPopoverOptions,
    onOpenLightbox: openLightbox,
  });

  els.composerSaveBtn.addEventListener('click', () => {
    void saveComposerNote();
  });

  els.composerCancelBtn.addEventListener('click', () => {
    resetComposer();
    void vaultSession.flushPendingExternalUpdate();
  });

  document.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (state.composer.expanded && target && !els.noteComposer.contains(target)) {
      void saveComposerNote();
    }
    composerSurface.closePopoversIfOutside(target);
    editModalSurface.closePopoversIfOutside(target);
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
    if (shouldBypassCustomContextMenu(e, lockScreen.getOverlayEl())) return;
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
    const surface = !els.editModalBackdrop.classList.contains('hidden')
      ? editModalSurface
      : composerSurface;
    void surface.handleClipboardPaste(e);
  });

  els.closeLightboxBtn.addEventListener('click', () => {
    closeLightbox();
  });

  els.imageLightboxBackdrop.addEventListener('click', (e) => {
    if (e.target === els.imageLightboxBackdrop) {
      closeLightbox();
    }
  });

  els.editModalDeleteBtn.addEventListener('click', async () => {
    if (!state.editingNoteId) return;
    const deleted = await deleteNote(state.editingNoteId);
    if (deleted) {
      state.editingNoteId = null;
      state.editingDraft = null;
      els.editModalBackdrop.classList.add('hidden');
      await vaultSession.flushPendingExternalUpdate();
    }
  });

  els.editModalSaveBtn.addEventListener('click', () => {
    void saveAndCloseEditModal();
  });

  els.editModalBackdrop.addEventListener('click', (e) => {
    if (e.target === els.editModalBackdrop) {
      void saveAndCloseEditModal();
    }
  });

  els.encryptionBadge.addEventListener('click', () => vaultModal.open());
  els.topbarLockBtn.addEventListener('click', () => {
    if (state.passphrase) {
      void lockVault(true);
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const allowBtn = target?.closest<HTMLElement>('[data-allow-external-url]');
    if (!allowBtn) return;
    e.stopPropagation();
    const url = allowBtn.getAttribute('data-allow-external-url');
    if (!url) return;
    sessionAllowedExternalUrls.add(url);
    renderNotes();
    renderComposerImages();
    renderEditModalImages();
  });

  const recordUserActivity = (): void => {
    lastActivityAt = Date.now();
  };
  for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    document.addEventListener(evt, recordUserActivity, { passive: true });
  }
  window.setInterval(() => {
    if (
      state.passphrase &&
      state.autoLockMinutes > 0 &&
      Date.now() - lastActivityAt >= state.autoLockMinutes * 60_000
    ) {
      void lockVault(true, `Vault auto-locked after ${state.autoLockMinutes} minutes of inactivity.`);
    }
  }, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.lockOnHide && state.passphrase) {
      void lockVault(true, 'Vault locked when tab was hidden.');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (lockScreen.isOpen()) {
      return;
    }

    if (contextMenu.handleKeyDown(e)) {
      return;
    }

    if (e.key === 'Escape') {
      if (!els.imageLightboxBackdrop.classList.contains('hidden')) {
        closeLightbox();
        return;
      }
      if (boardEditor.handleEscapeKey()) {
        return;
      }
      if (!els.editModalBackdrop.classList.contains('hidden')) {
        void saveAndCloseEditModal();
      } else if (cloudWizard.isOpen()) {
        cloudWizard.close();
      } else if (vaultModal.isOpen()) {
        vaultModal.close();
      } else if (updatesController.isOpen()) {
        updatesController.close();
      } else if (state.composer.expanded) {
        void saveComposerNote();
      }
      return;
    }

    if (
      els.imageLightboxBackdrop.classList.contains('hidden') &&
      boardEditor.handleKeyDown(e)
    ) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      if (state.passphrase) {
        void lockVault(true);
      }
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
