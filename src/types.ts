/**
 * Shared domain types for Crypsy Note.
 */

export type NoteColor =
  | 'default'
  | 'coral'
  | 'amber'
  | 'sage'
  | 'teal'
  | 'cobalt'
  | 'plum'
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
export type BoardInkTool = 'pen' | 'highlighter';
export type BoardGridStyle = 'dots' | 'grid' | 'ruled' | 'blank';

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

export interface BoardStrokeItem extends BoardItemBase {
  type: 'stroke';
  tool: BoardInkTool;
  /** CSS hex ink color or 'auto-ink' token (theme-adaptive dark/light ink) */
  strokeColor: string;
  /** Nominal base width in canvas px before pressure modulation */
  strokeWidth: number;
  /** Normalized opacity (1 for pen, ~0.4 for highlighter) */
  opacity?: number | undefined;
  /** Original stroke bounding box width for proportional vector scaling on resize */
  sourceWidth: number;
  /** Original stroke bounding box height for proportional vector scaling on resize */
  sourceHeight: number;
  /** Simplified stroke-local samples [x, y, pressure] */
  points: [number, number, number][];
}

export type BoardItem = BoardTextItem | BoardImageItem | BoardLinkItem | BoardStrokeItem;

export interface Board {
  id: string;
  title: string;
  tags: string[];
  pinned: boolean;
  color: NoteColor;
  gridStyle?: BoardGridStyle | undefined;
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
  autoLockMinutes: number;
  lockOnHide: boolean;
  blockExternalMedia: boolean;
  passphrase: string | null;
  lastEncryptedEnvelope: EncryptedEnvelope | null;
  selectedProviderId: CloudProviderId;
  composer: ComposerState;
  editingNoteId: string | null;
  editingDraft: EditingDraft | null;
  activeBoardId: string | null;
}
