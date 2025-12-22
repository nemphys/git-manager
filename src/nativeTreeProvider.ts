import * as vscode from 'vscode';
import * as path from 'path';
import { Changelist, FileItem, FileStatus, Hunk } from './types';
import { GitService } from './gitService';

export class ChangelistTreeItem extends vscode.TreeItem {
  constructor(public readonly changelist: Changelist, public readonly collapsibleState: vscode.TreeItemCollapsibleState, public readonly isActive: boolean = false, public readonly colorIndex?: number) {
    super(changelist.name, collapsibleState);
    this.tooltip = changelist.description || changelist.name;
    this.description = `${changelist.files.length} files`;
    // Distinguish empty vs non-empty changelists for context menus
    // Also distinguish active vs non-active for context menus
    if (changelist.isDefault) {
      if (isActive) {
        this.contextValue = changelist.files.length > 0 ? 'defaultChangelistNonEmptyActive' : 'defaultChangelistActive';
      } else {
        this.contextValue = changelist.files.length > 0 ? 'defaultChangelistNonEmpty' : 'defaultChangelist';
      }
    } else {
      if (isActive) {
        this.contextValue = changelist.files.length > 0 ? 'changelistNonEmptyActive' : 'changelistActive';
      } else {
        this.contextValue = changelist.files.length > 0 ? 'changelistNonEmpty' : 'changelist';
      }
    }
    
    // Set colored icon based on changelist index
    // All changelists get a color: default gets 'default', others get their index
    const iconColorIndex = colorIndex !== undefined ? colorIndex : (changelist.isDefault ? 'default' : undefined);
    if (iconColorIndex !== undefined) {
      this.iconPath = this.createColoredIcon(iconColorIndex, isActive);
    } else {
      this.iconPath = undefined;
    }

    // Display active changelist with a visual indicator (VS Code doesn't support bold text in tree items)
    if (isActive) {
      // Add "(active)" suffix to indicate active status
      this.label = `${changelist.name} (active)`;
    }
  }

  private createColoredIcon(colorIndex: number | 'default', isActive: boolean): vscode.Uri {
    const colors = [
      '#4CAF50', // green
      '#2196F3', // blue
      '#FF9800', // orange
      '#9C27B0', // purple
      '#F44336', // red
      '#00BCD4', // cyan
      '#FFEB3B', // yellow
      '#795548', // brown
    ];
    
    // Use gray for default changelist, otherwise use color from array
    const color = colorIndex === 'default' ? '#9E9E9E' : colors[colorIndex % colors.length];
    
    // Create a small colored circle icon (filled for active, outlined for inactive)
    let svg: string;
    if (isActive) {
      // Filled circle for active changelist
      svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
          <circle cx="8" cy="8" r="6" fill="${color}" opacity="0.9"/>
        </svg>
      `;
    } else {
      // Hollow circle (outline) for non-active changelist
      svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
          <circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-width="2" opacity="0.9"/>
        </svg>
      `;
    }
    
    const encoded = Buffer.from(svg).toString('base64');
    return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
  }
}

export class FileTreeItem extends vscode.TreeItem {
  constructor(public readonly file: FileItem, public readonly workspaceRoot: string, public readonly changelistId?: string, public readonly isActive: boolean = false) {
    super(file.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = file.path;
    this.description = file.path; // Show relative project path instead of status
    // Use different context values:
    // - stagedFile/stagedFileActive: file in changelist and staged (green)
    // - unstagedFile/unstagedFileActive: file in changelist but unstaged (red)
    // - file: file in unversioned section
    if (changelistId) {
      if (isActive) {
        this.contextValue = file.isStaged ? 'stagedFileActive' : 'unstagedFileActive';
      } else {
        this.contextValue = file.isStaged ? 'stagedFile' : 'unstagedFile';
      }
    } else {
      this.contextValue = 'file';
    }

    // Set icon and color based on file status and staged state
    // For new files (ADDED status): show green "A" marker
    // For staged files: show green color via icon
    // Priority: new files get "A" marker, staged files get green circle
    if (file.status === FileStatus.ADDED) {
      // New files get a green "A" icon (even if staged)
      this.iconPath = this.createGreenAIcon();
    } else if (file.isStaged && changelistId) {
      // Staged files get a green filled circle icon to indicate they're staged
      this.iconPath = this.createGreenStagedIcon();
    } else {
      this.iconPath = undefined; // Remove prefix icons for other files
    }

    // Resolve the file path relative to workspace root
    const fullPath = path.join(workspaceRoot, file.path);
    this.resourceUri = vscode.Uri.file(fullPath);

    // Add command to open diff on click
    this.command = {
      command: 'git-manager.openDiff',
      title: 'Open Diff',
      arguments: [this.resourceUri, file.status, this.changelistId],
    };
  }

  private createGreenAIcon(): vscode.Uri {
    // Create a green "A" marker icon for new files
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
        <text x="8" y="13" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#4CAF50" text-anchor="middle" dominant-baseline="middle">A</text>
      </svg>
    `;
    const encoded = Buffer.from(svg).toString('base64');
    return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
  }

  private createGreenStagedIcon(): vscode.Uri {
    // Create a green filled circle icon for staged files to make them visually distinct
    // This provides a clear green visual indicator that the file is staged
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6" fill="#4CAF50" opacity="0.8"/>
      </svg>
    `;
    const encoded = Buffer.from(svg).toString('base64');
    return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
  }
}

export class UnversionedSectionTreeItem extends vscode.TreeItem {
  constructor(public readonly unversionedFiles: FileItem[], collapsibleState: vscode.TreeItemCollapsibleState) {
    super('Unversioned Files', collapsibleState);
    this.contextValue = 'unversionedSection';
    this.iconPath = undefined; // Remove prefix icon from unversioned files section
    this.description = `${unversionedFiles.length} files`;
  }
}

export class NativeTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<
    vscode.TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private _onForceExpand: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  readonly onForceExpand: vscode.Event<void> = this._onForceExpand.event;

  private _onChangelistCreated: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
  readonly onChangelistCreated: vscode.Event<string> = this._onChangelistCreated.event;

  private _onChangelistAutoExpand: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
  readonly onChangelistAutoExpand: vscode.Event<string> = this._onChangelistAutoExpand.event;

  // Drag and drop support
  readonly dropMimeTypes = [
    'application/vnd.code.tree.git-manager',
    'application/vnd.code.tree.git-manager.changelist',
  ];
  readonly dragMimeTypes = [
    'application/vnd.code.tree.git-manager',
    'application/vnd.code.tree.git-manager.changelist',
  ];

