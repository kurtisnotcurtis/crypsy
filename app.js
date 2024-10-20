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

  function updateColorDots(pickerEl, activeColor) {
    pickerEl.querySelectorAll('.color-dot').forEach((dot) => {
      dot.classList.toggle('active', dot.getAttribute('data-color') === activeColor);
    });
  }

  // Tag Popover Helper
  function renderTagPopoverOptions(optionsContainer, searchValue, selectedTags, onToggleTag) {
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

    optionsContainer.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        onToggleTag(cb.value);
      });
    });

    const createEl = optionsContainer.querySelector('[data-create-tag]');
    if (createEl) {
      createEl.addEventListener('click', () => {
        const newTag = createEl.getAttribute('data-create-tag');
        if (!state.tags.includes(newTag)) {
          state.tags.push(newTag);
        }
        onToggleTag(newTag);
      });
    }
  }

  // Edit Note Modal
  function openEditModal(noteId) {
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

  function renderEditModalTags() {
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

  async function saveAndCloseEditModal() {
    if (!state.editingNoteId || !state.editingDraft) {
      els.editModalBackdrop.classList.add('hidden');
      return;
    }

    const idx = state.notes.findIndex((n) => n.id === state.editingNoteId);
    if (idx !== -1) {
      const newTitle = els.editModalTitle.value.trim();
      const newDesc = els.editModalDescription.value.trim();
      const existing = state.notes[idx];

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
  function setWizardStep(stepNum) {
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
        CrypsyCloudSync.PROVIDERS[state.selectedProviderId] ||
        CrypsyCloudSync.PROVIDERS.custom;
      els.selectedProviderTitle.textContent = `Typical ${provider.name} Location on Your OS:`;
      els.osPathHintCode.textContent = CrypsyCloudSync.getProviderPathHint(
        state.selectedProviderId
      );
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

  function openCloudOnboardingModal() {
    const meta = CrypsyCloudSync.getSavedProviderMeta();
    if (CrypsyCloudSync.isConnected() && meta) {
      state.selectedProviderId = meta.providerId || 'onedrive';
      setWizardStep(3);
    } else {
      setWizardStep(1);
    }
    els.cloudOnboardingBackdrop.classList.remove('hidden');
  }

  function updateVaultInspectorUI() {
    if (!state.lastEncryptedEnvelope) return;
    els.ciphertextPreview.textContent = JSON.stringify(
      state.lastEncryptedEnvelope,
      null,
      2
    );
  }

  // Event Listeners
  function bindEvents() {
    // Sidebar toggle
    els.sidebarToggleBtn.addEventListener('click', () => {
      els.sidebar.classList.toggle('collapsed');
    });

    // Sidebar navigation (All / Pinned)
    document.querySelectorAll('.sidebar-nav > .nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-filter-type');
        state.activeFilter = { type, tag: null };
        renderAll();
      });
    });

    // Sidebar tags click & delete
    els.sidebarTagsList.addEventListener('click', async (e) => {
      const deleteBtn = e.target.closest('[data-delete-tag]');
      if (deleteBtn) {
        e.stopPropagation();
        const tagToDelete = deleteBtn.getAttribute('data-delete-tag');
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

      const tagItem = e.target.closest('[data-tag]');
      if (tagItem) {
        const tag = tagItem.getAttribute('data-tag');
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
      state.activeFilter = { type: 'all', tag: null };
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
      const card = e.target.closest('[data-provider]');
      if (!card) return;
      state.selectedProviderId = card.getAttribute('data-provider');
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
      const rawPath = els.osPathHintCode.textContent.split('   or   ')[0].trim();
      try {
        await navigator.clipboard.writeText(rawPath);
        els.copyPathHintBtn.textContent = 'Copied!';
        setTimeout(() => {
          els.copyPathHintBtn.textContent = 'Copy Path';
        }, 1500);
      } catch (e) {
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
        if (err && err.name === 'AbortError') return;
        els.wizardStep2Error.textContent =
          err.message || 'Could not link cloud folder.';
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

    els.composerPinBtn.addEventListener('click', () => {
      state.composer.pinned = !state.composer.pinned;
      els.composerPinBtn.classList.toggle('active', state.composer.pinned);
    });

    els.composerColorPicker.addEventListener('click', (e) => {
      const dot = e.target.closest('.color-dot');
      if (!dot) return;
      const color = dot.getAttribute('data-color');
      state.composer.color = color;
      els.noteComposer.setAttribute('data-color', color);
      updateColorDots(els.composerColorPicker, color);
    });

    // Composer Tag Popover
    const toggleComposerTag = (tag) => {
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
      const rmBtn = e.target.closest('[data-remove-composer-tag]');
      if (!rmBtn) return;
      const tag = rmBtn.getAttribute('data-remove-composer-tag');
      state.composer.tags = state.composer.tags.filter((t) => t !== tag);
      renderComposerTags();
    });

    els.composerSaveBtn.addEventListener('click', () => {
      saveComposerNote();
    });

    els.composerCancelBtn.addEventListener('click', () => {
      resetComposer();
    });

    // Click outside composer to auto-save
    document.addEventListener('click', (e) => {
      if (state.composer.expanded && !els.noteComposer.contains(e.target)) {
        saveComposerNote();
      }
      if (!els.composerTagPopover.contains(e.target) && e.target !== els.composerTagBtn) {
        els.composerTagPopover.classList.add('hidden');
      }
      if (!els.editModalTagPopover.contains(e.target) && e.target !== els.editModalTagBtn) {
        els.editModalTagPopover.classList.add('hidden');
      }
    });

    // Card interactions
    els.notesWorkspace.addEventListener('click', async (e) => {
      const pinBtn = e.target.closest('[data-toggle-pin]');
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

      const deleteBtn = e.target.closest('[data-delete-note]');
      if (deleteBtn) {
        e.stopPropagation();
        const id = deleteBtn.getAttribute('data-delete-note');
        state.notes = state.notes.filter((n) => n.id !== id);
        await persistEncryptedVault();
        renderAll();
        return;
      }

      const tagChip = e.target.closest('[data-filter-tag]');
      if (tagChip) {
        e.stopPropagation();
        const tag = tagChip.getAttribute('data-filter-tag');
        state.activeFilter = { type: 'tag', tag };
        renderAll();
        return;
      }

      const card = e.target.closest('.note-card');
      if (card) {
        openEditModal(card.getAttribute('data-note-id'));
      }
    });

    // Edit Modal interactions
    els.editModalDescription.addEventListener('input', () => {
      autoResizeTextarea(els.editModalDescription);
    });

    els.editModalPinBtn.addEventListener('click', () => {
      if (!state.editingDraft) return;
      state.editingDraft.pinned = !state.editingDraft.pinned;
      els.editModalPinBtn.classList.toggle('active', state.editingDraft.pinned);
    });

    els.editModalColorPicker.addEventListener('click', (e) => {
      const dot = e.target.closest('.color-dot');
      if (!dot || !state.editingDraft) return;
      const color = dot.getAttribute('data-color');
      state.editingDraft.color = color;
      els.editModalCard.setAttribute('data-color', color);
      updateColorDots(els.editModalColorPicker, color);
    });

    const toggleModalTag = (tag) => {
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
      const rmBtn = e.target.closest('[data-remove-modal-tag]');
      if (!rmBtn || !state.editingDraft) return;
      const tag = rmBtn.getAttribute('data-remove-modal-tag');
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
      saveAndCloseEditModal();
    });

    els.editModalBackdrop.addEventListener('click', (e) => {
      if (e.target === els.editModalBackdrop) {
        saveAndCloseEditModal();
      }
    });

    // Vault Inspector Modal
    const openVaultModal = () => {
      updateVaultInspectorUI();
      els.vaultModalBackdrop.classList.remove('hidden');
    };
    els.encryptionBadge.addEventListener('click', openVaultModal);
    els.vaultBtn.addEventListener('click', openVaultModal);

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
        const envelope = JSON.parse(storedRaw);
        const decrypted = await CrypsyCrypto.decryptPayload(envelope, attempt);
        state.passphrase = attempt;
        state.notes = decrypted.notes || [];
        state.tags = decrypted.tags || [];
        els.lockScreenOverlay.classList.add('hidden');
        els.unlockErrorMsg.classList.add('hidden');
        renderAll();
      } catch (err) {
        els.unlockErrorMsg.classList.remove('hidden');
      }
    });

    els.exportEncryptedBtn.addEventListener('click', () => {
      if (!state.lastEncryptedEnvelope) return;
      const blob = new Blob(
        [JSON.stringify(state.lastEncryptedEnvelope, null, 2)],
        { type: 'application/json' }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `crypsy-vault-${new Date().toISOString().slice(0, 10)}.crypsy.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    els.importEncryptedInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const envelope = JSON.parse(text);
        const ok = await tryLoadEnvelope(envelope);
        if (ok && CrypsyCloudSync.isConnected()) {
          await CrypsyCloudSync.writeVaultToCloudFolder(envelope);
        }
        els.vaultModalBackdrop.classList.add('hidden');
      } catch (err) {
        alert('Invalid .crypsy vault file.');
      } finally {
        els.importEncryptedInput.value = '';
      }
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!els.editModalBackdrop.classList.contains('hidden')) {
          saveAndCloseEditModal();
        } else if (!els.cloudOnboardingBackdrop.classList.contains('hidden')) {
          els.cloudOnboardingBackdrop.classList.add('hidden');
        } else if (!els.vaultModalBackdrop.classList.contains('hidden')) {
          els.vaultModalBackdrop.classList.add('hidden');
        } else if (state.composer.expanded) {
          saveComposerNote();
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
  initVault();
})();
