export interface Hunk {
  id: string;
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string; // hunk content preview
  changelistId?: string;
  isStaged: boolean;
}

export interface Changelist {
  id: string;
  name: string;
  description?: string;
  files: FileItem[];
  hunks: Hunk[]; // Track hunks in addition to files
  isDefault?: boolean;
  isExpanded?: boolean;
  createdAt: Date;
}

export interface FileItem {
  id: string;
  path: string;
  name: string;
  status: FileStatus;
  isSelected: boolean;
  changelistId?: string;
  relativePath: string;
  isStaged?: boolean; // Whether the file is staged (in index)
  hunks?: Hunk[]; // Optional hunks for this file
}

export enum FileStatus {
  MODIFIED = 'modified',
  ADDED = 'added',
  DELETED = 'deleted',
  UNTRACKED = 'untracked',
  RENAMED = 'renamed',
}

export interface CommitOptions {
  message: string;
  files: FileItem[];
  changelistId?: string;
}

export interface DragDropData {
  type: 'file' | 'changelist';
  id: string;
  sourceChangelistId?: string;
}

export interface CommitManagerState {
  changelists: Changelist[];
  unversionedFiles: FileItem[];
  selectedFiles: Set<string>;
  activeChangelistId?: string;
}

// Serializable format for persistence (Date objects converted to ISO strings)
export interface PersistedChangelist {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  isExpanded?: boolean;
  createdAt: string; // ISO string instead of Date
}

export interface PersistedState {
  changelists: PersistedChangelist[];
  fileAssignments: { [filePath: string]: string }; // file path → changelist ID
  hunkAssignments: { [hunkId: string]: string }; // hunk ID → changelist ID
  activeChangelistId?: string; // ID of the active changelist
}