  private changelists: Changelist[] = [];
  private unversionedFiles: FileItem[] = [];
  private unversionedFilesExpanded: boolean = true; // Track unversioned files section expansion
  private gitService: GitService;
  private workspaceRoot: string;
  private previousHunksByFile: Map<string, Hunk[]> = new Map(); // Store previous hunks to detect extensions
  private context: vscode.ExtensionContext;
  private isRefreshing: boolean = false;
  private recentMoves: Map<string, { target: 'changelist' | 'unversioned'; changelistId?: string; timestamp: number }> = new Map(); // Track recent file moves to prevent overwriting
  private lastMoveTime: number = 0; // Track when last move happened to debounce refreshes
  private activeChangelistId: string | undefined; // ID of the currently active changelist
  private hunkAssignments: Map<string, string> = new Map(); // hunkId -> changelistId

  constructor(workspaceRoot: string, context: vscode.ExtensionContext) {
    this.workspaceRoot = workspaceRoot;
    this.context = context;
    this.gitService = new GitService(workspaceRoot);
    this.initializeDefaultChangelist();
  }

  private initializeDefaultChangelist() {
    const defaultChangelist: Changelist = {
      id: 'default',
      name: 'Changes',
      description: 'Default changelist',
      files: [],
      hunks: [],
      isDefault: true,
      isExpanded: false, // Start collapsed to match VS Code's default behavior
      createdAt: new Date(),
    };
    this.changelists = [defaultChangelist];
    // Set default changelist as active if no active changelist is set
    if (!this.activeChangelistId) {
      this.activeChangelistId = defaultChangelist.id;
    }
  }

  async loadPersistedChangelists(): Promise<void> {
    try {
      const persistedState = this.context.workspaceState.get<import('./types').PersistedState>('changelists');
      
      if (persistedState && persistedState.changelists && persistedState.changelists.length > 0) {
        // Restore changelists from persisted state
        this.changelists = persistedState.changelists.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          files: [], // Files will be loaded from Git status
          hunks: [], // Hunks will be loaded from Git status
          isDefault: p.isDefault,
          isExpanded: p.isExpanded ?? false,
          createdAt: new Date(p.createdAt),
        }));

        // Ensure default changelist exists
        const hasDefault = this.changelists.some((c) => c.isDefault);
        if (!hasDefault) {
          this.initializeDefaultChangelist();
        }

