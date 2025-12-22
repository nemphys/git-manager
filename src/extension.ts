// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { NativeTreeProvider, ChangelistTreeItem, FileTreeItem } from './nativeTreeProvider';
import { GitService } from './gitService';
import { FileItem, FileStatus, Hunk } from './types';
import { CommitUI } from './commitUI';
import { HunkDecorationProvider } from './hunkDecorations';
import { CommitDialog } from './commitDialog';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let treeProvider: NativeTreeProvider;
let treeView: vscode.TreeView<vscode.TreeItem>;
let gitService: GitService;
let commitStatusBarItem: vscode.StatusBarItem;
let commitMessageInput: vscode.StatusBarItem;
let isExpanded: boolean = false; // Track expand/collapse state
let commitUI: CommitUI;
let hunkDecorationProvider: HunkDecorationProvider;

// Helper function to create a filtered file version with only hunks from a specific changelist
async function createFilteredFileVersion(
  filePath: string,
  changelistId: string,
  workspaceRoot: string,
  gitService: GitService,
  treeProvider: NativeTreeProvider
): Promise<string | null> {
  try {
    // Get HEAD version of the file
    const { execSync } = require('child_process');
    let headContent: string;
    try {
      headContent = execSync(`git show HEAD:"${filePath}"`, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      // File might not exist in HEAD (new file), use empty content
      headContent = '';
    }

    // Get all hunks for the file
    const unstagedHunks = await gitService.getFileHunks(filePath);
    const stagedHunks = await gitService.getStagedHunks(filePath);
    const allHunks = [...unstagedHunks, ...stagedHunks];

    // Filter hunks to only those belonging to the specified changelist
    const hunkAssignments = treeProvider.getHunkAssignments();
    const filteredHunks = allHunks.filter(hunk => {
      const assignedChangelistId = hunkAssignments.get(hunk.id) || hunk.changelistId;
      return assignedChangelistId === changelistId;
    });

    if (filteredHunks.length === 0) {
      // No hunks in this changelist, return HEAD version
      const tempFile = path.join(os.tmpdir(), `git-manager-filtered-${Date.now()}-${path.basename(filePath)}`);
      fs.writeFileSync(tempFile, headContent);
      return tempFile;
    }

    // Sort hunks by oldStart (line numbers in HEAD version) in reverse order
    // We process from end to beginning to avoid line number shifts
    filteredHunks.sort((a, b) => b.oldStart - a.oldStart);

    // Apply hunks to HEAD content to create filtered version
    const headLines = headContent.split('\n');

    for (const hunk of filteredHunks) {
      // Parse hunk content to extract the actual changes
      const hunkLines = hunk.content.split('\n');
      const newLines: string[] = [];
      
      // Track context lines to match them with HEAD content
      let contextCount = 0;
      
      for (const line of hunkLines) {
        if (line.startsWith(' ')) {
          // Context line - matches HEAD, keep it
          newLines.push(line.substring(1));
          contextCount++;
        } else if (line.startsWith('-')) {
          // Deletion - skip this line from HEAD
          // Don't add to newLines
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          // Addition - add this line
          newLines.push(line.substring(1));
        }
      }

      // Calculate positions in HEAD version (0-based)
      const oldStartIndex = hunk.oldStart - 1;
      
      // Replace old lines with new lines
      headLines.splice(oldStartIndex, hunk.oldLines, ...newLines);
    }
    
    const filteredLines = headLines;

    // Create temporary file with filtered content
    const tempFile = path.join(os.tmpdir(), `git-manager-filtered-${Date.now()}-${path.basename(filePath)}`);
    fs.writeFileSync(tempFile, filteredLines.join('\n'));
    return tempFile;
  } catch (error) {
    console.error('Error creating filtered file version:', error);
    return null;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('No workspace folder found. Please open a folder to use the commit manager.');
  }

  if (workspaceRoot) {
    treeProvider = new NativeTreeProvider(workspaceRoot, context);
    gitService = new GitService(workspaceRoot);
    hunkDecorationProvider = new HunkDecorationProvider(gitService);

    // Load persisted changelists before refreshing
    await treeProvider.loadPersistedChangelists();
    
    // Update hunk decoration provider with initial changelists
    hunkDecorationProvider.updateChangelists(treeProvider.getChangelists());
    hunkDecorationProvider.updateHunkAssignments(treeProvider.getHunkAssignments());

    // Create the tree view
    treeView = vscode.window.createTreeView('git-manager.changelists', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
      canSelectMany: true, // Enable multi-selection for files
      dragAndDropController: treeProvider,
    });

    // Listen for selection changes to update status bar
    treeView.onDidChangeSelection(() => {
      updateAllCommitUI();
    });

    // Listen for tree data changes to update commit button context
    treeProvider.onDidChangeTreeData(() => {
      updateCommitButtonContext();
    });

    // Handle collapse all to toggle to expand all
    treeView.onDidCollapseElement((e) => {
      // When user manually collapses items, update our state and the changelist state
      if (e.element instanceof ChangelistTreeItem) {
        const changelistItem = e.element as ChangelistTreeItem;
        const changelist = treeProvider.getChangelists().find((c) => c.id === changelistItem.changelist.id);
        if (changelist) {
          changelist.isExpanded = false;
        }
      } else if (e.element.contextValue === 'unversionedSection') {
      }
      // Check if all changelists are collapsed
      const allCollapsed = treeProvider.getChangelists().every((c) => c.files.length === 0 || !c.isExpanded);
      isExpanded = !allCollapsed;
    });

    treeView.onDidExpandElement((e) => {
      // When user manually expands items, update our state and the changelist state
      if (e.element instanceof ChangelistTreeItem) {
        const changelistItem = e.element as ChangelistTreeItem;
        const changelist = treeProvider.getChangelists().find((c) => c.id === changelistItem.changelist.id);
        if (changelist) {
          changelist.isExpanded = true;
        }
      } else if (e.element.contextValue === 'unversionedSection') {
      }
      // Check if any changelist is expanded
      const anyExpanded = treeProvider.getChangelists().some((c) => c.files.length > 0 && c.isExpanded);
      isExpanded = anyExpanded;
    });


    // Removed force expand wiring

    // Listen for new changelist creation events
    treeProvider.onChangelistCreated(async (changelistId: string) => {
      try {
        setTimeout(async () => {
          const changelistItem = treeProvider.getChangelistTreeItemById(changelistId);
          if (changelistItem && changelistItem.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
            await treeView.reveal(changelistItem, { expand: true, select: false, focus: false });
          }
        }, 200);
      } catch (error) {
        // Silently handle errors
      }
    });

    // Listen for changelist auto-expand events (when files are moved/dropped)
    treeProvider.onChangelistAutoExpand(async (changelistId: string) => {
      try {
        setTimeout(async () => {
          const changelistItem = treeProvider.getChangelistTreeItemById(changelistId);
          if (changelistItem && changelistItem.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
            await treeView.reveal(changelistItem, { expand: true, select: false, focus: false });
          }
        }, 200);
      } catch (error) {
        // Silently handle errors
      }
    });

    // Create status bar items for commit functionality
    createCommitStatusBarItems();

    // Initialize commit button context
    updateCommitButtonContext();

    // Commit webview removed; commit via title button/status bar/command palette
  }

  // Function to update commit button context (no longer needed but kept for compatibility)
  function updateCommitButtonContext() {
    // Context is no longer used since we removed checkbox selection
    vscode.commands.executeCommand('setContext', 'git-manager.hasSelectedFiles', false);
  }

  // Register commands
  const commands = [
    vscode.commands.registerCommand('git-manager.open', () => {
      if (treeView) {
        // Focus on the tree view
        vscode.commands.executeCommand('git-manager.changelists.focus');
      }
    }),

    // Open a diff for a file from the tree
    vscode.commands.registerCommand('git-manager.openDiff', async (uri: vscode.Uri, fileStatus?: FileStatus, changelistId?: string) => {
      let tempEmptyFile: string | undefined;
      let tempHeadFile: string | undefined;
      try {
        const fileName = uri.fsPath.split('/').pop() || 'file';
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const relativePath = workspaceRoot ? vscode.workspace.asRelativePath(uri) : uri.fsPath;
        
        let left: vscode.Uri;
        let right: vscode.Uri;
        let title: string;

        // Determine file status if not provided
        let status = fileStatus;
        if (!status && gitService) {
          const files = await gitService.getStatus();
          const file = files.find(f => f.path === relativePath);
          status = file?.status;
        }

        // Handle deleted files: show HEAD version vs empty
        if (status === FileStatus.DELETED) {
          // For deleted files, we need to get the content from HEAD and create temp files
          // because the git scheme URI might not work when the file doesn't exist in working tree
          try {
            // Get file content from HEAD using git
            const { execSync } = require('child_process');
            // Use proper quoting to handle paths with spaces/special characters
            const headContent = execSync(`git show HEAD:"${relativePath}"`, {
              cwd: workspaceRoot,
              encoding: 'utf8',
              maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large files
            });
            
            // Create temporary file with HEAD content
            tempHeadFile = path.join(os.tmpdir(), `git-manager-head-${Date.now()}-${fileName}`);
            fs.writeFileSync(tempHeadFile, headContent);
            left = vscode.Uri.file(tempHeadFile);
            
            // Create temporary empty file for right side
            tempEmptyFile = path.join(os.tmpdir(), `git-manager-empty-${Date.now()}-${fileName}`);
            fs.writeFileSync(tempEmptyFile, '');
            right = vscode.Uri.file(tempEmptyFile);
            
            title = `${fileName} (HEAD → Deleted)`;
          } catch (gitError) {
            // Fallback: try git scheme URI approach
            left = vscode.Uri.from({
              scheme: 'git',
              path: uri.fsPath,
              query: JSON.stringify({ path: relativePath, ref: 'HEAD' }),
            });
            
            tempEmptyFile = path.join(os.tmpdir(), `git-manager-empty-${Date.now()}-${fileName}`);
            fs.writeFileSync(tempEmptyFile, '');
            right = vscode.Uri.file(tempEmptyFile);
            
            title = `${fileName} (HEAD → Deleted)`;
          }
        }
        // Handle new/untracked files: show empty vs working tree version
        else if (status === FileStatus.ADDED || status === FileStatus.UNTRACKED) {
          // Left side: create a temporary empty file for comparison
          tempEmptyFile = path.join(os.tmpdir(), `git-manager-empty-${Date.now()}-${fileName}`);
          fs.writeFileSync(tempEmptyFile, '');
          left = vscode.Uri.file(tempEmptyFile);
          
          // Right side: working tree version
          right = uri;
          
          title = `${fileName} (New File)`;
        }
        // Handle modified files: show HEAD vs working tree (normal case)
        else {
          // Build a proper git-scheme URI with JSON query as expected by Git extension
          left = vscode.Uri.from({
            scheme: 'git',
            path: uri.fsPath,
            query: JSON.stringify({ path: uri.fsPath, ref: 'HEAD' }),
          });

          // If changelistId is provided, create a filtered version with only hunks from that changelist
          if (changelistId && treeProvider && workspaceRoot) {
            try {
              const filteredFile = await createFilteredFileVersion(relativePath, changelistId, workspaceRoot, gitService, treeProvider);
              if (filteredFile) {
                right = vscode.Uri.file(filteredFile);
                const changelist = treeProvider.getChangelists().find(c => c.id === changelistId);
                const changelistName = changelist ? changelist.name : 'Changelist';
                title = `${fileName} (HEAD ↔︎ ${changelistName})`;
                // Store temp file for cleanup (reuse tempEmptyFile variable)
                tempEmptyFile = filteredFile;
              } else {
                right = uri; // fallback to full working tree
                title = `${fileName} (HEAD ↔︎ Working Tree)`;
              }
            } catch (error) {
              console.error('Error creating filtered file version:', error);
              right = uri; // fallback to full working tree
              title = `${fileName} (HEAD ↔︎ Working Tree)`;
            }
          } else {
            right = uri; // working tree
            title = `${fileName} (HEAD ↔︎ Working Tree)`;
          }
        }

        await vscode.commands.executeCommand('vscode.diff', left, right, title);
        
        // Clean up temp files after a delay to ensure VS Code has read them
        const cleanupTempFiles = () => {
          if (tempEmptyFile) {
            try {
              if (fs.existsSync(tempEmptyFile)) {
                fs.unlinkSync(tempEmptyFile);
              }
            } catch (e) {
              // Ignore cleanup errors
            }
          }
          if (tempHeadFile) {
            try {
              if (fs.existsSync(tempHeadFile)) {
                fs.unlinkSync(tempHeadFile);
              }
            } catch (e) {
              // Ignore cleanup errors
            }
          }
        };
        
        setTimeout(cleanupTempFiles, 1000); // 1 second delay should be enough for VS Code to read the files
      } catch (error) {
        // Clean up temp files if they exist
        if (tempEmptyFile && fs.existsSync(tempEmptyFile)) {
          try {
            fs.unlinkSync(tempEmptyFile);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
        if (tempHeadFile && fs.existsSync(tempHeadFile)) {
          try {
            fs.unlinkSync(tempHeadFile);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
        
        // Fallback to open if diff fails
        try {
          // Only try to open if file exists
          if (fileStatus !== FileStatus.DELETED && fs.existsSync(uri.fsPath)) {
            await vscode.commands.executeCommand('vscode.open', uri);
          } else if (fileStatus === FileStatus.DELETED) {
            vscode.window.showInformationMessage(`File ${uri.fsPath.split('/').pop()} was deleted. Showing diff from HEAD.`);
          } else {
            vscode.window.showErrorMessage(`Could not open diff: ${error}`);
          }
        } catch (openError) {
          vscode.window.showErrorMessage(`Could not open diff: ${error}`);
        }
      }
    }),

    // Open the source file from a file item context menu
    vscode.commands.registerCommand('git-manager.openFile', async (arg?: any) => {
      try {
        let targetUri: vscode.Uri | undefined;
        if (arg && arg.resourceUri) {
          targetUri = arg.resourceUri as vscode.Uri;
        } else if (arg instanceof vscode.Uri) {
          targetUri = arg;
        }
        if (!targetUri) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            targetUri = editor.document.uri;
          }
        }
        if (targetUri) {
          await vscode.commands.executeCommand('vscode.open', targetUri);
        } else {
          vscode.window.showInformationMessage('No file to open.');
        }
      } catch (e) {
        // ignore
      }
    }),

    vscode.commands.registerCommand('git-manager.createChangelist', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter changelist name',
        placeHolder: 'e.g., Feature X',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Changelist name cannot be empty';
          }
          if (treeProvider.getChangelists().some((c) => c.name === value.trim())) {
            return 'Changelist with this name already exists';
          }
          return null;
        },
      });

      if (name) {
        await treeProvider.createChangelist(name.trim());
        // The createChangelist method already fires the tree data change event
        // Force a microtask delay to ensure VS Code processes the update
        await new Promise(resolve => setImmediate(resolve));
        updateAllCommitUI();
      }
    }),

    vscode.commands.registerCommand('git-manager.deleteChangelist', async (changelistItem?: any) => {
      let changelistId: string;
      let changelistName: string;

      if (changelistItem && changelistItem.changelist) {
        // Called from inline context menu - changelistItem is a ChangelistTreeItem
        changelistId = changelistItem.changelist.id;
        changelistName = changelistItem.changelist.name;
      } else {
        // Called from command palette or other places - show selection dialog
        const changelists = treeProvider.getChangelists().filter((c) => !c.isDefault);
        if (changelists.length === 0) {
          vscode.window.showInformationMessage('No custom changelists to delete.');
          return;
        }

        const options = changelists.map((c) => ({ label: c.name, value: c.id }));
        const selected = await vscode.window.showQuickPick(options, {
          placeHolder: 'Select changelist to delete',
        });

        if (!selected) {
          return;
        }

        changelistId = selected.value;
        changelistName = selected.label;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete changelist "${changelistName}"?`,
        { modal: true },
        'Delete'
      );

      if (confirm === 'Delete') {
        await treeProvider.deleteChangelist(changelistId);
        // The deleteChangelist method already fires the tree data change event
        // Force a microtask delay to ensure VS Code processes the update
        await new Promise(resolve => setImmediate(resolve));
        updateAllCommitUI();
      }
    }),

    vscode.commands.registerCommand('git-manager.renameChangelist', async (changelistItem?: any) => {
      let changelistId: string;
      let currentName: string;

      if (changelistItem && changelistItem.changelist) {
        // Called from inline context menu - changelistItem is a ChangelistTreeItem
        changelistId = changelistItem.changelist.id;
        currentName = changelistItem.changelist.name;
      } else {
        // Called from command palette or other places - show selection dialog
        const changelists = treeProvider.getChangelists();
        if (changelists.length === 0) {
          vscode.window.showInformationMessage('No changelists to rename.');
          return;
        }

        const options = changelists.map((c) => ({ label: c.name, value: c.id }));
        const selected = await vscode.window.showQuickPick(options, {
          placeHolder: 'Select changelist to rename',
        });

        if (!selected) {
          return;
        }

        changelistId = selected.value;
        currentName = selected.label;
      }

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new changelist name',
        placeHolder: 'Enter new name...',
        value: currentName,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Changelist name cannot be empty';
          }
          if (treeProvider.getChangelists().some((c) => c.name === value.trim() && c.id !== changelistId)) {
            return 'Changelist with this name already exists';
          }
          return null;
        },
      });

      if (newName && newName.trim() !== currentName) {
        try {
          await treeProvider.renameChangelist(changelistId, newName.trim());
          vscode.window.showInformationMessage(`Changelist renamed to "${newName.trim()}"`);
          // The renameChangelist method already fires the tree data change event
          // Force a microtask delay to ensure VS Code processes the update
          await new Promise(resolve => setImmediate(resolve));
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to rename changelist: ${error}`);
        }
      }
    }),

    vscode.commands.registerCommand('git-manager.setActiveChangelist', async (changelistItem?: any) => {
      let changelistId: string;

      if (changelistItem && changelistItem.changelist) {
        // Called from inline context menu - changelistItem is a ChangelistTreeItem
        changelistId = changelistItem.changelist.id;
      } else {
        // Called from command palette or other places - show selection dialog
        const changelists = treeProvider.getChangelists();
        if (changelists.length === 0) {
          vscode.window.showInformationMessage('No changelists available.');
          return;
        }

        const options = changelists.map((c) => ({ 
          label: c.name, 
          value: c.id,
          description: c.id === treeProvider.getActiveChangelistId() ? 'Active' : undefined
        }));
        const selected = await vscode.window.showQuickPick(options, {
          placeHolder: 'Select changelist to set as active',
        });

        if (!selected) {
          return;
        }

        changelistId = selected.value;
      }

      try {
        await treeProvider.setActiveChangelist(changelistId);
        const changelist = treeProvider.getChangelists().find((c) => c.id === changelistId);
        vscode.window.showInformationMessage(`Active changelist set to "${changelist?.name || changelistId}"`);
        // The setActiveChangelist method already fires the tree data change event
        // Force a microtask delay to ensure VS Code processes the update
        await new Promise(resolve => setImmediate(resolve));
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to set active changelist: ${error}`);
      }
    }),

    // Commit changelist - commits all files in a changelist (only for active changelist)
    vscode.commands.registerCommand('git-manager.commitChangelist', async (changelistItem?: any) => {
      let changelistId: string;

      if (changelistItem && changelistItem.changelist) {
        // Called from context menu - changelistItem is a ChangelistTreeItem
        changelistId = changelistItem.changelist.id;
      } else {
        vscode.window.showWarningMessage('This command must be invoked from a changelist context menu.');
        return;
      }

      // Verify this is the active changelist
      const activeChangelistId = treeProvider.getActiveChangelistId();
      if (changelistId !== activeChangelistId) {
        vscode.window.showWarningMessage('Commit is only available for the active changelist. Please set this changelist as active first.');
        return;
      }

      const files = treeProvider.getFilesFromChangelist(changelistId);
      if (files.length === 0) {
        vscode.window.showWarningMessage('No files in this changelist to commit.');
        return;
      }

      // Pre-select all files
      const preSelectedFileIds = files.map(f => f.id);

      // Open commit dialog
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace root found.');
        return;
      }
      const hunkAssignments = treeProvider.getHunkAssignments();
      const dialog = new CommitDialog(files, preSelectedFileIds, workspaceRoot, gitService, activeChangelistId, hunkAssignments);
      const result = await dialog.show();

      if (result) {
        // Filter files to only selected ones
        let selectedFiles = files.filter(f => result.selectedFiles.includes(f.id));
        
        // Load hunks for files that don't have them
        for (const file of selectedFiles) {
          if (!file.hunks || file.hunks.length === 0) {
            const unstagedHunks = await gitService.getFileHunks(file.path);
            const stagedHunks = await gitService.getStagedHunks(file.path);
            file.hunks = [...unstagedHunks, ...stagedHunks];
          }
        }
        
        // For files with selected hunks, update the file's hunks to only include selected ones
        // Also filter out files that have hunks but no selected hunks
        selectedFiles = selectedFiles.filter(file => {
          const selectedHunkIds = result.selectedHunks[file.id] || [];
          if (file.hunks && file.hunks.length > 0) {
            // File has hunks - only include if some hunks are selected
            if (selectedHunkIds.length > 0) {
              file.hunks = file.hunks.filter(h => selectedHunkIds.includes(h.id));
              return true;
            }
            return false; // File has hunks but none selected - skip it
          }
          // File has no hunks - include it (will commit whole file)
          return true;
        });

        if (selectedFiles.length === 0) {
          vscode.window.showWarningMessage('No files or hunks selected for commit.');
          return;
        }

        const success = await gitService.commitFiles(selectedFiles, result.message, { 
          amend: result.amend, 
          changelistId: activeChangelistId 
        });

        if (success) {
          vscode.window.showInformationMessage(`Successfully committed ${selectedFiles.length} file(s)`);
          treeProvider.refresh();
          updateAllCommitUI();
        } else {
          vscode.window.showErrorMessage('Failed to commit files. Check the output panel for details.');
        }
      }
    }),

    // Commit files - commits selected/highlighted files from the tree view (only files in active changelist)
    vscode.commands.registerCommand('git-manager.commitFiles', async () => {
      // Get selected items from the tree view
      const selectedItems = treeView.selection;
      if (selectedItems.length === 0) {
        vscode.window.showWarningMessage('No files selected. Please select files from the tree view first.');
        return;
      }

      // Extract FileItem objects from selected tree items
      const selectedFiles = treeProvider.getFilesFromTreeItems(selectedItems);
      if (selectedFiles.length === 0) {
        vscode.window.showWarningMessage('No files selected for commit. Please select file items from the tree view.');
        return;
      }

      // Filter to only files in the active changelist
      const activeChangelistId = treeProvider.getActiveChangelistId();
      if (!activeChangelistId) {
        vscode.window.showWarningMessage('No active changelist. Please set a changelist as active first.');
        return;
      }
      const selectedFilesInChangelist = selectedFiles.filter((file) => file.changelistId === activeChangelistId);
      
      if (selectedFilesInChangelist.length === 0) {
        vscode.window.showWarningMessage('No files from the active changelist selected. Please select files from the active changelist.');
        return;
      }

      // Get all files from the active changelist (to show in dialog)
      const allChangelistFiles = treeProvider.getFilesFromChangelist(activeChangelistId);
      
      if (allChangelistFiles.length === 0) {
        vscode.window.showWarningMessage('No files in the active changelist to commit.');
        return;
      }

      // Pre-select only the selected files (not all files)
      const preSelectedFileIds = selectedFilesInChangelist.map(f => f.id);

      // Open commit dialog with all changelist files, but only selected ones pre-checked
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace root found.');
        return;
      }
      const hunkAssignments = treeProvider.getHunkAssignments();
      const dialog = new CommitDialog(allChangelistFiles, preSelectedFileIds, workspaceRoot, gitService, activeChangelistId, hunkAssignments);
      const result = await dialog.show();

      if (result) {
        // Filter files to only selected ones
        let filesToCommit = allChangelistFiles.filter(f => result.selectedFiles.includes(f.id));
        
        // Load hunks for files that don't have them
        for (const file of filesToCommit) {
          if (!file.hunks || file.hunks.length === 0) {
            const unstagedHunks = await gitService.getFileHunks(file.path);
            const stagedHunks = await gitService.getStagedHunks(file.path);
            file.hunks = [...unstagedHunks, ...stagedHunks];
          }
        }
        
        // For files with selected hunks, update the file's hunks to only include selected ones
        // Also filter out files that have hunks but no selected hunks
        filesToCommit = filesToCommit.filter(file => {
          const selectedHunkIds = result.selectedHunks[file.id] || [];
          if (file.hunks && file.hunks.length > 0) {
            // File has hunks - only include if some hunks are selected
            if (selectedHunkIds.length > 0) {
              file.hunks = file.hunks.filter(h => selectedHunkIds.includes(h.id));
              return true;
            }
            return false; // File has hunks but none selected - skip it
          }
          // File has no hunks - include it (will commit whole file)
          return true;
        });

        if (filesToCommit.length === 0) {
          vscode.window.showWarningMessage('No files or hunks selected for commit.');
          return;
        }

        const success = await gitService.commitFiles(filesToCommit, result.message, { 
          amend: result.amend, 
          changelistId: activeChangelistId 
        });

        if (success) {
          vscode.window.showInformationMessage(`Successfully committed ${filesToCommit.length} file(s)`);
          treeProvider.refresh();
          updateAllCommitUI();
        } else {
          vscode.window.showErrorMessage('Failed to commit files. Check the output panel for details.');
        }
      }
    }),

    // Keep old command for backward compatibility but it now uses tree selection
    vscode.commands.registerCommand('git-manager.commitSelectedFiles', async () => {
      // Redirect to the new commitFiles command
      await vscode.commands.executeCommand('git-manager.commitFiles');
    }),

    vscode.commands.registerCommand('git-manager.stashSelectedFiles', async () => {
      // Get selected items from the tree view
      const selectedItems = treeView.selection;
      if (selectedItems.length === 0) {
        vscode.window.showWarningMessage('No files selected. Please select files from the tree view first.');
        return;
      }

      // Extract FileItem objects from selected tree items
      const selectedFiles = treeProvider.getFilesFromTreeItems(selectedItems);
      if (selectedFiles.length === 0) {
        vscode.window.showWarningMessage('No files selected for stash. Please select file items from the tree view.');
        return;
      }

      // Determine default message based on changelist selection
      let defaultMessage = '';
      const changelists = treeProvider.getChangelists();

      // Check if all selected files are from the same changelist
      const selectedChangelistIds = new Set(selectedFiles.map((f) => f.changelistId).filter((id) => id));
      if (selectedChangelistIds.size === 1) {
        const changelistId = Array.from(selectedChangelistIds)[0];
        const changelist = changelists.find((c) => c.id === changelistId);
        if (changelist && !changelist.isDefault) {
          defaultMessage = changelist.name;
        }
      }

      const message = await vscode.window.showInputBox({
        prompt: 'Enter stash message',
        placeHolder: defaultMessage || 'Describe your changes...',
        value: defaultMessage,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Stash message cannot be empty';
          }
          return null;
        },
      });

      if (message) {
        const success = await gitService.stashFiles(selectedFiles, message.trim());

        if (success) {
          vscode.window.showInformationMessage(`Successfully stashed ${selectedFiles.length} file(s)`);
          treeProvider.refresh();
          updateAllCommitUI();
        } else {
          vscode.window.showErrorMessage('Failed to stash files. Check the output panel for details.');
        }
      }
    }),

    vscode.commands.registerCommand('git-manager.moveFileToChangelist', async (fileId?: string) => {
      let filesToMove: FileItem[] = [];

      if (fileId) {
        // If a specific file ID is provided (from context menu), move that file
        const allFiles = treeProvider.getAllFiles();
        const file = allFiles.find((f) => f.id === fileId);
        if (file) {
          filesToMove = [file];
        }
      } else {
        // Otherwise, use selected files from tree view
        const selectedItems = treeView.selection;
        filesToMove = treeProvider.getFilesFromTreeItems(selectedItems);
      }

      if (filesToMove.length === 0) {
        vscode.window.showWarningMessage('No files selected. Please select files from the tree view first.');
        return;
      }

      const changelists = treeProvider.getChangelists();
      const options = changelists.map((c) => ({ label: c.name, value: c.id }));

      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select target changelist',
      });

      if (selected) {
        for (const file of filesToMove) {
          await treeProvider.moveFileToChangelist(file.id, selected.value);
        }
        treeProvider.refresh();
        updateAllCommitUI();
      }
    }),

    vscode.commands.registerCommand('git-manager.refresh', () => {
      treeProvider.refresh();
      updateAllCommitUI();
    }),

    // Removed expandAll command

    vscode.commands.registerCommand('git-manager.collapseAll', () => {
      if (treeProvider) {
        treeProvider.collapseAll();
        isExpanded = false;
      }
    }),

    vscode.commands.registerCommand('git-manager.revertSelectedFiles', async () => {
      // Get selected items from the tree view
      const selectedItems = treeView.selection;
      if (selectedItems.length === 0) {
        vscode.window.showWarningMessage('No files selected. Please select files from the tree view first.');
        return;
      }

      // Extract FileItem objects from selected tree items
      const selectedFiles = treeProvider.getFilesFromTreeItems(selectedItems);
      if (selectedFiles.length === 0) {
        vscode.window.showWarningMessage('No files selected for revert. Please select file items from the tree view.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revert ${selectedFiles.length} file(s)? This will discard all uncommitted changes.`,
        { modal: true },
        'Revert'
      );

      if (confirm === 'Revert') {
        const success = await gitService.revertFiles(selectedFiles);

        if (success) {
          vscode.window.showInformationMessage(`Successfully reverted ${selectedFiles.length} file(s)`);
          treeProvider.refresh();
          updateAllCommitUI();
        } else {
          vscode.window.showErrorMessage('Failed to revert files. Check the output panel for details.');
        }
      }
    }),

    // Revert a single file from context menu
    vscode.commands.registerCommand('git-manager.revertFile', async (arg?: any) => {
      let fileToRevert: FileItem | undefined;
      const allFiles = treeProvider.getAllFiles();

      if (typeof arg === 'string') {
        fileToRevert = allFiles.find((f) => f.id === arg);
      } else if (arg && arg.file) {
        // Invoked from context menu: arg is FileTreeItem
        fileToRevert = arg.file as FileItem;
      } else if (arg && arg.resourceUri) {
        const fsPath: string = arg.resourceUri.fsPath as string;
        // match by path tail relative path presence
        fileToRevert = allFiles.find((f) => fsPath.endsWith(f.path));
      }
      if (!fileToRevert) {
        vscode.window.showWarningMessage('No file selected to revert.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Revert changes in ${fileToRevert.name}? This discards uncommitted changes.`,
        { modal: true },
        'Revert'
      );
      if (confirm !== 'Revert') {
        return;
      }

      const success = await gitService.revertFiles([fileToRevert]);
      if (success) {
        vscode.window.showInformationMessage(`Reverted ${fileToRevert.name}`);
        treeProvider.refresh();
        updateAllCommitUI();
        updateCommitButtonContext();
      }
    }),

    // Revert all files in a changelist from context menu
    vscode.commands.registerCommand('git-manager.revertChangelist', async (changelistItem?: any) => {
      if (!changelistItem || !changelistItem.changelist) {
        return;
      }
      const changelistId: string = changelistItem.changelist.id;
      const changelistName: string = changelistItem.changelist.name;
      const files = treeProvider.getChangelists().find((c) => c.id === changelistId)?.files || [];
      if (files.length === 0) {
        vscode.window.showInformationMessage('No files to revert in this changelist.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Revert all ${files.length} file(s) in "${changelistName}"? This discards uncommitted changes.`,
        { modal: true },
        'Revert'
      );
      if (confirm !== 'Revert') {
        return;
      }

      const success = await gitService.revertFiles(files);
      if (success) {
        vscode.window.showInformationMessage(`Reverted ${files.length} file(s) in "${changelistName}"`);
        treeProvider.refresh();
        updateAllCommitUI();
        updateCommitButtonContext();
      }
    }),

    // Untrack a file (move to unversioned section)
    vscode.commands.registerCommand('git-manager.untrackFile', async (arg?: any) => {
      let fileToUntrack: FileItem | undefined;
      const allFiles = treeProvider.getAllFiles();

      if (typeof arg === 'string') {
        fileToUntrack = allFiles.find((f) => f.id === arg);
      } else if (arg && arg.file) {
        // Invoked from context menu: arg is FileTreeItem
        fileToUntrack = arg.file as FileItem;
      } else if (arg && arg.resourceUri) {
        const fsPath: string = arg.resourceUri.fsPath as string;
        // match by path tail relative path presence
        fileToUntrack = allFiles.find((f) => fsPath.endsWith(f.path));
      }
      if (!fileToUntrack) {
        vscode.window.showWarningMessage('No file selected to untrack.');
        return;
      }

      // Check if file is in a changelist
      if (!fileToUntrack.changelistId) {
        vscode.window.showInformationMessage(`File "${fileToUntrack.name}" is not in a changelist.`);
        return;
      }

      try {
        // Use moveFileToUnversioned which handles unstaging and moving to unversioned section
        await treeProvider.moveFileToUnversioned(fileToUntrack.id);
        vscode.window.showInformationMessage(`Untracked ${fileToUntrack.name}`);
        updateAllCommitUI();
        updateCommitButtonContext();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to untrack file: ${error}`);
      }
    }),

    // Unstage a file (keep in changelist, just unstage from index)
    vscode.commands.registerCommand('git-manager.unstageFile', async (arg?: any) => {
      let fileToUnstage: FileItem | undefined;
      const allFiles = treeProvider.getAllFiles();

      if (typeof arg === 'string') {
        fileToUnstage = allFiles.find((f) => f.id === arg);
      } else if (arg && arg.file) {
        // Invoked from context menu: arg is FileTreeItem
        fileToUnstage = arg.file as FileItem;
      } else if (arg && arg.resourceUri) {
        const fsPath: string = arg.resourceUri.fsPath as string;
        // match by path tail relative path presence
        fileToUnstage = allFiles.find((f) => fsPath.endsWith(f.path));
      }
      if (!fileToUnstage) {
        vscode.window.showWarningMessage('No file selected to unstage.');
        return;
      }

      // Check if file is staged
      if (!fileToUnstage.isStaged) {
        vscode.window.showInformationMessage(`File "${fileToUnstage.name}" is not staged.`);
        return;
      }

      // Check if file is in a changelist
      if (!fileToUnstage.changelistId) {
        vscode.window.showInformationMessage(`File "${fileToUnstage.name}" is not in a changelist.`);
        return;
      }

      try {
        // Unstage the file (git restore --staged)
        const success = await gitService.unstageFile(fileToUnstage.path);
        if (success) {
          vscode.window.showInformationMessage(`Unstaged ${fileToUnstage.name}`);
          // Refresh to update the file's staged status
          treeProvider.refresh();
          updateAllCommitUI();
          updateCommitButtonContext();
        } else {
          vscode.window.showErrorMessage(`Failed to unstage ${fileToUnstage.name}`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to unstage file: ${error}`);
      }
    }),

    // New command for status bar commit button (only commits files from active changelist)
    vscode.commands.registerCommand('git-manager.commitFromStatusBar', async () => {
      // Get selected items from the tree view
      const selectedItems = treeView.selection;
      if (selectedItems.length === 0) {
        vscode.window.showWarningMessage('No files selected. Please select files from the tree view first.');
        return;
      }

      // Extract FileItem objects from selected tree items
      const allFiles = treeProvider.getFilesFromTreeItems(selectedItems);
      if (allFiles.length === 0) {
        vscode.window.showWarningMessage('No files selected for commit. Please select file items from the tree view.');
        return;
      }

      // Filter to only files in the active changelist
      const activeChangelistId = treeProvider.getActiveChangelistId();
      const selectedFiles = allFiles.filter((file) => file.changelistId === activeChangelistId);
      
      if (selectedFiles.length === 0) {
        vscode.window.showWarningMessage('No files from the active changelist selected. Please select files from the active changelist.');
        return;
      }

      if (selectedFiles.length < allFiles.length) {
        vscode.window.showInformationMessage(`Only committing ${selectedFiles.length} file(s) from the active changelist. ${allFiles.length - selectedFiles.length} file(s) were ignored.`);
      }

      // Get commit message from the input field
      const message = await vscode.window.showInputBox({
        prompt: 'Enter commit message',
        placeHolder: 'Describe your changes...',
        value: commitMessageInput.text.replace('📝 ', ''), // Remove the icon prefix
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Commit message cannot be empty';
          }
          return null;
        },
      });

      if (message) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Commit', amend: false, push: false },
            { label: 'Amend Commit', amend: true, push: false },
            { label: 'Commit and Push', amend: false, push: true },
            { label: 'Amend Commit and Push', amend: true, push: true },
          ],
          { placeHolder: 'Choose commit action' }
        );
        if (!choice) {
          return;
        }
        const success = await gitService.commitFiles(selectedFiles, message.trim(), { amend: choice.amend, changelistId: activeChangelistId });

        if (success) {
          vscode.window.showInformationMessage(`Successfully committed ${selectedFiles.length} file(s)`);
          if (choice.push) {
            const pushed = await gitService.pushCurrentBranch();
            if (pushed) {
              vscode.window.showInformationMessage('Pushed to remote successfully');
            }
          }
          treeProvider.refresh();
          updateAllCommitUI();
          // Clear the commit message input
          commitMessageInput.text = '📝 ';
        } else {
          vscode.window.showErrorMessage('Failed to commit files. Check the output panel for details.');
        }
      }
    }),

    // New command for status bar stash button (only stashes files from active changelist)
    vscode.commands.registerCommand('git-manager.stashFromStatusBar', async () => {
      // Get selected items from the tree view
      const selectedItems = treeView.selection;
      if (selectedItems.length === 0) {
        vscode.window.showWarningMessage('No files selected. Please select files from the tree view first.');
        return;
      }

      // Extract FileItem objects from selected tree items
      const allFiles = treeProvider.getFilesFromTreeItems(selectedItems);
      if (allFiles.length === 0) {
        vscode.window.showWarningMessage('No files selected for stash. Please select file items from the tree view.');
        return;
      }

      // Filter to only files in the active changelist
      const activeChangelistId = treeProvider.getActiveChangelistId();
      const selectedFiles = allFiles.filter((file) => file.changelistId === activeChangelistId);
      
      if (selectedFiles.length === 0) {
        vscode.window.showWarningMessage('No files from the active changelist selected. Please select files from the active changelist.');
        return;
      }

      if (selectedFiles.length < allFiles.length) {
        vscode.window.showInformationMessage(`Only stashing ${selectedFiles.length} file(s) from the active changelist. ${allFiles.length - selectedFiles.length} file(s) were ignored.`);
      }

      // Determine default message based on changelist selection
      let defaultMessage = '';
      const changelists = treeProvider.getChangelists();

      // Check if all selected files are from the same changelist
      const selectedChangelistIds = new Set(selectedFiles.map((f) => f.changelistId).filter((id) => id));
      if (selectedChangelistIds.size === 1) {
        const changelistId = Array.from(selectedChangelistIds)[0];
        const changelist = changelists.find((c) => c.id === changelistId);
        if (changelist && !changelist.isDefault) {
          defaultMessage = changelist.name;
        }
      }

      // Get stash message from the input field or prompt
      const message = await vscode.window.showInputBox({
        prompt: 'Enter stash message',
        placeHolder: defaultMessage || 'Describe your changes...',
        value: defaultMessage || commitMessageInput.text.replace('📝 ', ''), // Use changelist name or current message
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Stash message cannot be empty';
          }
          return null;
        },
      });

      if (message) {
        const success = await gitService.stashFiles(selectedFiles, message.trim());

        if (success) {
          vscode.window.showInformationMessage(`Successfully stashed ${selectedFiles.length} file(s)`);
          treeProvider.refresh();
          updateAllCommitUI();
          // Clear the commit message input
          commitMessageInput.text = '📝 ';
        } else {
          vscode.window.showErrorMessage('Failed to stash files. Check the output panel for details.');
        }
      }
    }),

    // Command to update commit message in status bar
    vscode.commands.registerCommand('git-manager.updateCommitMessage', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Enter commit message',
        placeHolder: 'Describe your changes...',
        value: commitMessageInput.text.replace('📝 ', ''),
      });

      if (message !== undefined) {
        commitMessageInput.text = `📝 ${message}`;
      }
    }),

    // Command to toggle auto-stage feature
    vscode.commands.registerCommand('git-manager.toggleAutoStage', async () => {
      const config = vscode.workspace.getConfiguration('git-manager');
      const currentValue = config.get<boolean>('autoStageFiles', true);
      const newValue = !currentValue;

      await config.update('autoStageFiles', newValue, vscode.ConfigurationTarget.Workspace);

      const status = newValue ? 'enabled' : 'disabled';
      vscode.window.showInformationMessage(`Auto-stage files ${status}`);
    }),

    // Test command to verify extension is working
    vscode.commands.registerCommand('git-manager.test', () => {
      vscode.window.showInformationMessage('JetBrains Commit Manager extension is working!');
    }),

    // Command to clear persisted state (useful for fixing corrupted state)
    vscode.commands.registerCommand('git-manager.clearPersistedState', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'This will clear all persisted changelists and file assignments. This action cannot be undone.',
        { modal: true },
        'Clear All Data'
      );

      if (confirmed === 'Clear All Data') {
        try {
          await treeProvider.clearPersistedState();
          vscode.window.showInformationMessage('Persisted state cleared successfully. The extension will now use fresh data.');
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to clear persisted state: ${error}`);
        }
      }
    }),

    // Command to move hunk to changelist (from gutter context menu)
    vscode.commands.registerCommand('git-manager.moveHunkToChangelist', async (uri?: vscode.Uri, line?: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor found.');
        return;
      }

      // Get line from selection or cursor position if not provided
      if (line === undefined) {
        line = editor.selection.active.line + 1; // Convert to 1-based
      }

      // Use editor's document URI if not provided
      if (!uri) {
        uri = editor.document.uri;
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(uri);
      // Try to get hunk from decoration provider first, then from tree provider
      let hunk = hunkDecorationProvider ? hunkDecorationProvider.getHunkAtLine(relativePath, line) : null;
      if (!hunk) {
        hunk = treeProvider.getHunkAtLine(relativePath, line);
      }

      if (!hunk) {
        vscode.window.showInformationMessage(`No hunk found at line ${line}. Make sure you're clicking on a line with changes.`);
        return;
      }

      const changelists = treeProvider.getChangelists();
      const currentChangelist = changelists.find(c => c.id === hunk.changelistId);
      const currentChangelistName = currentChangelist ? currentChangelist.name : 'Default';

      const options = changelists.map((c) => ({
        label: c.name,
        value: c.id,
        description: c.id === hunk.changelistId ? 'Current' : undefined,
      }));

      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: `Move hunk to changelist (Current: ${currentChangelistName})`,
      });

      if (selected) {
        await treeProvider.moveHunkToChangelist(hunk.id, selected.value);
        // Update hunk decoration provider
        if (hunkDecorationProvider) {
          hunkDecorationProvider.updateChangelists(treeProvider.getChangelists());
          hunkDecorationProvider.updateHunkAssignments(treeProvider.getHunkAssignments());
        // Decorations will be updated via onDidChangeTreeData
        }
        vscode.window.showInformationMessage(`Hunk moved to "${selected.label}"`);
      }
    }),
  ];

  context.subscriptions.push(...commands);

  if (treeView) {
    context.subscriptions.push(treeView);
  }

  if (treeProvider) {
    treeProvider.refresh();
    updateAllCommitUI();
    
    // Update decorations when tree data changes
    treeProvider.onDidChangeTreeData(() => {
      if (hunkDecorationProvider) {
        hunkDecorationProvider.updateChangelists(treeProvider.getChangelists());
        hunkDecorationProvider.updateActiveChangelist(treeProvider.getActiveChangelistId());
        hunkDecorationProvider.updateHunkAssignments(treeProvider.getHunkAssignments());
        
        // Collect all hunks from changelists by file
          const hunksByFile = new Map<string, Hunk[]>();
          for (const changelist of treeProvider.getChangelists()) {
            for (const hunk of changelist.hunks) {
            if (!hunksByFile.has(hunk.filePath)) {
              hunksByFile.set(hunk.filePath, []);
            }
            // Avoid duplicates
            if (!hunksByFile.get(hunk.filePath)!.some(h => h.id === hunk.id)) {
              hunksByFile.get(hunk.filePath)!.push(hunk);
            }
          }
        }
        // Also check files for hunks
        for (const changelist of treeProvider.getChangelists()) {
          for (const file of changelist.files) {
            if (file.hunks) {
              for (const hunk of file.hunks) {
                if (!hunksByFile.has(hunk.filePath)) {
                  hunksByFile.set(hunk.filePath, []);
                }
                if (!hunksByFile.get(hunk.filePath)!.some(h => h.id === hunk.id)) {
                  hunksByFile.get(hunk.filePath)!.push(hunk);
                }
              }
            }
          }
        }
        hunkDecorationProvider.updateHunksByFile(hunksByFile);
      }
    });
  }

  // Update decorations when editors open or change
  vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (hunkDecorationProvider && editor) {
      // Update immediately - hunks should already be available
      await hunkDecorationProvider.updateDecorationsForEditor(editor);
    }
  });

  vscode.workspace.onDidOpenTextDocument(async (document) => {
    const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
    if (hunkDecorationProvider && editor) {
      // Update immediately - hunks should already be available
      await hunkDecorationProvider.updateDecorationsForEditor(editor);
    }
  });

  // Initial decoration update will happen via onDidChangeTreeData after first refresh

  // Set up file system watcher to refresh on file changes
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  fileSystemWatcher.onDidChange(async (uri) => {
    if (treeProvider) {
      // Auto-stage the changed file if the feature is enabled
      const config = vscode.workspace.getConfiguration('git-manager');
      const autoStageEnabled = config.get<boolean>('autoStageFiles', true);

      if (autoStageEnabled && gitService) {
        const relativePath = vscode.workspace.asRelativePath(uri);

        // Skip auto-staging for certain file types
        if (shouldSkipAutoStage(relativePath)) {
          return;
        }

        // Only auto-stage files that are already tracked by Git
        const isTracked = await gitService.isFileTracked(relativePath);
        if (!isTracked) {
          return;
        }

        try {
          await gitService.stageFile(relativePath);
        } catch (error) {
          console.error(`Failed to auto-stage file ${relativePath}:`, error);
        }
      }

      treeProvider.refresh();
      updateAllCommitUI();
    }
  });
  fileSystemWatcher.onDidCreate(async (uri) => {
    if (treeProvider) {
      // Auto-stage the new file if the feature is enabled
      const config = vscode.workspace.getConfiguration('git-manager');
      const autoStageEnabled = config.get<boolean>('autoStageFiles', true);

      if (autoStageEnabled && gitService) {
        const relativePath = vscode.workspace.asRelativePath(uri);

        // Skip auto-staging for certain file types
        if (shouldSkipAutoStage(relativePath)) {
          return;
        }

        // Only auto-stage files that are already tracked by Git
        const isTracked = await gitService.isFileTracked(relativePath);
        if (!isTracked) {
          return;
        }

        try {
          await gitService.stageFile(relativePath);
        } catch (error) {
          console.error(`Failed to auto-stage file ${relativePath}:`, error);
        }
      }

      treeProvider.refresh();
      updateAllCommitUI();
      // Decorations will be updated via onDidChangeTreeData listener
    }
  });
  fileSystemWatcher.onDidDelete(() => {
    if (treeProvider) {
      treeProvider.refresh();
      updateAllCommitUI();
      // Decorations will be updated via onDidChangeTreeData listener
    }
  });

  context.subscriptions.push(fileSystemWatcher);
  
  // Dispose decoration provider on deactivate
  context.subscriptions.push({
    dispose: () => {
      if (hunkDecorationProvider) {
        hunkDecorationProvider.dispose();
      }
    }
  });
}

