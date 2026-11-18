/**
 * Shared domain types for Crypsy Note.
 */

export type NoteColor =
  | 'default'
  | 'teal'
  | 'cobalt'
  | 'amber'
  | 'sage'
  | (string & {});

export interface NoteImage {
  id: string;
  src: string;
  alt?: string | undefined;
  sourceType: 'embedded' | 'external';
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  description: string;
  images?: NoteImage[];
  tags: string[];
  pinned: boolean;
  color: NoteColor;
  createdAt: number;
  updatedAt: number;
}

export interface BoardViewport {
  panX: number;
  panY: number;
  zoom: number;
}

export type BoardTextAlign = 'left' | 'center' | 'right';

export interface BoardItemBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height?: number | undefined;
  rotation: number;
  zIndex: number;
  color?: NoteColor | undefined;
}

export interface BoardTextItem extends BoardItemBase {
  type: 'text';
  content: string;
  align: BoardTextAlign;
  fontSize: number;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
}

export interface BoardImageItem extends BoardItemBase {
  type: 'image';
  image: NoteImage;
}

export interface BoardLinkItem extends BoardItemBase {
  type: 'link';
  url: string;
  label?: string | undefined;
  description?: string | undefined;
}

export type BoardItem = BoardTextItem | BoardImageItem | BoardLinkItem;

export interface Board {
  id: string;
  title: string;
  tags: string[];
  pinned: boolean;
  color: NoteColor;
  viewport: BoardViewport;
  items: BoardItem[];
  createdAt: number;
  updatedAt: number;
}

export interface VaultPayload {
  notes: Note[];
  tags: string[];
  boards?: Board[];
}

export interface EncryptedEnvelope {
  version: number;
  appVersion: string;
  cipher: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  updatedAt: string;
}

export type CloudProviderId =
  | 'gdrive'
  | 'onedrive'
  | 'dropbox'
  | 'icloud'
  | 'custom';

export type OsPlatform = 'windows' | 'mac' | 'linux';

export interface CloudProviderConfig {
  id: CloudProviderId;
  name: string;
  tagline: string;
  paths: Record<OsPlatform, string>;
  folderHint: string;
}

export interface CloudLocationInfo {
  isPortableFile: boolean;
  providerId: CloudProviderId | null;
  providerName: string | null;
  folderName: string;
  filePath: string;
}

export interface CloudProviderMeta {
  providerId: CloudProviderId;
  providerName: string;
  folderName: string;
  parentFolderName: string;
  linkedAt: string;
  lastSyncedAt: string | null;
}

export interface RestoreConnectionResult {
  status: 'connected' | 'needs_permission' | 'unlinked';
  meta: CloudProviderMeta | null;
}

export type ViewMode = 'grid' | 'list';
export type ThemeMode = 'dark' | 'light';

export type ActiveFilter =
  | { type: 'all' | 'pinned' | 'boards'; tag: null }
  | { type: 'tag'; tag: string };

export interface ComposerState {
  expanded: boolean;
  pinned: boolean;
  color: NoteColor;
  tags: string[];
  images: NoteImage[];
}

export interface EditingDraft {
  title: string;
  description: string;
  tags: string[];
  images: NoteImage[];
  pinned: boolean;
  color: NoteColor;
}

export interface AppState {
  notes: Note[];
  boards: Board[];
  tags: string[];
  searchQuery: string;
  activeFilter: ActiveFilter;
  viewMode: ViewMode;
  theme: ThemeMode;
  boardsSectionExpanded: boolean;
  tagsSectionExpanded: boolean;
  guideSectionExpanded: boolean;
  autoCheckUpdates: boolean;
  passphrase: string;
  lastEncryptedEnvelope: EncryptedEnvelope | null;
  selectedProviderId: CloudProviderId;
  composer: ComposerState;
  editingNoteId: string | null;
  editingDraft: EditingDraft | null;
  activeBoardId: string | null;
}