        // Restore active changelist ID, or default to the default changelist
        if (persistedState.activeChangelistId) {
          // Verify the active changelist still exists
          const activeChangelist = this.changelists.find((c) => c.id === persistedState.activeChangelistId);
          if (activeChangelist) {
            this.activeChangelistId = persistedState.activeChangelistId;
          } else {
            // Active changelist was deleted, default to default changelist
            const defaultChangelist = this.changelists.find((c) => c.isDefault);
            this.activeChangelistId = defaultChangelist?.id;
          }
        } else {
          // No active changelist persisted, default to default changelist
          const defaultChangelist = this.changelists.find((c) => c.isDefault);
          this.activeChangelistId = defaultChangelist?.id;
        }
      } else {
        // No persisted state, initialize default
        this.initializeDefaultChangelist();
        // Set default changelist as active
        const defaultChangelist = this.changelists.find((c) => c.isDefault);
        this.activeChangelistId = defaultChangelist?.id;
      }
    } catch (error) {
      console.error('Error loading persisted changelists:', error);
      // Fallback to default if loading fails
      this.initializeDefaultChangelist();
      const defaultChangelist = this.changelists.find((c) => c.isDefault);
      this.activeChangelistId = defaultChangelist?.id;
    }
  }

  async clearPersistedState(): Promise<void> {
    try {
      await this.context.workspaceState.update('changelists', undefined);
      // Reset to default changelist
      this.initializeDefaultChangelist();
      this.refresh();
    } catch (error) {
      console.error('Error clearing persisted state:', error);
      throw error;
    }
  }

  private async saveChangelists(): Promise<void> {
    try {
      // Build file assignments map (file path → changelist ID)
      // Only include files that are actually in changelists and have no hunks
      const fileAssignments: { [filePath: string]: string } = {};
      for (const changelist of this.changelists) {
        for (const file of changelist.files) {
          // Only save file-level assignments for files without hunks
          if (!file.hunks || file.hunks.length === 0) {
            fileAssignments[file.path] = changelist.id;
          }
        }
      }
      
      // Build hunk assignments map (hunk ID → changelist ID)
      const hunkAssignments: { [hunkId: string]: string } = {};
      for (const changelist of this.changelists) {
        for (const hunk of changelist.hunks) {
          if (hunk.changelistId) {
            hunkAssignments[hunk.id] = hunk.changelistId;
          }
        }
      }
      
      // Note: Files in changelists are saved in fileAssignments, including untracked files
      // that have been assigned to changelists. These will be restored on next load.

      // Convert changelists to serializable format
      const persistedChangelists = this.changelists.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        isDefault: c.isDefault ?? false,
        isExpanded: c.isExpanded,
        createdAt: c.createdAt.toISOString(),
      }));

      const persistedState: import('./types').PersistedState = {
        changelists: persistedChangelists,
        fileAssignments,
        hunkAssignments,
        activeChangelistId: this.activeChangelistId,
      };

      await this.context.workspaceState.update('changelists', persistedState);
    } catch (error) {
      // Log error but don't throw - persistence failures shouldn't block UI updates
      console.error('Error saving changelists:', error);
    }
  }

  // Non-blocking version for fire-and-forget persistence
  private saveChangelistsAsync(): void {
    this.saveChangelists().catch((error) => {
      console.error('Error in async saveChangelists:', error);
    });
  }

  async refresh(): Promise<void> {
    // Prevent concurrent refresh calls
    if (this.isRefreshing) {
      return;
    }

    // Debounce refreshes that happen immediately after a move (within 500ms)
    // This prevents file watcher from overwriting manual moves
    const timeSinceLastMove = Date.now() - this.lastMoveTime;
    if (timeSinceLastMove < 500) {
      // Delay the refresh slightly to allow the move to complete
      setTimeout(() => {
        this.refresh().catch((error) => {
          console.error('Error in debounced refresh:', error);
        });
      }, 500 - timeSinceLastMove);
      return;
    }

    this.isRefreshing = true;
    try {
      await this.loadGitStatus();
      // Fire with undefined to force full tree refresh and invalidate all cached items
      this._onDidChangeTreeData.fire(undefined);
    } finally {
      this.isRefreshing = false;
    }
  }

  // Removed expand all functionality

  collapseAll(): void {
    // Force all changelists to be collapsed by updating their collapsible state
    this.changelists.forEach((changelist) => {
      changelist.isExpanded = false;
    });

    // Also collapse unversioned files section
    this.unversionedFilesExpanded = false;

    // Fire tree data change with undefined to force full tree refresh
    this._onDidChangeTreeData.fire(undefined);
  }

  private async loadGitStatus(): Promise<void> {
    try {
      const gitFiles = await this.gitService.getStatus();
      const unversionedFiles = await this.gitService.getUnversionedFiles();
      const gitFilePaths = new Set(gitFiles.map(f => f.path));
      const unversionedFilePaths = new Set(unversionedFiles.map(f => f.path));
      // Create a combined set of all files that exist in git status (tracked or untracked)
      const allValidFilePaths = new Set([...gitFilePaths, ...unversionedFilePaths]);

      // Preserve selection states and changelist assignments for all changelists
      // BUT: Only preserve for files that still exist in git status
      const selectionMap = new Map<string, boolean>();
      const changelistAssignmentMap = new Map<string, string>();
      const filesToKeepInUnversioned = new Set<string>(); // Track files explicitly moved to unversioned

      // Clean up old recent moves (older than 2 seconds)
      const now = Date.now();
      for (const [filePath, move] of this.recentMoves.entries()) {
        if (now - move.timestamp > 2000) {
          this.recentMoves.delete(filePath);
        }
      }

      // Collect all current selection states and changelist assignments
      // Only preserve for files that still exist in git status (not reverted)
      for (const changelist of this.changelists) {
        for (const file of changelist.files) {
          // Only preserve state if file still exists in git status
          if (allValidFilePaths.has(file.path)) {
            selectionMap.set(file.id, file.isSelected);
            changelistAssignmentMap.set(file.id, changelist.id);
          }
        }
      }

      // Also collect selection states from unversioned files
      // Only preserve for files that still exist
      for (const file of this.unversionedFiles) {
        // Only preserve state if file still exists in git status
        if (allValidFilePaths.has(file.path)) {
          selectionMap.set(file.id, file.isSelected);
          // If file has no changelistId, it was explicitly moved to unversioned
          if (!file.changelistId) {
            filesToKeepInUnversioned.add(file.path);
          }
        }
      }

      // Load persisted hunk assignments
      const persistedState = this.context.workspaceState.get<import('./types').PersistedState>('changelists');
      this.hunkAssignments.clear();
      if (persistedState && persistedState.hunkAssignments) {
        for (const [hunkId, changelistId] of Object.entries(persistedState.hunkAssignments)) {
          this.hunkAssignments.set(hunkId, changelistId);
        }
      }

      // Parse hunks for all files and assign them to changelists
      const fileHunksMap = new Map<string, Hunk[]>(); // filePath -> hunks
      const currentHunkIds = new Set<string>();
      for (const file of gitFiles) {
        if (file.status !== FileStatus.UNTRACKED && file.status !== FileStatus.DELETED) {
          const unstagedHunks = await this.gitService.getFileHunks(file.path);
          const stagedHunks = await this.gitService.getStagedHunks(file.path);
          const allHunks = [...unstagedHunks, ...stagedHunks];
          
          // Get previous hunks for this file to detect extensions
          const previousHunks = this.previousHunksByFile.get(file.path) || [];
          
          // Assign hunks to changelists
          for (const hunk of allHunks) {
            currentHunkIds.add(hunk.id);
            const assignedChangelistId = this.hunkAssignments.get(hunk.id);
            if (assignedChangelistId) {
              // Hunk already has an assignment (persisted or previously assigned)
              hunk.changelistId = assignedChangelistId;
            } else {
              // New hunk - check if it's an extension of an existing hunk
              const extendedHunk = this.findExtendedHunk(hunk, previousHunks);
              if (extendedHunk) {
                // This hunk extends an existing hunk - keep it in the same changelist
                const extendedChangelistId = this.hunkAssignments.get(extendedHunk.id) || extendedHunk.changelistId;
                if (extendedChangelistId) {
                  hunk.changelistId = extendedChangelistId;
                  this.hunkAssignments.set(hunk.id, extendedChangelistId);
                } else {
                  // Fallback to active changelist
                  hunk.changelistId = this.activeChangelistId || 'default';
                  this.hunkAssignments.set(hunk.id, hunk.changelistId);
                }
              } else {
                // Truly new hunk - assign to active changelist
                hunk.changelistId = this.activeChangelistId || 'default';
                this.hunkAssignments.set(hunk.id, hunk.changelistId);
              }
            }
          }
          
          // Store current hunks as previous for next refresh
          this.previousHunksByFile.set(file.path, allHunks);
          
          file.hunks = allHunks;
          fileHunksMap.set(file.path, allHunks);
        }
      }

      // Clean up stale hunk assignments for hunks that no longer exist
      for (const hunkId of Array.from(this.hunkAssignments.keys())) {
        if (!currentHunkIds.has(hunkId)) {
          this.hunkAssignments.delete(hunkId);
        }
      }

      // Clean up previous hunks for files that no longer exist in Git status
      for (const filePath of Array.from(this.previousHunksByFile.keys())) {
        if (!gitFilePaths.has(filePath)) {
          this.previousHunksByFile.delete(filePath);
        }
      }

      // Apply recent moves to assignment map (these take highest priority)
      for (const [filePath, move] of this.recentMoves.entries()) {
        // Check both gitFiles and unversionedFiles (file might be in either)
        let file = gitFiles.find((f) => f.path === filePath);
        if (!file) {
          file = unversionedFiles.find((f) => f.path === filePath);
        }
        if (file) {
          if (move.target === 'changelist' && move.changelistId) {
            // File was recently moved to a changelist - override any other assignment
            changelistAssignmentMap.set(file.id, move.changelistId);
            filesToKeepInUnversioned.delete(filePath);
          } else if (move.target === 'unversioned') {
            // File was recently moved to unversioned - ensure it stays there
            filesToKeepInUnversioned.add(filePath);
            changelistAssignmentMap.delete(file.id);
          }
        }
      }

      // Load persisted file assignments if available (only as fallback for files not in current state)
      // BUT: Don't use persisted assignments for files that are currently in unversioned
      if (persistedState && persistedState.fileAssignments) {
        // Get set of files currently in unversioned (by path) - use the one from current unversionedFiles
        const currentUnversionedFilePaths = new Set(this.unversionedFiles.map(f => f.path));
        
        // Merge persisted assignments only for files that don't have a current assignment
        // AND are not currently in unversioned files
        // AND still exist in git status (not reverted)
        for (const [filePath, changelistId] of Object.entries(persistedState.fileAssignments)) {
          // Skip if file is currently in unversioned - it should stay there
          if (currentUnversionedFilePaths.has(filePath)) {
            continue;
          }
          
          // Skip if file no longer exists in git status (was reverted)
          if (!allValidFilePaths.has(filePath)) {
            continue;
          }
          
          // Find the file by path in gitFiles
          const file = gitFiles.find((f) => f.path === filePath);
          if (file && !changelistAssignmentMap.has(file.id)) {
            // Only use persisted assignment if file doesn't already have a current assignment
            // Also verify the changelist still exists
            const changelistExists = this.changelists.some((c) => c.id === changelistId);
            if (changelistExists) {
              changelistAssignmentMap.set(file.id, changelistId);
            }
          }
        }
      }

      // Clear all changelists and remove any files that no longer exist in git status
      for (const changelist of this.changelists) {
        changelist.files = [];
        changelist.hunks = [];
      }
      
      // Clean up persisted file assignments for files that no longer exist in git status
      if (persistedState && persistedState.fileAssignments) {
        const validPaths = new Set([...gitFilePaths, ...unversionedFilePaths]);
        const cleanedAssignments: Record<string, string> = {};
        for (const [filePath, changelistId] of Object.entries(persistedState.fileAssignments)) {
          if (validPaths.has(filePath)) {
            cleanedAssignments[filePath] = changelistId;
          }
        }
        // Update persisted state if it changed
        if (Object.keys(cleanedAssignments).length !== Object.keys(persistedState.fileAssignments || {}).length) {
          persistedState.fileAssignments = cleanedAssignments;
          await this.context.workspaceState.update('changelists', persistedState);
        }
      }

      // Distribute files to changelists based on their hunks
      // A file appears in a changelist if ANY of its hunks belong to that changelist
      for (const file of gitFiles) {
        // Restore selection state if it was previously selected
        if (selectionMap.has(file.id)) {
          file.isSelected = selectionMap.get(file.id)!;
        }

        // Only process files that are already tracked by Git
        if (file.status !== FileStatus.UNTRACKED) {
          // Check if file was explicitly moved to unversioned (should not be in changelist)
          if (filesToKeepInUnversioned.has(file.path)) {
            continue;
          }

          const hunks = fileHunksMap.get(file.path) || [];
          
          if (hunks.length > 0) {
            // File has hunks - assign to changelists based on hunk assignments
            const changelistIds = new Set<string>();
            for (const hunk of hunks) {
              if (hunk.changelistId) {
                changelistIds.add(hunk.changelistId);
              }
            }

            // File appears in ALL changelists that contain any of its hunks
            for (const changelistId of changelistIds) {
              const targetChangelist = this.changelists.find((c) => c.id === changelistId);
              if (targetChangelist) {
                // Create a copy of the file for this changelist
                const fileCopy = { ...file };
                fileCopy.changelistId = changelistId;
                targetChangelist.files.push(fileCopy);
                
                // Add hunks belonging to this changelist
                const changelistHunks = hunks.filter(h => h.changelistId === changelistId);
                targetChangelist.hunks.push(...changelistHunks);
              }
            }
          } else {
            // File has no hunks - use file-level assignment (backward compatibility)
            const assignedChangelistId = changelistAssignmentMap.get(file.id);

            if (assignedChangelistId) {
              // File was previously assigned to a specific changelist
              const targetChangelist = this.changelists.find((c) => c.id === assignedChangelistId);
              if (targetChangelist) {
                file.changelistId = targetChangelist.id;
                targetChangelist.files.push(file);
              }
            } else {
              // New file - add to active changelist (or default if no active is set)
              const targetChangelist = this.activeChangelistId 
                ? this.changelists.find((c) => c.id === this.activeChangelistId)
                : this.changelists.find((c) => c.isDefault);
              if (targetChangelist) {
                file.changelistId = targetChangelist.id;
                targetChangelist.files.push(file);
              }
            }
          }
        }
      }

      // Process untracked files - assign them to changelists if they have assignments
      for (const file of unversionedFiles) {
        // Restore selection state if it was previously selected
        if (selectionMap.has(file.id)) {
          file.isSelected = selectionMap.get(file.id)!;
        }

        // Check if file was explicitly moved to unversioned (should not be in changelist)
        if (filesToKeepInUnversioned.has(file.path)) {
          continue;
        }

        // Check if file has a changelist assignment (from recentMoves or persisted state)
        const assignedChangelistId = changelistAssignmentMap.get(file.id);
        
        if (assignedChangelistId) {
          // File was assigned to a changelist - add it there
          const targetChangelist = this.changelists.find((c) => c.id === assignedChangelistId);
          if (targetChangelist) {
            file.changelistId = targetChangelist.id;
            targetChangelist.files.push(file);
          }
        }
        // If no assignment, file will remain in unversionedFilesList (added below)
      }

      // Sort all changelists after loading
      for (const changelist of this.changelists) {
        this.sortChangelistFiles(changelist);
      }

      // Restore selection states for unversioned files
      // Filter out any unversioned files that are already in changelists (by path matching)
      const filesInChangelists = new Set<string>();
      for (const changelist of this.changelists) {
        for (const file of changelist.files) {
          filesInChangelists.add(file.path);
        }
      }

      // Also include tracked files that were explicitly moved to unversioned
      const unversionedFilesList: FileItem[] = [];
      
      // Add files from gitFiles that should be in unversioned (unstaged tracked files)
      gitFiles.forEach((file) => {
        if (filesToKeepInUnversioned.has(file.path) && !filesInChangelists.has(file.path)) {
          // Restore selection state
          if (selectionMap.has(file.id)) {
            file.isSelected = selectionMap.get(file.id)!;
          }
          file.changelistId = undefined; // Ensure no changelist assignment
          unversionedFilesList.push(file);
        }
      });

      // Add untracked files from Git that are not in any changelist
      unversionedFilesList.push(
        ...unversionedFiles
          .filter((file) => !filesInChangelists.has(file.path) && !filesToKeepInUnversioned.has(file.path))
          .map((file) => {
            if (selectionMap.has(file.id)) {
              file.isSelected = selectionMap.get(file.id)!;
            }
            return file;
          })
      );

      this.unversionedFiles = unversionedFilesList;

      // Sort all changelists after loading
      for (const changelist of this.changelists) {
        this.sortChangelistFiles(changelist);
      }
    } catch (error) {
      console.error('Error loading Git status:', error);
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    // Root items (changelists and unversioned section) have no parent
    if (element instanceof ChangelistTreeItem || element instanceof UnversionedSectionTreeItem) {
      return null;
    }

    // File items belong to their changelist
    if (element instanceof FileTreeItem && element.changelistId) {
      const changelist = this.changelists.find((c) => c.id === element.changelistId);
      if (changelist) {
        // Find the index of this changelist to determine color
        const index = this.changelists.findIndex(c => c.id === changelist.id);
        // Count non-default changelists before this one to get the color index
        const nonDefaultBefore = this.changelists.slice(0, index).filter(c => !c.isDefault).length;
        const colorIndex = changelist.isDefault ? undefined : nonDefaultBefore;
        return new ChangelistTreeItem(changelist, vscode.TreeItemCollapsibleState.Expanded, false, colorIndex);
      }
    }

    // Unversioned files belong to the unversioned section
    if (element instanceof FileTreeItem && !element.changelistId) {
      return new UnversionedSectionTreeItem(this.unversionedFiles, vscode.TreeItemCollapsibleState.Expanded);
    }

    return null;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // Root level - return only changelists and unversioned files section
      const items: vscode.TreeItem[] = [];

      // Sort changelists: active first, then others sorted ascending by name
      const sortedChangelists = [...this.changelists].sort((a, b) => {
        const aIsActive = a.id === this.activeChangelistId;
        const bIsActive = b.id === this.activeChangelistId;
        
        // Active changelist always comes first
        if (aIsActive && !bIsActive) return -1;
        if (!aIsActive && bIsActive) return 1;
        
        // For non-active changelists, sort by name ascending
        if (!aIsActive && !bIsActive) {
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        }
        
        return 0;
      });

      // Add changelists
      sortedChangelists.forEach((changelist) => {
        let collapsibleState: vscode.TreeItemCollapsibleState;

        if (changelist.files.length === 0) {
          collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (changelist.isExpanded === true) {
          collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        } else if (changelist.isExpanded === false) {
          collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        } else {
          // Default behavior - expand if has files
          collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }

        const isActive = changelist.id === this.activeChangelistId;
        // Count non-default changelists before this one to get the color index
        const changelistIndex = this.changelists.findIndex(c => c.id === changelist.id);
        const nonDefaultBefore = this.changelists.slice(0, changelistIndex).filter(c => !c.isDefault).length;
        const colorIndex = changelist.isDefault ? undefined : nonDefaultBefore;
        items.push(new ChangelistTreeItem(changelist, collapsibleState, isActive, colorIndex));
      });

      // Add unversioned files section if there are any
      if (this.unversionedFiles.length > 0) {
        const collapsibleState = this.unversionedFilesExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
        const unversionedSection = new UnversionedSectionTreeItem(this.unversionedFiles, collapsibleState);
        items.push(unversionedSection);
      }

      return items;
    }

    if (element instanceof ChangelistTreeItem) {
      // Return files in this changelist
      const isActive = element.changelist.id === this.activeChangelistId;
      return element.changelist.files.map((file) => new FileTreeItem(file, this.workspaceRoot, element.changelist.id, isActive));
    }

    if (element instanceof UnversionedSectionTreeItem) {
      // Return unversioned files (not in any changelist, so not active)
      return this.unversionedFiles.map((file) => new FileTreeItem(file, this.workspaceRoot));
    }

    return [];
  }


  async createChangelist(name: string): Promise<void> {
    const newChangelist: Changelist = {
      id: this.generateId(),
      name,
      files: [],
      hunks: [],
      isExpanded: true, // Start expanded by default for new changelists
      createdAt: new Date(),
    };

    this.changelists.push(newChangelist);
    
    // Emit event that a new changelist was created
    this._onChangelistCreated.fire(newChangelist.id);

    // Persist changelists first to ensure state is saved
    await this.saveChangelists();

    // Fire tree data change with undefined to force full tree refresh
    // Use setImmediate to ensure the event fires after the current execution context
    this._onDidChangeTreeData.fire(undefined);
    if (typeof setImmediate !== 'undefined') {
      setImmediate(() => {
        this._onDidChangeTreeData.fire(undefined);
      });
    } else {
      setTimeout(() => {
        this._onDidChangeTreeData.fire(undefined);
      }, 0);
    }

    // Persist changelists asynchronously (non-blocking)
    this.saveChangelistsAsync();
  }

  async deleteChangelist(changelistId: string): Promise<void> {
    const changelist = this.changelists.find((c) => c.id === changelistId);
    if (!changelist || changelist.isDefault) {
      return;
    }

    // If deleting the active changelist, switch to default
    if (this.activeChangelistId === changelistId) {
      const defaultChangelist = this.changelists.find((c) => c.isDefault);
      this.activeChangelistId = defaultChangelist?.id;
    }

    // Move files to active changelist (or default if no active is set)
    const targetChangelist = this.activeChangelistId 
      ? this.changelists.find((c) => c.id === this.activeChangelistId)
      : this.changelists.find((c) => c.isDefault);
    if (targetChangelist && changelist.files.length > 0) {
      targetChangelist.files.push(...changelist.files);
      this.sortChangelistFiles(targetChangelist);
    }

    this.changelists = this.changelists.filter((c) => c.id !== changelistId);
    
    // Persist changelists first to ensure state is saved
    await this.saveChangelists();
    
    // Fire tree data change with undefined to force full tree refresh
    // This is needed because deleting a changelist affects the root level and may change active status
    // Use setImmediate to ensure the event fires after the current execution context
    this._onDidChangeTreeData.fire(undefined);
    if (typeof setImmediate !== 'undefined') {
      setImmediate(() => {
        this._onDidChangeTreeData.fire(undefined);
      });
    } else {
      setTimeout(() => {
        this._onDidChangeTreeData.fire(undefined);
      }, 0);
    }

    // Persist changelists asynchronously (non-blocking)
    this.saveChangelistsAsync();
  }

  async renameChangelist(changelistId: string, newName: string): Promise<void> {
    const changelist = this.changelists.find((c) => c.id === changelistId);
    if (!changelist) {
      return;
    }

    // Check if the new name already exists
    const existingChangelist = this.changelists.find((c) => c.name === newName && c.id !== changelistId);
    if (existingChangelist) {
      throw new Error(`A changelist with the name "${newName}" already exists`);
    }

    changelist.name = newName;
    
    // Persist changelists first to ensure state is saved
    await this.saveChangelists();
    
    // Fire tree data change with undefined to force full tree refresh and invalidate all cached items
    // Use setImmediate to ensure the event fires after the current execution context
    this._onDidChangeTreeData.fire(undefined);
    if (typeof setImmediate !== 'undefined') {
      setImmediate(() => {
        this._onDidChangeTreeData.fire(undefined);
      });
    } else {
      setTimeout(() => {
        this._onDidChangeTreeData.fire(undefined);
      }, 0);
    }
  }

  async setActiveChangelist(changelistId: string): Promise<void> {
    const changelist = this.changelists.find((c) => c.id === changelistId);
    if (!changelist) {
      return;
    }

    this.activeChangelistId = changelistId;
    
    // Persist changelists first to ensure state is saved
    await this.saveChangelists();
    
    // Fire tree data change with undefined to force full tree refresh and invalidate all cached items
    // This ensures all tree items are recreated with updated context values (active/inactive)
    // Use setImmediate to ensure the event fires after the current execution context
    this._onDidChangeTreeData.fire(undefined);
    if (typeof setImmediate !== 'undefined') {
      setImmediate(() => {
        this._onDidChangeTreeData.fire(undefined);
      });
    } else {
      setTimeout(() => {
        this._onDidChangeTreeData.fire(undefined);
      }, 0);
    }
  }

  getActiveChangelistId(): string | undefined {
    return this.activeChangelistId;
  }

  async moveChangelistFiles(sourceChangelistId: string, targetChangelistId: string): Promise<void> {
    const sourceChangelist = this.changelists.find((c) => c.id === sourceChangelistId);
    const targetChangelist = this.changelists.find((c) => c.id === targetChangelistId);

    if (!sourceChangelist || !targetChangelist) {
      return;
    }

    // Move all files from source to target
    const filesToMove = [...sourceChangelist.files];
    sourceChangelist.files = [];

    // Update changelistId for all moved files
    filesToMove.forEach((file) => {
      file.changelistId = targetChangelistId;
    });

    // Add files to target changelist
    targetChangelist.files.push(...filesToMove);
    this.sortChangelistFiles(targetChangelist);

    // Auto-expand the target changelist to show the moved files
    targetChangelist.isExpanded = true;

    // Fire tree data change to update UI immediately
    this._onDidChangeTreeData.fire();

    // Persist changelists asynchronously (non-blocking)
    this.saveChangelistsAsync();
  }

  async moveFileToChangelist(fileId: string, targetChangelistId: string): Promise<void> {
    let sourceChangelist: Changelist | undefined;
    let file: FileItem | undefined;
    let wasUntracked = false;

    // Find the file in changelists
    for (const changelist of this.changelists) {
      const fileIndex = changelist.files.findIndex((f) => f.id === fileId);
      if (fileIndex !== -1) {
        sourceChangelist = changelist;
        file = changelist.files[fileIndex];
        changelist.files.splice(fileIndex, 1);
        break;
      }
    }

    // Find the file in unversioned files
    if (!file) {
      const fileIndex = this.unversionedFiles.findIndex((f) => f.id === fileId);
      if (fileIndex !== -1) {
        file = this.unversionedFiles[fileIndex];
        this.unversionedFiles.splice(fileIndex, 1);
        wasUntracked = true;
      }
    }

    if (file) {
      const targetChangelist = this.changelists.find((c) => c.id === targetChangelistId);
      if (targetChangelist) {
        // For untracked files, we don't add them to Git yet - that happens during commit
        // Just move them to the changelist and they'll be added to Git when committed
        // This ensures no auto-staging happens

        // If file has hunks, move all hunks from source changelist to target changelist
        if (file.hunks && file.hunks.length > 0 && sourceChangelist) {
          // Find all hunks of this file that belong to the source changelist
          const hunksToMove = file.hunks.filter(h => h.changelistId === sourceChangelist!.id);
          
          // Remove these hunks from source changelist
          sourceChangelist.hunks = sourceChangelist.hunks.filter(h => 
            !hunksToMove.some(ht => ht.id === h.id)
          );
          
          // Update hunk assignments to target changelist
          for (const hunk of hunksToMove) {
            hunk.changelistId = targetChangelistId;
          }
          
          // Add hunks to target changelist (merge with existing hunks from same file if any)
          targetChangelist.hunks.push(...hunksToMove);
          
          // If source changelist has no more hunks from this file, remove the file from source
          const remainingHunksInSource = file.hunks.filter(h => h.changelistId === sourceChangelist!.id);
          if (remainingHunksInSource.length === 0) {
            // File will be removed from source in the refresh
          } else {
            // File still has hunks in source, so it should remain there
            // Re-add it to source (it was removed above)
            sourceChangelist.files.push(file);
          }
          
          // Add file to target changelist (or keep it if it's already there)
          const fileExistsInTarget = targetChangelist.files.some(f => f.path === file!.path);
          if (!fileExistsInTarget) {
            const fileCopy = { ...file };
            fileCopy.changelistId = targetChangelistId;
            targetChangelist.files.push(fileCopy);
          }
        } else {
          // File has no hunks - use file-level assignment (backward compatibility)
          file.changelistId = targetChangelistId;
          targetChangelist.files.push(file);
        }

        this.sortChangelistFiles(targetChangelist);

        // Track this move to prevent it from being overwritten by immediate refreshes
        this.recentMoves.set(file.path, {
          target: 'changelist',
          changelistId: targetChangelistId,
          timestamp: Date.now(),
        });

        // Auto-expand the target changelist to show the moved file
        targetChangelist.isExpanded = true;

        // Emit event to force visual expansion
        this._onChangelistAutoExpand.fire(targetChangelistId);
      }
    }

    // Update last move time to debounce refreshes
    this.lastMoveTime = Date.now();

    // Persist changelists first to ensure state is saved
    await this.saveChangelists();

    // Fire tree data change to update UI
    // Use undefined to refresh the entire tree
    this._onDidChangeTreeData.fire(undefined);

    // Fire again after a small delay to ensure UI updates even if a refresh was queued
    setTimeout(() => {
      this._onDidChangeTreeData.fire(undefined);
    }, 50);

    // For untracked files, we don't modify Git state, so no need to refresh
    // The file assignment is already saved and will persist
    // For files with hunks, refresh to update file assignments based on hunk changes
    if (file && file.hunks && file.hunks.length > 0 && !wasUntracked) {
      // File has hunks - refresh to update file assignments based on hunk changes
      setTimeout(async () => {
        try {
          await this.loadGitStatus();
          this._onDidChangeTreeData.fire(undefined);
        } catch (error) {
          console.error('Error refreshing after moving file with hunks:', error);
        }
      }, 100);
    }
  }

  async moveFileToUnversioned(fileId: string): Promise<void> {
    let sourceChangelist: Changelist | undefined;
    let file: FileItem | undefined;

    // Find the file in changelists
    for (const changelist of this.changelists) {
      const fileIndex = changelist.files.findIndex((f) => f.id === fileId);
      if (fileIndex !== -1) {
        sourceChangelist = changelist;
        file = changelist.files[fileIndex];
        changelist.files.splice(fileIndex, 1);
        break;
      }
    }

    if (!file) {
      // File not found in any changelist
      return;
    }

    // Unstage the file if it's tracked by Git
    try {
      const isTracked = await this.gitService.isFileTracked(file.path);
      if (isTracked) {
        await this.gitService.unstageFile(file.path);
      }
    } catch (error) {
      console.error('Error unstaging file:', error);
      // Continue even if unstaging fails
    }

    // Clear changelist assignment
    file.changelistId = undefined;

    // Track this move to prevent it from being overwritten by immediate refreshes
    this.recentMoves.set(file.path, {
      target: 'unversioned',
      timestamp: Date.now(),
    });

    // Update last move time to debounce refreshes
    this.lastMoveTime = Date.now();

    // Add to unversioned files list
    this.unversionedFiles.push(file);

    // Persist changelists first to ensure state is saved
    await this.saveChangelists();

    // Fire tree data change to update UI
    // Use undefined to refresh the entire tree
    this._onDidChangeTreeData.fire(undefined);

    // Fire again after a small delay to ensure UI updates even if a refresh was queued
    setTimeout(() => {
      this._onDidChangeTreeData.fire(undefined);
    }, 50);

    // Persist changelists asynchronously (non-blocking)
    this.saveChangelistsAsync();

    // Refresh after a delay to get updated Git status (this will update file status correctly)
    // We delay to allow the Git unstage operation to complete and the UI to update first
    setTimeout(async () => {
      try {
        // Save first to ensure persisted state is current
        await this.saveChangelists();
        // Then refresh to sync with Git
        await this.loadGitStatus();
        this._onDidChangeTreeData.fire();
      } catch (error) {
        console.error('Error refreshing after moving file to unversioned:', error);
      }
    }, 300);
  }

  getSelectedFiles(): FileItem[] {
    // This method is kept for backward compatibility but is no longer used
    // File selection is now handled via VS Code's native tree selection
    return [];
  }

  getFilesFromChangelist(changelistId: string): FileItem[] {
    const changelist = this.changelists.find((c) => c.id === changelistId);
    return changelist ? [...changelist.files] : [];
  }

  getFilesFromTreeItems(treeItems: readonly vscode.TreeItem[]): FileItem[] {
    const files: FileItem[] = [];
    for (const item of treeItems) {
      if (item instanceof FileTreeItem) {
        files.push(item.file);
      }
    }
    return files;
  }


  getChangelists(): Changelist[] {
    return this.changelists;
  }

  getChangelistTreeItems(): ChangelistTreeItem[] {
    return this.changelists.map((changelist, index) => {
      let collapsibleState: vscode.TreeItemCollapsibleState;

      if (changelist.files.length === 0) {
        collapsibleState = vscode.TreeItemCollapsibleState.None;
      } else if (changelist.isExpanded === true) {
        collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      } else if (changelist.isExpanded === false) {
        collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      } else {
        // Default behavior - expand if has files
        collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      }

      const isActive = changelist.id === this.activeChangelistId;
      // Count non-default changelists before this one to get the color index
      const nonDefaultBefore = this.changelists.slice(0, index).filter(c => !c.isDefault).length;
      const colorIndex = changelist.isDefault ? undefined : nonDefaultBefore;
      const treeItem = new ChangelistTreeItem(changelist, collapsibleState, isActive, colorIndex);
      return treeItem;
    });
  }

  getChangelistTreeItemById(changelistId: string): ChangelistTreeItem | undefined {
    const changelist = this.changelists.find((c) => c.id === changelistId);
    if (!changelist) {
      return undefined;
    }

    let collapsibleState: vscode.TreeItemCollapsibleState;
    if (changelist.files.length === 0) {
      collapsibleState = vscode.TreeItemCollapsibleState.None;
    } else if (changelist.isExpanded === true) {
      collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    } else if (changelist.isExpanded === false) {
      collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    } else {
      // Default behavior - expand if has files
      collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }

    const isActive = changelist.id === this.activeChangelistId;
    // Find the index of this changelist to determine color
    const index = this.changelists.findIndex(c => c.id === changelistId);
    // Count non-default changelists before this one to get the color index
    const nonDefaultBefore = this.changelists.slice(0, index).filter(c => !c.isDefault).length;
    const colorIndex = changelist.isDefault ? undefined : nonDefaultBefore;
    return new ChangelistTreeItem(changelist, collapsibleState, isActive, colorIndex);
  }

  getUnversionedFiles(): FileItem[] {
    return this.unversionedFiles;
  }

  getAllFiles(): FileItem[] {
    const allFiles: FileItem[] = [];

    for (const changelist of this.changelists) {
      allFiles.push(...changelist.files);
    }

    allFiles.push(...this.unversionedFiles);

    return allFiles;
  }

  getHunkAssignments(): Map<string, string> {
    return new Map(this.hunkAssignments);
  }

  /**
   * Find if a new hunk extends an existing hunk (overlaps or is adjacent)
   * Returns the existing hunk if found, null otherwise
   * 
   * A hunk is considered an extension if:
   * - It overlaps with the old range (in HEAD) OR
   * - It overlaps with the new range (in working tree) OR
   * - It's very close to the previous hunk (within 3 lines)
   */
  private findExtendedHunk(newHunk: Hunk, previousHunks: Hunk[]): Hunk | null {
    const proximityThreshold = 3; // Lines - consider hunks within 3 lines as potentially related
    
    for (const prevHunk of previousHunks) {
      // Check if old ranges (HEAD) overlap
      const oldOverlaps = 
        newHunk.oldStart <= prevHunk.oldStart + prevHunk.oldLines &&
        newHunk.oldStart + newHunk.oldLines >= prevHunk.oldStart;
      
      // Check if new ranges (working tree) overlap
      const newOverlaps = 
        newHunk.newStart <= prevHunk.newStart + prevHunk.newLines &&
        newHunk.newStart + newHunk.newLines >= prevHunk.newStart;
      
      // Check if hunks are very close (within threshold)
      const oldStartClose = Math.abs(newHunk.oldStart - prevHunk.oldStart) <= proximityThreshold;
      const oldEndClose = Math.abs(
        (newHunk.oldStart + newHunk.oldLines) - (prevHunk.oldStart + prevHunk.oldLines)
      ) <= proximityThreshold;
      const newStartClose = Math.abs(newHunk.newStart - prevHunk.newStart) <= proximityThreshold;
      const newEndClose = Math.abs(
        (newHunk.newStart + newHunk.newLines) - (prevHunk.newStart + prevHunk.newLines)
      ) <= proximityThreshold;
      
      // If ranges overlap or are very close, consider it an extension
      if (oldOverlaps || newOverlaps || oldStartClose || oldEndClose || newStartClose || newEndClose) {
        return prevHunk;
      }
    }
    
    return null;
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  async moveHunkToChangelist(hunkId: string, targetChangelistId: string): Promise<void> {
    // Find the hunk in all changelists
    let hunk: Hunk | undefined;
    let sourceChangelist: Changelist | undefined;

    for (const changelist of this.changelists) {
      const foundHunk = changelist.hunks.find(h => h.id === hunkId);
      if (foundHunk) {
        hunk = foundHunk;
        sourceChangelist = changelist;
        break;
      }
    }

    if (!hunk || !sourceChangelist) {
      return;
    }

    const targetChangelist = this.changelists.find(c => c.id === targetChangelistId);
    if (!targetChangelist) {
      return;
    }

    // Remove hunk from source changelist
    sourceChangelist.hunks = sourceChangelist.hunks.filter(h => h.id !== hunkId);

    // Update hunk assignment
    hunk.changelistId = targetChangelistId;
    this.hunkAssignments.set(hunk.id, targetChangelistId);

    // Add hunk to target changelist
    targetChangelist.hunks.push(hunk);

    // Update file assignments - files appear in changelists based on their hunks
    // Refresh will handle this, but we need to update immediately for UI
    await this.saveChangelists();
    
    // Refresh to update file assignments
    await this.loadGitStatus();
    this._onDidChangeTreeData.fire(undefined);
  }

  getHunkAtLine(filePath: string, line: number): Hunk | null {
    // Find hunk that contains this line (line is 1-based)
    for (const changelist of this.changelists) {
      for (const hunk of changelist.hunks) {
        if (hunk.filePath === filePath) {
          const hunkStart = hunk.newStart;
          const hunkEnd = hunk.newStart + hunk.newLines - 1;
          if (line >= hunkStart && line <= hunkEnd) {
            return hunk;
          }
        }
      }
    }
    
    // Also check files for hunks that might not be in changelists yet
    for (const changelist of this.changelists) {
      for (const file of changelist.files) {
        if (file.path === filePath && file.hunks) {
          for (const hunk of file.hunks) {
            const hunkStart = hunk.newStart;
            const hunkEnd = hunk.newStart + hunk.newLines - 1;
            if (line >= hunkStart && line <= hunkEnd) {
              return hunk;
            }
          }
        }
      }
    }
    
    return null;
  }

  private sortChangelistFiles(changelist: Changelist): void {
    changelist.files.sort((a, b) => {
      // Sort by file name (case-insensitive)
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  // Drag and drop implementation
  async handleDrag(
    source: readonly vscode.TreeItem[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    const fileIds: string[] = [];
    const changelistIds: string[] = [];

    for (const item of source) {
      if (item instanceof FileTreeItem) {
        fileIds.push(item.file.id);
      } else if (item instanceof ChangelistTreeItem) {
        changelistIds.push(item.changelist.id);
      }
    }

    if (fileIds.length > 0) {
      dataTransfer.set('application/vnd.code.tree.git-manager', new vscode.DataTransferItem(fileIds));
    }

    if (changelistIds.length > 0) {
      dataTransfer.set(
        'application/vnd.code.tree.git-manager.changelist',
        new vscode.DataTransferItem(changelistIds)
      );
    }
  }

  async handleDrop(
    target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!target) {
      return;
    }

    // Check if dropping on unversioned files section
    if (target instanceof UnversionedSectionTreeItem) {
      // Handle file drops to unversioned section (unstaging)
      const fileTransferItem = dataTransfer.get('application/vnd.code.tree.git-manager');
      if (fileTransferItem) {
        try {
          const fileIds = fileTransferItem.value as string[];
          if (Array.isArray(fileIds)) {
            // Move each file to unversioned (unstage them)
            for (const fileId of fileIds) {
              await this.moveFileToUnversioned(fileId);
            }
          }
        } catch (error) {
          console.error('Error handling file drop to unversioned:', error);
        }
      }
      return;
    }

    let targetChangelistId: string;

    if (target instanceof ChangelistTreeItem) {
      // Dropping on a changelist - move files to that changelist
      targetChangelistId = target.changelist.id;
    } else if (target instanceof FileTreeItem) {
      // Dropping on a file - move files to the changelist containing the target file
      targetChangelistId = target.changelistId || 'default';
    } else {
      // Unknown target type
      return;
    }

    // Handle file drops
    const fileTransferItem = dataTransfer.get('application/vnd.code.tree.git-manager');
    if (fileTransferItem) {
      try {
        const fileIds = fileTransferItem.value as string[];
        if (Array.isArray(fileIds)) {
          // Move each file to the target changelist
          for (const fileId of fileIds) {
            await this.moveFileToChangelist(fileId, targetChangelistId);
          }
        }
      } catch (error) {
        console.error('Error handling file drop:', error);
      }
    }

    // Handle changelist drops
    const changelistTransferItem = dataTransfer.get('application/vnd.code.tree.git-manager.changelist');
    if (changelistTransferItem) {
      try {
        const changelistIds = changelistTransferItem.value as string[];
        if (Array.isArray(changelistIds)) {
          // Move all files from source changelists to target changelist
          for (const sourceChangelistId of changelistIds) {
            if (sourceChangelistId !== targetChangelistId) {
              // Don't move to self
              await this.moveChangelistFiles(sourceChangelistId, targetChangelistId);
            }
          }
        }
      } catch (error) {
        console.error('Error handling changelist drop:', error);
      }
    }

    // Auto-expand the target changelist to show the dropped files
    const targetChangelist = this.changelists.find((c) => c.id === targetChangelistId);
    if (targetChangelist && targetChangelist.files.length > 0) {
      targetChangelist.isExpanded = true;

      // Emit event to force visual expansion
      this._onChangelistAutoExpand.fire(targetChangelist.id);
    }
  }
}