function createCommitStatusBarItems() {
  // Create commit button in status bar
  commitStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  commitStatusBarItem.command = 'git-manager.commitFromStatusBar';
  commitStatusBarItem.tooltip = 'Commit selected files';
  commitStatusBarItem.show();

  // Create commit message input in status bar
  commitMessageInput = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  commitMessageInput.command = 'git-manager.updateCommitMessage';
  commitMessageInput.tooltip = 'Click to edit commit message';
  commitMessageInput.text = '📝 ';
  commitMessageInput.show();

  updateAllCommitUI();
}

function updateCommitStatusBar() {
  if (!treeProvider || !treeView) {
    return;
  }

  // Get selected items from tree view
  const selectedItems = treeView.selection;
  const selectedFiles = treeProvider.getFilesFromTreeItems(selectedItems);
  const totalFiles = treeProvider.getAllFiles().length;

  if (selectedFiles.length > 0) {
    commitStatusBarItem.text = `$(check) Commit (${selectedFiles.length}/${totalFiles})`;
    commitStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
  } else {
    commitStatusBarItem.text = '$(check) Commit';
    commitStatusBarItem.backgroundColor = undefined;
  }
}

function updateAllCommitUI() {
  // Only update status bar now that the commit webview is removed
  updateCommitStatusBar();
}

export function deactivate() {
  if (commitStatusBarItem) {
    commitStatusBarItem.dispose();
  }
  if (commitMessageInput) {
    commitMessageInput.dispose();
  }
}

// Helper function to determine if a file should be skipped for auto-staging
function shouldSkipAutoStage(filePath: string): boolean {
  const skipPatterns = [
    // Temporary files
    /\.tmp$/,
    /\.temp$/,
    /\.swp$/,
    /\.swo$/,
    /~$/,

    // Build artifacts
    /\.log$/,
    /\.out$/,
    /\.exe$/,
    /\.dll$/,
    /\.so$/,
    /\.dylib$/,
    /\.o$/,
    /\.obj$/,
    /\.class$/,

    // IDE and editor files
    /\.vscode\//,
    /\.idea\//,
    /\.vs\//,
    /\.DS_Store$/,
    /Thumbs\.db$/,

    // Node.js
    /node_modules\//,
    /npm-debug\.log$/,
    /yarn-error\.log$/,

    // Git
    /\.git\//,

    // Package managers
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,

    // Environment files
    /\.env$/,
    /\.env\.local$/,
    /\.env\.development$/,
    /\.env\.production$/,
  ];

  return skipPatterns.some((pattern) => pattern.test(filePath));
}
