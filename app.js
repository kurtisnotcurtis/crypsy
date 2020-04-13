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
    composerTagsRow: document.getElement