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
      const decrypted = await CrypsyCrypto.decryptPayload(envelo