import * as vscode from 'vscode';
import * as path from 'path';
import { Changelist, FileItem, FileStatus } from './types';
import { GitService } from './gitService';

export class ChangelistTreeItem extends vscode.TreeItem {
  constructor(public readonly changelist: Changelist, public readonly collapsibleState: vscode.TreeItemCollapsibleState, public readonly isActive: boolean = false) {
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
    this.iconPath = undefined; // Remove prefix icons from changelists

    // Display active changelist with a visual indicator (VS Code doesn't support bold text in tree items)
    if (isActive) {
      // Add "(active)" suffix to indicate active status
      this.label = `${changelist.name} (active)`;
    }
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
    this.iconPath = undefined; // Remove prefix icons

    // Resolve the file path relative to workspace root
    const fullPath = path.join(workspaceRoot, file.path);
    this.resourceUri = vscode.Uri.file(fullPath);

    // Add command to open diff on click
    this.command = {
      command: 'git-manager.openDiff',
      title: 'Open Diff',
      arguments: [this.resourceUri, file.status],
    };
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
  private context: vscode.ExtensionContext;
  private isRefreshing: boolean = false;
  private recentMoves: Map<string, { target: 'changelist' | 'unversioned'; changelistId?: string; timestamp: number }> = new Map(); // Track recent file moves to prevent overwriting
  private lastMoveTime: number = 0; // Track when last move happened to debounce refreshes
  private activeChangelistId: string | undefined; // ID of the currently active changelist

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
      // Only include files that are actually in changelists
      const fileAssignments: { [filePath: string]: string } = {};
      for (const changelist of this.changelists) {
        for (const file of changelist.files) {
          fileAssignments[file.path] = changelist.id;
        }
      }
      
      // Note: Files in unversionedFiles are NOT included in fileAssignments,
      // which means they won't be restored to changelists on next load

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

      // Preserve selection states and changelist assignments for all changelists
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
      for (const changelist of this.changelists) {
        for (const file of changelist.files) {
          selectionMap.set(file.id, file.isSelected);
          changelistAssignmentMap.set(file.id, changelist.id);
        }
      }

      // Also collect selection states from unversioned files
      // Track files that are explicitly in unversioned (changelistId is undefined)
      for (const file of this.unversionedFiles) {
        selectionMap.set(file.id, file.isSelected);
        // If file has no changelistId, it was explicitly moved to unversioned
        if (!file.changelistId) {
          filesToKeepInUnversioned.add(file.path);
        }
      }

      // Apply recent moves to assignment map (these take highest priority)
      for (const [filePath, move] of this.recentMoves.entries()) {
        const file = gitFiles.find((f) => f.path === filePath);
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
      const persistedState = this.context.workspaceState.get<import('./types').PersistedState>('changelists');
      if (persistedState && persistedState.fileAssignments) {
        // Get set of files currently in unversioned (by path)
        const unversionedFilePaths = new Set(this.unversionedFiles.map(f => f.path));
        
        // Merge persisted assignments only for files that don't have a current assignment
        // AND are not currently in unversioned files
        for (const [filePath, changelistId] of Object.entries(persistedState.fileAssignments)) {
          // Skip if file is currently in unversioned - it should stay there
          if (unversionedFilePaths.has(filePath)) {
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

      // Clear all changelists
      for (const changelist of this.changelists) {
        changelist.files = [];
      }

      // Use Set to track added files and prevent duplicates
      const addedFileIds = new Set<string>();

      // Distribute files to their assigned changelists
      gitFiles.forEach((file) => {
        // Skip if already added (prevent duplicates)
        if (addedFileIds.has(file.id)) {
          return;
        }

        // Restore selection state if it was previously selected
        if (selectionMap.has(file.id)) {
          file.isSelected = selectionMap.get(file.id)!;
        }

        // Only add files that are already tracked by Git
        if (file.status !== FileStatus.UNTRACKED) {
          // Check if file was explicitly moved to unversioned (should not be in changelist)
          if (filesToKeepInUnversioned.has(file.path)) {
            // Skip this file - it should remain in unversioned files
            // It will be handled in the unversioned files section below
            return;
          }

          const assignedChangelistId = changelistAssignmentMap.get(file.id);

          if (assignedChangelistId) {
            // File was previously assigned to a specific changelist
            const targetChangelist = this.changelists.find((c) => c.id === assignedChangelistId);
            if (targetChangelist) {
              file.changelistId = targetChangelist.id;
              targetChangelist.files.push(file);
              this.sortChangelistFiles(targetChangelist);
              addedFileIds.add(file.id);
            }
          } else {
            // New file - add to active changelist (or default if no active is set)
            const targetChangelist = this.activeChangelistId 
              ? this.changelists.find((c) => c.id === this.activeChangelistId)
              : this.changelists.find((c) => c.isDefault);
            if (targetChangelist) {
              file.changelistId = targetChangelist.id;
              targetChangelist.files.push(file);
              this.sortChangelistFiles(targetChangelist);
              addedFileIds.add(file.id);
            }
          }
        }
      });

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

      // Add untracked files from Git
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
        return new ChangelistTreeItem(changelist, vscode.TreeItemCollapsibleState.Expanded);
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
        items.push(new ChangelistTreeItem(changelist, collapsibleState, isActive));
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
        // If the file was untracked, add it to Git tracking
        if (wasUntracked) {
          try {
            await this.gitService.addFileToGit(file.path);
            // Update the file status to ADDED since it's now tracked
            file.status = FileStatus.ADDED;
          } catch (error) {
            console.error('Error adding file to Git:', error);
            // If adding to Git fails, put the file back in unversioned files
            this.unversionedFiles.push(file);
            this._onDidChangeTreeData.fire();
            return;
          }
        }

        file.changelistId = targetChangelistId;
        targetChangelist.files.push(file);
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

    // Only refresh if we actually changed Git state (added untracked file)
    // For moves between changelists, we don't need to refresh - just update UI state
    if (wasUntracked && file) {
      // Wait a bit for Git operation to complete, then refresh to sync with Git state
      setTimeout(async () => {
        try {
          // Save first to ensure persisted state is current
          await this.saveChangelists();
          // Then refresh to sync with Git
          await this.loadGitStatus();
          this._onDidChangeTreeData.fire();
        } catch (error) {
          console.error('Error refreshing after moving untracked file:', error);
        }
      }, 300);
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
    return this.changelists.map((changelist) => {
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
      const treeItem = new ChangelistTreeItem(changelist, collapsibleState, isActive);
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
    return new ChangelistTreeItem(changelist, collapsibleState, isActive);
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

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
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
