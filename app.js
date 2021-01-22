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

(() => {
  const STORAGE_KEY_VAULT = 'crypsy_encrypted_vault_v1';
  const STORAGE_KEY_PREFS = 'crypsy_ui_prefs_v1';
  const DEFAULT_DEVICE_SECRET = 'crypsy-local-device-default-key-v1';


  // Application State
  let state = {
    notes: [],
    tags: ['security', 'ideas', 'work', 'personal'],
    searchQuery: '',
    activeFilter: { type: 'all', tag: null },
    viewMode: 'grid',
    theme: 'dark',
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
  const SEED_NOTES = [
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
    sidebar: document.getElementById('sidebar'),
    sidebarToggleBtn: document.getElementById('sidebarToggleBtn'),
    sidebarTagsList: document.getElementById('sidebarTagsList'),
    newTagForm: document.getElementById('newTagForm'),
    newTagInput: document.getElementById('newTagInput'),
    countAll: document.getElementById('countAll'),
    countPinned: document.getElementById('countPinned'),

    searchInput: document.getElementById('searchInput'),
    clearSearchBtn: document.getElementById('clearSearchBtn'),
    cloudSetupBtn: document.getElementById('cloudSetupBtn'),
    cloudSetupBtnLabel: document.getElementById('cloudSetupBtnLabel'),
    viewToggleBtn: document.getElementById('viewToggleBtn'),
    viewIconList: document.getElementById('viewIconList'),
    viewIconGrid: document.getElementById('viewIconGrid'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    encryptionBadge: document.getElementById('encryptionBadge'),
    vaultBtn: document.getElementById('vaultBtn'),

    reconnectCloudBanner: document.getElementById('reconnectCloudBanner'),
    reconnectBannerMsg: document.getElementById('reconnectBannerMsg'),
    resumeCloudSyncBtn: document.getElementById('resumeCloudSyncBtn'),
    changeCloudFolderBtn: document.getElementById('changeCloudFolderBtn'),

    noteComposer: document.getElementById('noteComposer'),
    composerHeader: document.getElementById('composerHeader'),
    composerTitle: document.getElementById('composerTitle'),
    composerDescription: document.getElementById('composerDescription'),
    composerPinBtn: document.getElementById('composerPinBtn'),
    composerTagsRow: document.getElementById('composerTagsRow'),
    composerFooter: document.getElementById('composerFooter'),
    composerTagBtn: document.getElementById('composerTagBtn'),
    composerTagPopover: document.getElementById('composerTagPopover'),
    composerTagSearch: document.getElementById('composerTagSearch'),
    composerTagOptions: document.getElementById('composerTagOptions'),
    composerColorPicker: document.getElementById('composerColorPicker'),
    composerCancelBtn: document.getElementById('composerCancelBtn'),
    composerSaveBtn: document.getElementById('composerSaveBtn'),

    activeFilterBanner: document.getElementById('activeFilterBanner'),
    activeFilterText: document.getElementById('activeFilterText'),
    resetFilterBtn: document.getElementById('resetFilterBtn'),

    notesWorkspace: document.getElementById('notesWorkspace'),
    pinnedSection: document.getElementById('pinnedSection'),
    pinnedGrid: document.getElementById('pinnedGrid'),
    othersSection: document.getElementById('othersSection'),
    othersSectionLabel: document.getElementById('othersSectionLabel'),
    othersGrid: document.getElementById('othersGrid'),
    emptyState: document.getElementById('emptyState'),

    editModalBackdrop: document.getElementById('editModalBackdrop'),
    editModalCard: document.getElementById('editModalCard'),
    editModalTitle: document.getElementById('editModalTitle'),
    editModalDescription: document.getElementById('editModalDescription'),
    editModalPinBtn: document.getElementById('editModalPinBtn'),
    editModalTagsRow: document.getElementById('editModalTagsRow'),
    editModalTimestamp: document.getElementById('editModalTimestamp'),
    editModalTagBtn: document.getElementById('editModalTagBtn'),
    editModalTagPopover: document.getElementById('editModalTagPopover'),
    editModalTagSearch: document.getElementById('editModalTagSearch'),
    editModalTagOptions: document.getElementById('editModalTagOptions'),
    editModalColorPicker: document.getElementById('editModalColorPicker'),
    editModalDeleteBtn: document.getElementById('editModalDeleteBtn'),
    editModalSaveBtn: document.getElementById('editModalSaveBtn'),

    // Cloud Onboarding Wizard
    cloudOnboardingBackdrop: document.getElementById('cloudOnboardingBackdrop'),
    closeOnboardingBtn: document.getElementById('closeOnboardingBtn'),
    providerSelectionGrid: document.getElementById('providerSelectionGrid'),
    downloadPortableBtn: document.getElementById('downloadPortableBtn'),
    wizardToStep2Btn: document.getElementById('wizardToStep2Btn'),
    wizardBackToStep1Btn: document.getElementById('wizardBackToStep1Btn'),
    selectedProviderTitle: document.getElementById('selectedProviderTitle'),
    osPathHintCode: document.getElementById('osPathHintCode'),
    copyPathHintBtn: document.getElementById('copyPathHintBtn'),
    folderPickerHintText: document.getElementById('folderPickerHintText'),
    createCrypsySubfolderCb: document.getElementById('createCrypsySubfolderCb'),
    provisionPortableHtmlCb: document.getElementById('provisionPortableHtmlCb'),
    wizardStep2Error: document.getElementById('wizardStep2Error'),
    pickAndProvisionBtn: document.getElementById('pickAndProvisionBtn'),
    connectedProviderHeading: document.getElementById('connectedProviderHeading'),
    connectedFolderDetails: document.getElementById('connectedFolderDetails'),
    unlinkCloudFolderBtn: document.getElementById('unlinkCloudFolderBtn'),
    reprovisionAssetsBtn: document.getElementById('reprovisionAssetsBtn'),
    finishOnboardingBtn: document.getElementById('finishOnboardingBtn'),
    wizardStep1: document.getElementById('wizardStep1'),
    wizardStep2: document.getElementById('wizardStep2'),
    wizardStep3: document.getElementById('wizardStep3'),

    // Vault Inspector Modal
    vaultModalBackdrop: document.getElementById('vaultModalBackdrop'),
    closeVaultModalBtn: document.getElementById('closeVaultModalBtn'),
    vaultPassphraseInput: document.getElementById('vaultPassphraseInput'),
    updatePassphraseBtn: document.getElementById('updatePassphraseBtn'),
    lockVaultNowBtn: document.getElementById('lockVaultNowBtn'),
    ciphertextPreview: document.getElementById('ciphertextPreview'),
    exportEncryptedBtn: document.getElementById('exportEncryptedBtn'),
    importEncryptedInput: document.getElementById('importEncryptedInput'),

    lockScreenOverlay: document.getElementById('lockScreenOverlay'),
    unlockVaultForm: document.getElementById('unlockVaultForm'),
    unlockPassphraseInput: document.getElementById('unlockPassphraseInput'),
    unlockErrorMsg: document.getElementById('unlockErrorMsg'),
  };

  // Utility helpers
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function highlightText(text, query) {
    const safe = escapeHtml(text);
    if (!query || !query.trim()) return safe;
    const cleanQ = query.trim().replace(/^#/, '');
    if (!cleanQ) return safe;
    const escapedRegex = cleanQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedRegex})`, 'gi');
    return safe.replace(regex, '<mark class="search-highlight">$1</mark>');
  }

  function formatTimestamp(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, 32)}px`;
  }

  // Preferences
  function loadPreferences() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PREFS);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (prefs.viewMode === 'list' || prefs.viewMode === 'grid') {
        state.viewMode = prefs.viewMode;
      }
      if (prefs.theme === 'light' || prefs.theme === 'dark') {
        state.theme = prefs.theme;
      }
    } catch (e) {
      console.warn('Failed to load UI prefs:', e);
    }
  }

  function savePreferences() {
    localStorage.setItem(
      STORAGE_KEY_PREFS,
      JSON.stringify({
        viewMode: state.viewMode,
        theme: state.theme,
      })
    );
  }

  // Persistence & Cloud Sync
  async function persistEncryptedVault() {
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

  async function tryLoadEnvelope(envelope) {
    state.lastEncryptedEnvelope = envelope;
    localStorage.setItem(STORAGE_KEY_VAULT, JSON.stringify(envelope));
    try {
      const decrypted = await CrypsyCrypto.decryptPayload(envelope, state.passphrase);
      state.notes = Array.isArray(decrypted.notes) ? decrypted.notes : [];
      state.tags = Array.isArray(decrypted.tags) ? decrypted.tags : [];
      renderAll();
      return true;
    } catch (err) {
      els.lockScreenOverlay.classList.remove('hidden');
      els.unlockPassphraseInput.focus();
      return false;
    }
  }

  async function initVault() {
    loadPreferences();
    applyThemeUI();
    applyViewModeUI();

    // Listen for external cloud folder updates (e.g. synced from another device)
    CrypsyCloudSync.onExternalUpdate(async (externalEnvelope) => {
      await tryLoadEnvelope(externalEnvelope);
      updateCloudStatusUI();
    });

    // Check if a cloud folder was previously linked
    const cloudState = await CrypsyCloudSync.restoreSavedConnection();
    updateCloudStatusUI(cloudState);

    if (cloudState.status === 'connected') {
      const cloudEnvelope = await CrypsyCloudSync.readVaultFromCloudFolder();
      if (cloudEnvelope) {
        await tryLoadEnvelope(cloudEnvelope);
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
      const envelope = JSON.parse(storedRaw);
      await tryLoadEnvelope(envelope);
    } catch (e) {
      state.notes = SEED_NOTES;
      await persistEncryptedVault();
      renderAll();
    }
  }

  function updateCloudStatusUI(restoredState) {
    const meta = CrypsyCloudSync.getSavedProviderMeta();
    const isConnected = CrypsyCloudSync.isConnected() && (!restoredState || restoredState.status === 'connected');

    if (restoredState && restoredState.status === 'needs_permission' && meta) {
      els.reconnectBannerMsg.innerHTML = `Linked to <strong>${escapeHtml(meta.providerName)} (${escapeHtml(meta.folderName)})</strong>. Click to resume live auto-sync.`;
      els.reconnectCloudBanner.classList.remove('hidden');
      els.cloudSetupBtn.classList.remove('synced');
      els.cloudSetupBtnLabel.textContent = `Resume ${meta.providerName}`;
      return;
    }

    els.reconnectCloudBanner.classList.add('hidden');

    if (isConnected && meta) {
      els.cloudSetupBtn.classList.add('synced');
      els.cloudSetupBtnLabel.textContent = `${meta.providerName}: /${meta.folderName}`;
    } else {
      els.cloudSetupBtn.classList.remove('synced');
      els.cloudSetupBtnLabel.textContent = 'Setup Cloud Folder';
    }
  }

  // Theme & View Mode UI
  function applyThemeUI() {
    document.documentElement.setAttribute('data-theme', state.theme);
  }

  function applyViewModeUI() {
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

  // Filtering & Search
  function getFilteredNotes() {
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
        const tagMatch = (note.tags || []).some((t) =>
          t.toLowerCase().includes(cleanTagQuery)
        );
        return titleMatch || descMatch || tagMatch;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Render Functions
  function renderSidebar() {
    els.countAll.textContent = state.notes.length;
    els.countPinned.textContent = state.notes.filter((n) => n.pinned).length;

    document.querySelectorAll('.sidebar-nav > .nav-item').forEach((btn) => {
      const filterType = btn.getAttribute('data-filter-type');
      const isActive =
        state.activeFilter.type === filterType && !state.activeFilter.tag;
      btn.classList.toggle('active', isActive);
    });

    els.sidebarTagsList.innerHTML = state.tags
      .map((tag) => {
        const count = state.notes.filter((n) => n.tags.includes(tag)).length;
        const isActive =
          state.activeFilter.type === 'tag' && state.activeFilter.tag === tag;
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

  function renderFilterBanner() {
    const parts = [];
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

  function createNoteCardHtml(note) {
    const q = state.searchQuery;
    const titleHtml = note.title ? highlightText(note.title, q) : '';
    const descHtml = note.description ? highlightText(note.description, q) : '';

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

  function renderNotes() {
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

  function renderAll() {
    renderSidebar();
    renderFilterBanner();
    renderNotes();
    updateVaultInspectorUI();
  }

  // Composer Functions
  function expandComposer() {
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

  function resetComposer() {
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

  function renderComposerTags() {
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

  async function saveComposerNote() {
    const title = els.composerTitle.value.trim();
    const description = els.composerDescription.value.trim();
    if (!title && !description) {
      resetComposer();
      return;
    }

    const now = Date.now();
    const newNote = {
      id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
      tit