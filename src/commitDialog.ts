import * as vscode from 'vscode';
import { FileItem, Hunk } from './types';
import { GitService } from './gitService';

interface CommitDialogResult {
  message: string;
  selectedFiles: string[]; // File IDs
  selectedHunks: { [fileId: string]: string[] }; // File ID -> Hunk IDs
  amend: boolean;
}

export class CommitDialog {
  private panel: vscode.WebviewPanel | undefined;
  private resolvePromise: ((value: CommitDialogResult | undefined) => void) | undefined;
  private gitService: GitService;
  private workspaceRoot: string;
  private allFiles: FileItem[];
  private selectedFileIds: Set<string>;
  private selectedHunksByFile: Map<string, Set<string>>;
  private currentViewingFileId: string | undefined;
  private fileHunks: Map<string, Hunk[]> = new Map();
  private changelistId: string;
  private hunkAssignments: Map<string, string> = new Map();

  constructor(
    files: FileItem[],
    preSelectedFileIds: string[],
    workspaceRoot: string,
    gitService: GitService,
    changelistId: string,
    hunkAssignments?: Map<string, string>
  ) {
    this.allFiles = files;
    this.workspaceRoot = workspaceRoot;
    this.gitService = gitService;
    this.changelistId = changelistId;
    this.selectedFileIds = new Set(preSelectedFileIds);
    this.selectedHunksByFile = new Map();
    if (hunkAssignments) {
      this.hunkAssignments = hunkAssignments;
    }
    
    // Initialize all hunks as selected for pre-selected files (only hunks from this changelist)
    for (const fileId of preSelectedFileIds) {
      this.selectedHunksByFile.set(fileId, new Set());
    }
  }

  async show(): Promise<CommitDialogResult | undefined> {
    this.panel = vscode.window.createWebviewPanel(
      'commitDialog',
      'Commit Changes',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    // Load hunks for all files
    await this.loadHunksForFiles();

    this.panel.webview.html = this.getWebviewContent();
    
    // Auto-select first selected file to show its diff
    if (this.selectedFileIds.size > 0) {
      const firstSelectedFileId = Array.from(this.selectedFileIds)[0];
      this.currentViewingFileId = firstSelectedFileId;
      // Small delay to ensure webview is ready
      setTimeout(async () => {
        await this.sendDiffForFile(firstSelectedFileId);
      }, 100);
    }

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'selectFile':
          this.toggleFileSelection(message.fileId);
          break;
        case 'selectHunk':
          this.toggleHunkSelection(message.fileId, message.hunkId);
          break;
          case 'selectAllHunks':
            this.toggleAllHunksForFile(message.fileId, message.select === true);
            break;
        case 'viewFile':
          this.currentViewingFileId = message.fileId;
          await this.updateDiffView();
          break;
        case 'getDiff':
          await this.sendDiffForFile(message.fileId);
          break;
        case 'commit':
          if (this.resolvePromise) {
            const selectedHunksObj: { [fileId: string]: string[] } = {};
            for (const [fileId, hunkIds] of this.selectedHunksByFile.entries()) {
              if (hunkIds.size > 0) {
                selectedHunksObj[fileId] = Array.from(hunkIds);
              }
            }
            this.resolvePromise({
              message: message.message,
              selectedFiles: Array.from(this.selectedFileIds),
              selectedHunks: selectedHunksObj,
              amend: message.amend === true,
            });
          }
          this.panel?.dispose();
          break;
        case 'cancel':
          if (this.resolvePromise) {
            this.resolvePromise(undefined);
          }
          this.panel?.dispose();
          break;
      }
    });

    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  private async loadHunksForFiles(): Promise<void> {
    for (const file of this.allFiles) {
      try {
        const unstagedHunks = await this.gitService.getFileHunks(file.path);
        const stagedHunks = await this.gitService.getStagedHunks(file.path);
        const allHunks = [...unstagedHunks, ...stagedHunks];
        
        // Assign changelist IDs to hunks based on assignments
        for (const hunk of allHunks) {
          const assignedChangelistId = this.hunkAssignments.get(hunk.id) || hunk.changelistId;
          if (assignedChangelistId) {
            hunk.changelistId = assignedChangelistId;
          } else {
            hunk.changelistId = this.changelistId; // Default to current changelist
          }
        }
        
        this.fileHunks.set(file.id, allHunks);
        
        // If file is pre-selected, select only hunks from this changelist by default
        if (this.selectedFileIds.has(file.id)) {
          const hunkSet = new Set<string>();
          for (const hunk of allHunks) {
            const hunkChangelistId = this.hunkAssignments.get(hunk.id) || hunk.changelistId || this.changelistId;
            if (hunkChangelistId === this.changelistId) {
              hunkSet.add(hunk.id);
            }
          }
          this.selectedHunksByFile.set(file.id, hunkSet);
        }
      } catch (error) {
        console.error(`Error loading hunks for ${file.path}:`, error);
        this.fileHunks.set(file.id, []);
      }
    }
  }

  private toggleFileSelection(fileId: string): void {
    if (!fileId) {
      return;
    }
    
    // Toggle ONLY this specific file
    if (this.selectedFileIds.has(fileId)) {
      this.selectedFileIds.delete(fileId);
      this.selectedHunksByFile.delete(fileId);
    } else {
      this.selectedFileIds.add(fileId);
      // Select all hunks when file is selected (only hunks from this changelist)
      const hunks = this.fileHunks.get(fileId) || [];
      const hunkSet = new Set<string>();
      for (const hunk of hunks) {
        const hunkChangelistId = this.hunkAssignments.get(hunk.id) || hunk.changelistId || this.changelistId;
        if (hunkChangelistId === this.changelistId) {
          hunkSet.add(hunk.id);
        }
      }
      this.selectedHunksByFile.set(fileId, hunkSet);
    }
    
    this.updateWebview();
  }

  private toggleHunkSelection(fileId: string, hunkId: string): void {
    if (!fileId || !hunkId) {
      return;
    }
    
    const hunks = this.fileHunks.get(fileId) || [];
    const hunk = hunks.find(h => h.id === hunkId);
    if (!hunk) {
      return;
    }
    
    const hunkChangelistId = this.hunkAssignments.get(hunk.id) || hunk.changelistId || this.changelistId;
    if (hunkChangelistId !== this.changelistId) {
      return;
    }
    
    let hunkSet = this.selectedHunksByFile.get(fileId);
    if (!hunkSet) {
      hunkSet = new Set<string>();
      this.selectedHunksByFile.set(fileId, hunkSet);
    }
    
    // Toggle ONLY this specific hunk
    if (hunkSet.has(hunkId)) {
      hunkSet.delete(hunkId);
    } else {
      hunkSet.add(hunkId);
      if (!this.selectedFileIds.has(fileId)) {
        this.selectedFileIds.add(fileId);
      }
    }
    
    this.updateWebview();
  }

  // Toggle selection of all hunks for a given file (only hunks belonging to this changelist)
  private toggleAllHunksForFile(fileId: string, select: boolean): void {
    if (!fileId) {
      return;
    }
    
    const hunks = this.fileHunks.get(fileId) || [];
    if (hunks.length === 0) {
      return;
    }
    
    let hunkSet = this.selectedHunksByFile.get(fileId);
    if (!hunkSet) {
      hunkSet = new Set<string>();
      this.selectedHunksByFile.set(fileId, hunkSet);
    }
    
    // Only operate on hunks that belong to this changelist
    let affectedHunks = 0;
    for (const hunk of hunks) {
      const hunkChangelistId = this.hunkAssignments.get(hunk.id) || hunk.changelistId || this.changelistId;
      if (hunkChangelistId !== this.changelistId) {
        continue;
      }
      affectedHunks++;
      if (select) {
        hunkSet.add(hunk.id);
      } else {
        hunkSet.delete(hunk.id);
      }
    }
    
    // If we selected any hunks, ensure the file itself is marked as selected
    if (select && affectedHunks > 0) {
      this.selectedFileIds.add(fileId);
    }
    
    // If we deselected all hunks for this file, optionally clear file selection
    if (!select) {
      const currentSet = this.selectedHunksByFile.get(fileId);
      if (!currentSet || currentSet.size === 0) {
        this.selectedHunksByFile.delete(fileId);
        this.selectedFileIds.delete(fileId);
      }
    }
    
    this.updateWebview();
  }

  private async sendDiffForFile(fileId: string): Promise<void> {
    const file = this.allFiles.find(f => f.id === fileId);
    if (!file) {
      return;
    }

    try {
      const diffContent = await this.gitService.getFileDiff(file.path, file.status);
      const { originalContent, modifiedContent } = await this.gitService.getFileContentsForDiff(
        file.path,
        file.status
      );
      const hunks = this.fileHunks.get(fileId) || [];
      const selectedHunks = this.selectedHunksByFile.get(fileId) || new Set();
      
      this.panel?.webview.postMessage({
        command: 'diffContent',
        fileId: fileId,
        diff: diffContent,
        originalContent,
        modifiedContent,
        hunks: hunks.map(h => {
          const hunkChangelistId = this.hunkAssignments.get(h.id) || h.changelistId || this.changelistId;
          const belongsToChangelist = hunkChangelistId === this.changelistId;
          return {
            id: h.id,
            oldStart: h.oldStart,
            oldLines: h.oldLines,
            newStart: h.newStart,
            newLines: h.newLines,
            content: h.content, // Include content to detect removed lines
            isSelected: selectedHunks.has(h.id),
            belongsToChangelist: belongsToChangelist,
            changelistId: hunkChangelistId,
          };
        }),
      });
    } catch (error) {
      console.error(`Error getting diff for ${file.path}:`, error);
      this.panel?.webview.postMessage({
        command: 'diffContent',
        fileId: fileId,
        diff: 'Error loading diff',
        hunks: [],
      });
    }
  }

  private async updateDiffView(): Promise<void> {
    if (this.currentViewingFileId) {
      await this.sendDiffForFile(this.currentViewingFileId);
    }
  }

  private updateWebview(): void {
    const selectedFilesArray = Array.from(this.selectedFileIds);
    const selectedHunksObj: { [fileId: string]: string[] } = {};
    for (const [fileId, hunkIds] of this.selectedHunksByFile.entries()) {
      selectedHunksObj[fileId] = Array.from(hunkIds);
    }
    
    this.panel?.webview.postMessage({
      command: 'updateSelection',
      selectedFiles: selectedFilesArray,
      selectedHunks: selectedHunksObj,
    });
  }

  private getWebviewContent(): string {
    // Prepare a serializable representation of files for the webview,
    // including a pre-computed status label for each file.
    const webviewFiles = this.allFiles.map((file) => ({
      ...file,
      statusLabel: this.getStatusLabel(file.status),
    }));

    const selectedCount = this.selectedFileIds.size;
    const totalCount = this.allFiles.length;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Commit Changes</title>
        <style>
          * {
            box-sizing: border-box;
          }
          
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            margin: 0;
            padding: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
          }
          
          .header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
          }
          
          .header h1 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
          }
          
          .main-container {
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
          }
          
          .file-list-panel {
            width: 100%;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            flex: 1 1 auto;
            min-height: 200px;
          }
          
          .file-list-header {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            font-weight: 600;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
          }
          
          .file-list {
            flex: 1;
            overflow-y: auto;
          }
          
          .tree-folder {
            border-bottom: 1px solid var(--vscode-panel-border);
          }
          
          .folder-row {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            gap: 6px;
            cursor: default;
            user-select: none;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
          }
          
          .folder-row:hover {
            background-color: var(--vscode-list-hoverBackground);
          }
          
          .folder-toggle {
            width: 22px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            opacity: 0.9;
            font-size: 13px;
            line-height: 1;
            transform-origin: center;
          }
          
          .folder-name {
            font-weight: 500;
          }
          
          .tree-children {
            /* Container for nested folders/files */
          }
          
          /* Base checkbox styling to better match VS Code UI */
          /* Native VS Code checkbox styling */
          input[type="checkbox"],
          .file-checkbox,
          .hunk-checkbox,
          .all-hunks-checkbox,
          #amend-checkbox {
            -webkit-appearance: none;
            -moz-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border));
            background-color: var(--vscode-checkbox-background, var(--vscode-input-background));
            border-radius: 3px;
            cursor: pointer;
            position: relative;
            flex-shrink: 0;
            transition: background-color 0.1s, border-color 0.1s;
          }

          input[type="checkbox"]:checked,
          .file-checkbox:checked,
          .hunk-checkbox:checked,
          .all-hunks-checkbox:checked,
          #amend-checkbox:checked {
            background-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background));
            border-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background));
          }

          input[type="checkbox"]:checked::before,
          .file-checkbox:checked::before,
          .hunk-checkbox:checked::before,
          .all-hunks-checkbox:checked::before,
          #amend-checkbox:checked::before {
            content: '';
            position: absolute;
            left: 4px;
            top: 1px;
            width: 5px;
            height: 9px;
            border: solid var(--vscode-checkbox-selectForeground, var(--vscode-button-foreground));
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
          }

          input[type="checkbox"]:indeterminate,
          .file-checkbox:indeterminate,
          .hunk-checkbox:indeterminate,
          .all-hunks-checkbox:indeterminate,
          #amend-checkbox:indeterminate {
            background-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background));
            border-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background));
          }

          input[type="checkbox"]:indeterminate::before,
          .file-checkbox:indeterminate::before,
          .hunk-checkbox:indeterminate::before,
          .all-hunks-checkbox:indeterminate::before,
          #amend-checkbox:indeterminate::before {
            content: '';
            position: absolute;
            left: 3px;
            top: 6px;
            width: 8px;
            height: 2px;
            background-color: var(--vscode-checkbox-selectForeground, var(--vscode-button-foreground));
            border: none;
            transform: none;
          }

          input[type="checkbox"]:hover,
          .file-checkbox:hover,
          .hunk-checkbox:hover,
          .all-hunks-checkbox:hover,
          #amend-checkbox:hover {
            border-color: var(--vscode-focusBorder);
          }

          input[type="checkbox"]:checked:hover,
          .file-checkbox:checked:hover,
          .hunk-checkbox:checked:hover,
          .all-hunks-checkbox:checked:hover,
          #amend-checkbox:checked:hover {
            background-color: var(--vscode-button-hoverBackground);
            border-color: var(--vscode-button-hoverBackground);
          }

          input[type="checkbox"]:focus-visible,
          .file-checkbox:focus-visible,
          .hunk-checkbox:focus-visible,
          .all-hunks-checkbox:focus-visible,
          #amend-checkbox:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
          }

          input[type="checkbox"]:disabled,
          .file-checkbox:disabled,
          .hunk-checkbox:disabled,
          .all-hunks-checkbox:disabled,
          #amend-checkbox:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          
          .file-item {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            cursor: pointer;
            transition: background-color 0.15s;
            gap: 8px;
          }
          
          .file-item:hover {
            background-color: var(--vscode-list-hoverBackground);
          }
          
          /* Active (currently viewed) file */
          .file-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
          }
          
          .file-status {
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            white-space: nowrap;
            flex-shrink: 0;
          }
          
          .file-status.modified {
            background-color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
            color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
            border: 1px solid var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
          }
          
          .file-status.added {
            background-color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
            color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
            border: 1px solid var(--vscode-gitDecoration-addedResourceForeground, #73c991);
          }
          
          .file-status.deleted {
            background-color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
            color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
            border: 1px solid var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
          }
          
          .file-status.untracked {
            background-color: var(--vscode-descriptionForeground, #8c8c8c);
            color: var(--vscode-descriptionForeground, #8c8c8c);
            border: 1px solid var(--vscode-descriptionForeground, #8c8c8c);
          }
          
          .file-status.renamed {
            background-color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991);
            color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991);
            border: 1px solid var(--vscode-gitDecoration-renamedResourceForeground, #73c991);
          }
          
          .file-name {
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
          }
          
          .hunk-count {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
            white-space: nowrap;
            margin-left: 8px;
            flex-shrink: 0;
          }
          
          .diff-section {
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 200px;
            overflow: hidden;
          }
          
          .diff-header {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            font-weight: 600;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            flex-shrink: 0;
          }
          
          .diff-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          
          .diff-sides-container {
            flex: 1;
            display: flex;
            overflow: hidden;
          }
          
          .diff-side {
            flex: 1;
            overflow: auto;
            padding: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: var(--vscode-editor-line-height);
            border-right: 1px solid var(--vscode-panel-border);
          }
          
          .diff-side:last-child {
            border-right: none;
          }
          
          .diff-side-header {
            padding: 4px 8px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            font-size: 11px;
            font-weight: 600;
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            z-index: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            /* Ensure both headers (Original / Modified) have the same height */
            height: 24px;
          }
          
          .diff-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
          }
          
          .diff-line {
            display: flex;
            min-height: 20px;
            align-items: stretch;
            position: relative;
          }
          
          .diff-line:hover {
            background-color: var(--vscode-list-hoverBackground);
          }
          
          .diff-line-number {
            width: 50px;
            padding: 0 8px;
            text-align: right;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            user-select: none;
            flex-shrink: 0;
            border-right: 1px solid var(--vscode-panel-border);
            position: relative;
          }
          
          .diff-line-number.old {
            background-color: var(--vscode-diffEditor-removedLineBackground);
          }
          
          .diff-line-number.old::after {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            background-color: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2));
          }
          
          .diff-line-number.new {
            background-color: rgba(76, 175, 80, 0.2);
          }
          
          /* Modified lines (changed lines) - line numbers should be blueish when hunk is selected */
          .diff-line.hunk-selected .diff-line-number.old,
          .diff-line.hunk-selected .diff-line-number.new {
            background-color: color-mix(in srgb, var(--vscode-button-background, #007acc) 30%, transparent);
          }
          
          .diff-line-number.new::after {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 255, 0, 0.2));
          }
          
          .diff-line-content {
            flex: 1;
            padding: 0 12px 0 32px;
            white-space: pre;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            position: relative;
          }
          
          /* Default: greenish background for pure additions */
          .diff-line-content.added {
            background-color: var(--vscode-diffEditor-insertedLineBackground);
          }
          
          /* CRITICAL FIX: Pure additions (no hunk-selected/hunk-unselected) MUST be green - hard-coded greenish color */
          .diff-line:not(.hunk-selected):not(.hunk-unselected) .diff-line-content.added {
            background-color: rgba(76, 175, 80, 0.2) !important;
          }
          
          .diff-line-content.added::before {
            content: '+';
            position: absolute;
            left: 8px;
            color: var(--vscode-diffEditor-insertedTextBackground, #4ec9b0);
            font-weight: bold;
            width: 20px;
            text-align: center;
            font-size: 14px;
            line-height: 20px;
          }
          
          .diff-line-content.removed {
            /* Hard-coded greyish background for deleted lines */
            background-color: rgba(128, 128, 128, 0.2);
          }
          
          .diff-line-content.removed::before {
            content: '-';
            position: absolute;
            left: 8px;
            color: var(--vscode-diffEditor-removedTextBackground, #f48771);
            font-weight: bold;
            width: 20px;
            text-align: center;
            font-size: 14px;
            line-height: 20px;
          }
          
          .diff-line-content.context {
            background-color: var(--vscode-editor-background);
          }
          
          .diff-line-content.context::before {
            content: ' ';
            position: absolute;
            left: 8px;
            width: 20px;
          }
          
          .diff-line-content.empty {
            background-color: var(--vscode-editor-background);
          }
          
          /* Changed lines (modified): bluish background - overrides default green for hunk-selected */
          .diff-line.hunk-selected .diff-line-content.added {
            background-color: color-mix(in srgb, var(--vscode-button-background, #007acc) 30%, transparent);
          }
          
          .diff-line.hunk-selected .diff-line-content.removed {
            background-color: color-mix(in srgb, var(--vscode-button-background, #007acc) 30%, transparent);
          }
          
          .diff-separator {
            display: flex;
            align-items: center;
            justify-content: stretch;
            padding: 8px 0;
            gap: 10px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            user-select: none;
            background-color: var(--vscode-editor-background);
            border-top: 1px solid var(--vscode-panel-border);
            border-bottom: 1px solid var(--vscode-panel-border);
            position: relative;
            margin: 0;
            width: 100%;
            box-sizing: border-box;
          }
          
          .diff-separator-line {
            flex: 1 1 auto;
            min-width: 0;
            margin: 0;
            display: flex;
            align-items: center;
            padding: 0;
            position: relative;
          }
          
          .diff-separator-line-inner {
            width: 100%;
            height: 1px;
            /* Use line number foreground for good contrast across themes */
            background-color: var(--vscode-editorLineNumber-foreground);
            display: block;
          }
          
          /* Dashed line for addition/deletion separators to distinguish from "lines hidden" markers */
          .diff-separator-line-dashed {
            background-color: transparent;
            border-top: 1px dashed var(--vscode-editorLineNumber-foreground);
            height: 0;
          }
          
          /* Visual fill for pure addition/deletion placeholders, similar to stock diff */
          .diff-separator-addition,
          .diff-separator-deletion {
            padding: 0;
            background-image: repeating-linear-gradient(
              135deg,
              color-mix(in srgb, var(--vscode-editorLineNumber-foreground) 10%, transparent) 0px,
              color-mix(in srgb, var(--vscode-editorLineNumber-foreground) 10%, transparent) 4px,
              transparent 4px,
              transparent 8px
            );
            background-color: transparent;
          }
          
          /* Placeholder lines for modifications to equalize hunk heights */
          .diff-line.diff-placeholder {
            background-image: repeating-linear-gradient(
              135deg,
              color-mix(in srgb, var(--vscode-editorLineNumber-foreground) 10%, transparent) 0px,
              color-mix(in srgb, var(--vscode-editorLineNumber-foreground) 10%, transparent) 4px,
              transparent 4px,
              transparent 8px
            );
            background-color: transparent;
          }
          
          .diff-placeholder .diff-line-number {
            background-color: transparent;
            border-right: 1px solid var(--vscode-panel-border);
          }
          
          .diff-placeholder .diff-line-content {
            background-color: transparent;
          }
          
          .diff-separator-text {
            flex: 0 0 auto;
            white-space: nowrap;
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
            font-size: 10px;
            padding: 0 8px;
            background-color: var(--vscode-editor-background);
            position: relative;
            z-index: 1;
          }
          
          .hunk-checkbox {
            margin: 0;
            flex-shrink: 0;
            align-self: center;
            margin-left: 8px;
            margin-right: 4px;
          }
          
          /* Container for checkbox or spacer to ensure consistent alignment */
          .diff-line-checkbox-container {
            width: 30px;
            display: flex;
            align-items: center;
            justify-content: flex-start;
            flex-shrink: 0;
          }
          
          .hunk-header {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-top: 1px solid var(--vscode-panel-border);
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 8px;
            width: 100%;
            flex-shrink: 0;
            border-left: 3px solid transparent;
          }
          
          .hunk-header-text {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
          }

          .diff-line.hunk-selected {
            background-color: color-mix(in srgb, var(--vscode-button-background, #007acc) 30%, transparent);
          }
          
          .diff-line.hunk-selected .diff-line-content {
            background-color: color-mix(in srgb, var(--vscode-button-background, #007acc) 30%, transparent);
          }
          
          /* CRITICAL: Ensure pure additions (without hunk-selected) stay green - hard-coded greenish color */
          .diff-line:not(.hunk-selected):not(.hunk-unselected) .diff-line-content.added {
            background-color: rgba(76, 175, 80, 0.2) !important;
          }
          
          /* Lines from other changelists: muted greyish */
          .diff-line.other-changelist {
            opacity: 0.6;
          }
          
          .diff-line.other-changelist .diff-line-content {
            background-color: color-mix(in srgb, var(--vscode-descriptionForeground) 10%, var(--vscode-editor-background));
          }
          
          .diff-line.other-changelist .diff-line-content.added {
            background-color: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground) 30%, var(--vscode-descriptionForeground) 10%, var(--vscode-editor-background) 60%);
          }
          
          .diff-line.other-changelist .diff-line-content.removed {
            background-color: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, var(--vscode-editor-background));
          }

          .diff-line.hunk-unselected {
            background-color: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 60%, transparent);
          }
          
          .diff-line.hunk-unselected .diff-line-content {
            background-color: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 60%, transparent);
            opacity: 0.85;
          }
          
          .diff-line.hunk-unselected .diff-line-content.added {
            background-color: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground) 30%, var(--vscode-editor-inactiveSelectionBackground) 70%);
          }
          
          .diff-line.hunk-unselected .diff-line-content.removed {
            background-color: color-mix(in srgb, color-mix(in srgb, var(--vscode-descriptionForeground) 15%, var(--vscode-editor-background)) 30%, var(--vscode-editor-inactiveSelectionBackground) 70%);
          }

          .hunk-disabled {
            opacity: 0.5;
          }

          .hunk-header.hunk-selected {
            border-left-color: var(--vscode-diffEditor-insertedTextBackground, #4ec9b0);
          }

          .hunk-header.hunk-unselected {
            border-left-color: var(--vscode-editor-inactiveSelectionBackground);
          }
          
          .hunk-content {
            /* Container for hunk diff lines */
          }
          
          .commit-section {
            border-top: 1px solid var(--vscode-panel-border);
            padding: 12px 16px;
            background-color: var(--vscode-editor-background);
            flex-shrink: 0;
          }
          
          .commit-message-container {
            margin-bottom: 12px;
          }
          
          .commit-message-label {
            display: block;
            margin-bottom: 6px;
            font-size: 12px;
            font-weight: 500;
          }
          
          .commit-message-input {
            width: 100%;
            min-height: 60px;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            resize: vertical;
          }
          
          .commit-message-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
          }
          
          .commit-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          
          .commit-info {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
          }
          
          .commit-buttons {
            display: flex;
            gap: 8px;
            align-items: center;
          }
          
          .amend-checkbox-container {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-right: 12px;
          }
          
          .amend-checkbox-container label {
            font-size: 12px;
            cursor: pointer;
          }
          
          .btn {
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.2s;
          }
          
          .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
          }
          
          .btn-primary:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
          }
          
          .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          
          .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
          }
          
          .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Commit Changes</h1>
        </div>
        
        <div class="main-container">
          <div class="file-list-panel">
            <div class="file-list-header">
              Files (${selectedCount}/${totalCount} selected)
            </div>
            <div class="file-list" id="file-list"></div>
          </div>
        </div>
        
        <div class="commit-section">
          <div class="commit-message-container">
            <label class="commit-message-label" for="commit-message">Commit Message:</label>
            <textarea 
              id="commit-message" 
              class="commit-message-input" 
              placeholder="Enter your commit message here..."
              autofocus
            ></textarea>
          </div>
          
          <div class="commit-actions">
            <div class="commit-info">
              ${selectedCount} file${selectedCount !== 1 ? 's' : ''} selected
            </div>
            <div class="commit-buttons">
              <div class="amend-checkbox-container">
                <input type="checkbox" id="amend-checkbox" />
                <label for="amend-checkbox">Amend</label>
              </div>
              <button class="btn btn-secondary" onclick="cancel()">Cancel</button>
              <button class="btn btn-primary" id="commit-button" onclick="commit()" ${selectedCount === 0 ? 'disabled' : ''}>Commit</button>
            </div>
          </div>
        </div>
        
        <div class="diff-section" id="diff-section" style="display: none;">
          <div class="diff-header">
            <span id="diff-header-text">Select a file to view diff</span>
          </div>
          <div class="diff-content" id="diff-content">
            <div class="diff-empty" style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); font-size: 13px;">Select a file from the list to view its changes</div>
          </div>
        </div>
        
        <script>
          const vscode = acquireVsCodeApi();
          const allFiles = ${JSON.stringify(webviewFiles)};
          let selectedFiles = ${JSON.stringify(Array.from(this.selectedFileIds))};
          let selectedHunks = ${JSON.stringify(Object.fromEntries(Array.from(this.selectedHunksByFile.entries()).map(([f, h]) => [f, Array.from(h)])))};
          let currentFileId = null;
          // Initialize fileHunks with data from all files so hunk counts are always available
          let fileHunks = ${JSON.stringify(Object.fromEntries(Array.from(this.fileHunks.entries()).map(([fileId, hunks]) => [fileId, hunks.map(h => ({ id: h.id, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, isSelected: false, belongsToChangelist: false, changelistId: h.changelistId }))])))};
          
          // Simple flag to prevent recursive updates
          let updatingUI = false;
          const INDENT_PER_LEVEL = 14;

          function buildFolderTree(files) {
            const root = { children: {}, files: [] };
            for (const file of files) {
              const parts = (file.relativePath || file.path || '').split(/[\\/]/);
              const fileName = parts.pop() || file.name;
              const dirParts = parts;
              let node = root;
              for (const part of dirParts) {
                if (!part) continue;
                if (!node.children[part]) {
                  node.children[part] = { children: {}, files: [] };
                }
                node = node.children[part];
              }
              node.files.push({ ...file, displayName: fileName });
            }
            return root;
          }

          function renderFiles(files, container, depth) {
            const sorted = [...files].sort((a, b) => a.displayName.localeCompare(b.displayName));
            for (const file of sorted) {
              const isSelected = selectedFiles.includes(file.id);
              const fileHunksForFile = fileHunks[file.id] || [];
              const selectedHunksForFile = selectedHunks[file.id] || [];

              const fileItem = document.createElement('div');
              fileItem.className = 'file-item' + (isSelected ? ' selected' : '');
              fileItem.setAttribute('data-file-id', file.id);
              fileItem.style.paddingLeft = (depth * INDENT_PER_LEVEL) + 'px';

              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.className = 'file-checkbox';
              checkbox.setAttribute('data-file-id', file.id);
              checkbox.checked = isSelected;

              const statusSpan = document.createElement('span');
              statusSpan.className = 'file-status ' + file.status;
              statusSpan.textContent = file.statusLabel;

              const nameSpan = document.createElement('span');
              nameSpan.className = 'file-name';
              nameSpan.setAttribute('data-file-id', file.id);
              nameSpan.textContent = file.displayName || file.name;

              fileItem.appendChild(checkbox);
              fileItem.appendChild(statusSpan);
              fileItem.appendChild(nameSpan);

              if (fileHunksForFile.length > 0) {
                const hunkSummary = document.createElement('span');
                hunkSummary.className = 'hunk-count';
                hunkSummary.textContent = selectedHunksForFile.length + '/' + fileHunksForFile.length + ' hunk' + (fileHunksForFile.length === 1 ? '' : 's');
                nameSpan.parentNode.insertBefore(hunkSummary, nameSpan.nextSibling);
              }

              container.appendChild(fileItem);
            }
          }

          function renderFolder(node, container, depth, parentPath) {
            const folderNames = Object.keys(node.children).sort();
            for (const folderName of folderNames) {
              const folderNode = node.children[folderName];
              const folderPath = parentPath ? parentPath + '/' + folderName : folderName;

              const folderElement = document.createElement('div');
              folderElement.className = 'tree-folder';
              folderElement.setAttribute('data-folder-path', folderPath);

              const folderRow = document.createElement('div');
              folderRow.className = 'folder-row';
              folderRow.style.paddingLeft = (depth * INDENT_PER_LEVEL) + 'px';

              const toggle = document.createElement('span');
              toggle.className = 'folder-toggle';
              // Use a larger filled triangle so the caret is visually prominent
              toggle.textContent = '▼';

              const nameSpan = document.createElement('span');
              nameSpan.className = 'folder-name';
              nameSpan.textContent = folderName;

              folderRow.appendChild(toggle);
              folderRow.appendChild(nameSpan);
              folderElement.appendChild(folderRow);

              const childrenContainer = document.createElement('div');
              childrenContainer.className = 'tree-children';
              folderElement.appendChild(childrenContainer);

              toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const isCollapsed = childrenContainer.style.display === 'none';
                childrenContainer.style.display = isCollapsed ? '' : 'none';
                toggle.textContent = isCollapsed ? '▼' : '▶';
              });

              container.appendChild(folderElement);

              // Render files that live directly in this folder
              renderFiles(folderNode.files, childrenContainer, depth + 1);
              // Render sub-folders
              renderFolder(folderNode, childrenContainer, depth + 1, folderPath);
            }

            // Render files that are directly under the current node (for root)
            if (parentPath === '') {
              renderFiles(node.files, container, depth);
            }
          }

          function renderTree() {
            const list = document.getElementById('file-list');
            if (!list) return;
            list.innerHTML = '';
            if (!allFiles || allFiles.length === 0) {
              list.innerHTML = '<div style="padding: 12px; color: var(--vscode-descriptionForeground);">No files</div>';
              return;
            }

            const tree = buildFolderTree(allFiles);
            renderFolder(tree, list, 0, '');
          }

          renderTree();

          // File checkbox handler - check flag first
          document.addEventListener('change', function(e) {
            if (updatingUI) return;
            const target = e.target;
            if (target && target.classList && target.classList.contains('file-checkbox')) {
              e.stopPropagation();
              const fileId = target.getAttribute('data-file-id');
              if (fileId) {
                vscode.postMessage({ command: 'selectFile', fileId: fileId });
              }
            }
          });
          
          // File click to view diff (controls the active/highlighted file)
          document.addEventListener('click', function(e) {
            const target = e.target;
            if (!target || !(target instanceof HTMLElement)) return;
            if (target.classList.contains('file-checkbox')) {
              return;
            }
            const fileItem = target.closest('.file-item');
            if (fileItem) {
              const fileId = fileItem.getAttribute('data-file-id');
              if (fileId) {
                currentFileId = fileId;
                // Update only the active (highlighted) file; selection is driven by checkboxes
                document.querySelectorAll('.file-item').forEach(item => {
                  item.classList.remove('active');
                });
                fileItem.classList.add('active');
                vscode.postMessage({ command: 'viewFile', fileId: fileId });
                vscode.postMessage({ command: 'getDiff', fileId: fileId });
              }
            }
          });
          
          // Listen for messages from extension
          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
              case 'updateSelection':
                selectedFiles = message.selectedFiles || [];
                selectedHunks = message.selectedHunks || {};
                
                updatingUI = true;
                try {
                  // Update file checkboxes - ONLY set the ones that need changing
                  document.querySelectorAll('.file-checkbox').forEach(checkbox => {
                    const fileId = checkbox.getAttribute('data-file-id');
                    const shouldBeChecked = selectedFiles.includes(fileId);
                    if (checkbox.checked !== shouldBeChecked) {
                      checkbox.checked = shouldBeChecked;
                    }
                  });
                  
                  // Update hunk checkboxes - ONLY set the ones that need changing
                  document.querySelectorAll('.hunk-checkbox').forEach(checkbox => {
                    const hunkId = checkbox.getAttribute('data-hunk-id');
                    const fileId = checkbox.getAttribute('data-file-id');
                    if (hunkId && fileId) {
                      const selectedHunksForFile = selectedHunks[fileId] || [];
                      const shouldBeChecked = selectedHunksForFile.includes(hunkId);
                      if (checkbox.checked !== shouldBeChecked) {
                        checkbox.checked = shouldBeChecked;
                      }
                    }
                  });
                  
                  // Update hunk counts - CRITICAL: Make sure they're visible
                  document.querySelectorAll('.file-item').forEach(item => {
                    const fileId = item.getAttribute('data-file-id');
                    const selectedHunksForFile = selectedHunks[fileId] || [];
                    const fileHunksForFile = fileHunks[fileId] || [];
                    let hunkCountElement = item.querySelector('.hunk-count');
                    const nameSpan = item.querySelector('.file-name');
                    if (fileHunksForFile.length > 0) {
                      if (!hunkCountElement) {
                        hunkCountElement = document.createElement('span');
                        hunkCountElement.className = 'hunk-count';
                        if (nameSpan && nameSpan.nextSibling) {
                          nameSpan.parentNode.insertBefore(hunkCountElement, nameSpan.nextSibling);
                        } else {
                          item.appendChild(hunkCountElement);
                        }
                      }
                      hunkCountElement.textContent = selectedHunksForFile.length + '/' + fileHunksForFile.length + ' hunk' + (fileHunksForFile.length === 1 ? '' : 's');
                      hunkCountElement.style.display = '';
                    } else if (hunkCountElement) {
                      hunkCountElement.style.display = 'none';
                    }
                  });
                  
                  // Update "all hunks" checkbox state for each file if present
                  document.querySelectorAll('.all-hunks-checkbox').forEach(checkbox => {
                    const fileId = checkbox.getAttribute('data-file-id');
                    const selectedHunksForFile = selectedHunks[fileId] || [];
                    const fileHunksForFile = fileHunks[fileId] || [];
                    const selectableHunks = fileHunksForFile.filter(h => h.belongsToChangelist);
                    const allHunksSelected = selectableHunks.length > 0 && selectableHunks.every(h => selectedHunksForFile.includes(h.id));
                    const shouldBeDisabled = selectableHunks.length === 0;
                    if (checkbox.checked !== allHunksSelected) {
                      checkbox.checked = allHunksSelected;
                    }
                    // Show half-checked when some but not all selectable hunks are selected
                    const someHunksSelected = selectableHunks.some(h => selectedHunksForFile.includes(h.id));
                    checkbox.indeterminate = !allHunksSelected && someHunksSelected && !shouldBeDisabled;
                    checkbox.disabled = shouldBeDisabled;
                  });
                  
                  // Update commit button
                  const commitButton = document.getElementById('commit-button');
                  if (commitButton) {
                    commitButton.disabled = selectedFiles.length === 0;
                  }
                  
                  // Update commit info
                  const commitInfo = document.querySelector('.commit-info');
                  if (commitInfo) {
                    commitInfo.textContent = selectedFiles.length + ' file' + (selectedFiles.length !== 1 ? 's' : '') + ' selected';
                  }
                  
                  // Update file list header
                  const fileListHeader = document.querySelector('.file-list-header');
                  if (fileListHeader) {
                    fileListHeader.textContent = 'Files (' + selectedFiles.length + '/' + ${this.allFiles.length} + ' selected)';
                  }
                } finally {
                  updatingUI = false;
                }
                break;
              case 'diffContent':
                displayDiff(message.fileId, message.diff, message.hunks, message.originalContent, message.modifiedContent);
                fileHunks[message.fileId] = message.hunks;
                // Update hunk count for this file after diff is loaded
                const fileItem = document.querySelector('[data-file-id="' + message.fileId + '"]');
                if (fileItem) {
                  const fileItemElement = fileItem.closest('.file-item');
                  if (fileItemElement) {
                    const selectedHunksForFile = selectedHunks[message.fileId] || [];
                    const fileHunksForFile = fileHunks[message.fileId] || [];
                    let hunkCountElement = fileItemElement.querySelector('.hunk-count');
                    const nameSpan = fileItemElement.querySelector('.file-name');
                    if (fileHunksForFile.length > 0) {
                      if (!hunkCountElement) {
                        hunkCountElement = document.createElement('span');
                        hunkCountElement.className = 'hunk-count';
                        if (nameSpan && nameSpan.nextSibling) {
                          nameSpan.parentNode.insertBefore(hunkCountElement, nameSpan.nextSibling);
                        } else {
                          fileItemElement.appendChild(hunkCountElement);
                        }
                      }
                        hunkCountElement.textContent = selectedHunksForFile.length + '/' + fileHunksForFile.length + ' hunk' + (fileHunksForFile.length === 1 ? '' : 's');
                      hunkCountElement.style.display = '';
                    }
                  }
                }
                break;
            }
          });
          
          function displayDiff(fileId, diffText, hunks, originalContent, modifiedContent) {
            try {
            const diffSection = document.getElementById('diff-section');
            const diffContent = document.getElementById('diff-content');
            const diffHeader = document.getElementById('diff-header-text');
            
            if ((!diffText || diffText === 'Error loading diff') && !originalContent && !modifiedContent) {
              diffContent.innerHTML = '<div class="diff-empty" style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); font-size: 13px;">Error loading diff</div>';
              diffHeader.textContent = 'Error';
              diffSection.style.display = 'flex';
              return;
            }
            
            const file = ${JSON.stringify(this.allFiles)}.find(f => f.id === fileId);
            if (file) {
              diffHeader.textContent = file.name + ' (' + file.relativePath + ')';
            }
            
            diffSection.style.display = 'flex';
            
            // Build full-file line models for original and modified contents
            const originalLines = (originalContent || '').split('\\n');
            const modifiedLines = (modifiedContent || '').split('\\n');

            // Parse diff text to determine line types (added/removed/context) and build correspondence map
            const originalLineTypes = new Array(originalLines.length).fill('context');
            const modifiedLineTypes = new Array(modifiedLines.length).fill('context');
            // Maps: original line index -> modified line index (or -1 if no correspondence)
            const originalToModified = new Map();
            // Maps: modified line index -> original line index (or -1 if no correspondence)
            const modifiedToOriginal = new Map();
            
            if (diffText && diffText !== 'Error loading diff') {
              const diffLines = diffText.split('\\n');
              let oldLineNum = 0;
              let newLineNum = 0;
              
              for (const line of diffLines) {
                if (line.startsWith('@@')) {
                  // Hunk header - extract line numbers
                  const match = line.match(/@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/);
                  if (match) {
                    oldLineNum = parseInt(match[1], 10) - 1; // Convert to 0-based index
                    newLineNum = parseInt(match[3], 10) - 1;
                  }
                  continue;
                }
                
                if (line.startsWith('---') || line.startsWith('+++')) {
                  continue;
                }
                
                if (line.startsWith('-') && !line.startsWith('---')) {
                  // Removed line - no corresponding modified line
                  if (oldLineNum >= 0 && oldLineNum < originalLineTypes.length) {
                    originalLineTypes[oldLineNum] = 'removed';
                    originalToModified.set(oldLineNum, -1); // No correspondence
                  }
                  oldLineNum++;
                } else if (line.startsWith('+') && !line.startsWith('+++')) {
                  // Added line - no corresponding original line
                  if (newLineNum >= 0 && newLineNum < modifiedLineTypes.length) {
                    modifiedLineTypes[newLineNum] = 'added';
                    modifiedToOriginal.set(newLineNum, -1); // No correspondence
                  }
                  newLineNum++;
                } else if (line.startsWith(' ')) {
                  // Context line (unchanged) - both sides correspond
                  if (oldLineNum >= 0 && oldLineNum < originalLineTypes.length && 
                      newLineNum >= 0 && newLineNum < modifiedLineTypes.length) {
                    originalToModified.set(oldLineNum, newLineNum);
                    modifiedToOriginal.set(newLineNum, oldLineNum);
                  }
                  oldLineNum++;
                  newLineNum++;
                }
              }
            }

            // Map line numbers to hunk metadata
            const originalLineMeta = [];
            const modifiedLineMeta = [];

            for (let i = 0; i < originalLines.length; i++) {
              originalLineMeta.push({
                num: i + 1,
                content: originalLines[i],
                type: originalLineTypes[i] || 'context',
                hunk: null,
                isFirstInHunk: false
              });
            }

            for (let i = 0; i < modifiedLines.length; i++) {
              modifiedLineMeta.push({
                num: i + 1,
                content: modifiedLines[i],
                type: modifiedLineTypes[i] || 'context',
                hunk: null,
                isFirstInHunk: false
              });
            }

            // Attach hunk references to the corresponding line ranges
            // All lines in hunk ranges get hunk info (for tracking), but only changed lines get highlighting
            (hunks || []).forEach(h => {
              const isSelected = h.isSelected;
              const belongsToChangelist = h.belongsToChangelist;

              // Old side range
              const oldStartIndex = (h.oldStart || 1) - 1;
              const oldEndIndex = oldStartIndex + (h.oldLines || 0);
              for (let i = oldStartIndex; i < oldEndIndex && i < originalLineMeta.length; i++) {
                originalLineMeta[i].hunk = {
                  id: h.id,
                  isSelected,
                  belongsToChangelist
                };
                if (i === oldStartIndex) {
                  originalLineMeta[i].isFirstInHunk = true;
                }
              }

              // New side range
              const newStartIndex = (h.newStart || 1) - 1;
              const newEndIndex = newStartIndex + (h.newLines || 0);
              for (let i = newStartIndex; i < newEndIndex && i < modifiedLineMeta.length; i++) {
                modifiedLineMeta[i].hunk = {
                  id: h.id,
                  isSelected,
                  belongsToChangelist
                };
                if (i === newStartIndex) {
                  modifiedLineMeta[i].isFirstInHunk = true;
                }
              }
            });

            // Determine which lines to show (only hunks + context)
            const CONTEXT_LINES = 3; // Number of context lines before/after each hunk
            const linesToShowOriginal = new Set();
            const linesToShowModified = new Set();
            
            // Collect all hunk ranges with context
            (hunks || []).forEach(h => {
              const oldStartIndex = (h.oldStart || 1) - 1;
              const oldEndIndex = oldStartIndex + (h.oldLines || 0);
              const newStartIndex = (h.newStart || 1) - 1;
              const newEndIndex = newStartIndex + (h.newLines || 0);
              
              // Add context before
              const contextStartOld = Math.max(0, oldStartIndex - CONTEXT_LINES);
              const contextStartNew = Math.max(0, newStartIndex - CONTEXT_LINES);
              
              // Add hunk lines
              for (let i = oldStartIndex; i < oldEndIndex && i < originalLineMeta.length; i++) {
                linesToShowOriginal.add(i);
              }
              for (let i = newStartIndex; i < newEndIndex && i < modifiedLineMeta.length; i++) {
                linesToShowModified.add(i);
              }
              
              // Add context after
              const contextEndOld = Math.min(originalLineMeta.length, oldEndIndex + CONTEXT_LINES);
              const contextEndNew = Math.min(modifiedLineMeta.length, newEndIndex + CONTEXT_LINES);
              
              for (let i = contextStartOld; i < contextEndOld; i++) {
                linesToShowOriginal.add(i);
              }
              for (let i = contextStartNew; i < contextEndNew; i++) {
                linesToShowModified.add(i);
              }
            });
            
            // Convert to sorted arrays for rendering
            const sortedOriginalLines = Array.from(linesToShowOriginal).sort((a, b) => a - b);
            const sortedModifiedLines = Array.from(linesToShowModified).sort((a, b) => a - b);
            
            // If no hunks, show all lines (fallback)
            if (sortedOriginalLines.length === 0 && sortedModifiedLines.length === 0) {
              for (let i = 0; i < originalLineMeta.length; i++) {
                sortedOriginalLines.push(i);
              }
              for (let i = 0; i < modifiedLineMeta.length; i++) {
                sortedModifiedLines.push(i);
              }
            }

            // Build aligned rendering arrays with separator markers
            const originalRenderItems = [];
            const modifiedRenderItems = [];
            
            // Track last corresponding lines to know where to insert separators
            let lastOriginalWithCorrespondence = -1;
            let lastModifiedWithCorrespondence = -1;
            
            // For original side: include all lines, insert separators for pure additions
            for (let i = 0; i < sortedOriginalLines.length; i++) {
              const lineIdx = sortedOriginalLines[i];
              const lineMeta = originalLineMeta[lineIdx];
              const correspondingModified = originalToModified.get(lineIdx);
              
              // Check for gap separator
              if (i > 0 && sortedOriginalLines[i] - sortedOriginalLines[i - 1] > 1) {
                const gapSize = sortedOriginalLines[i] - sortedOriginalLines[i - 1] - 1;
                originalRenderItems.push({
                  type: 'separator',
                  gapSize: gapSize,
                  prevLineNum: sortedOriginalLines[i - 1] + 1,
                  nextLineNum: sortedOriginalLines[i] + 1
                });
              }
              
              // Check if we need to insert separator for pure additions
              // If this line has correspondence and we've seen pure additions since last correspondence
              if (correspondingModified !== undefined && correspondingModified !== -1) {
                lastOriginalWithCorrespondence = originalRenderItems.length;
              }
              
              originalRenderItems.push({ type: 'line', index: lineIdx, meta: lineMeta });
            }
            
            // For modified side: include all lines, insert separators for pure deletions
            for (let i = 0; i < sortedModifiedLines.length; i++) {
              const lineIdx = sortedModifiedLines[i];
              const lineMeta = modifiedLineMeta[lineIdx];
              const correspondingOriginal = modifiedToOriginal.get(lineIdx);
              
              // Check for gap separator
              if (i > 0 && sortedModifiedLines[i] - sortedModifiedLines[i - 1] > 1) {
                const gapSize = sortedModifiedLines[i] - sortedModifiedLines[i - 1] - 1;
                modifiedRenderItems.push({
                  type: 'separator',
                  gapSize: gapSize,
                  prevLineNum: sortedModifiedLines[i - 1] + 1,
                  nextLineNum: sortedModifiedLines[i] + 1
                });
              }
              
              // Check if we need to insert separator for pure deletions
              // If this line has correspondence and we've seen pure deletions since last correspondence
              if (correspondingOriginal !== undefined && correspondingOriginal !== -1) {
                lastModifiedWithCorrespondence = modifiedRenderItems.length;
              }
              
              modifiedRenderItems.push({ type: 'line', index: lineIdx, meta: lineMeta });
            }
            
            // Add placeholders for all hunk types (additions/deletions/modifications) to equalize hunk heights
            // Handle multiple non-adjacent change blocks within the same hunk
            const processedModificationHunks = new Set();
            
            // Helper to find contiguous blocks of changed lines
            function findChangedLineBlocks(renderItems, hunkId, changeType) {
              const blocks = [];
              let currentBlock = null;
              
              for (let i = 0; i < renderItems.length; i++) {
                const item = renderItems[i];
                if (item.type === 'line' && item.meta && item.meta.hunk && 
                    item.meta.hunk.id === hunkId && item.meta.type === changeType) {
                  if (!currentBlock) {
                    currentBlock = { startIndex: i, endIndex: i, count: 1 };
                  } else {
                    currentBlock.endIndex = i;
                    currentBlock.count++;
                  }
                } else {
                  if (currentBlock) {
                    blocks.push(currentBlock);
                    currentBlock = null;
                  }
                }
              }
              if (currentBlock) {
                blocks.push(currentBlock);
              }
              
              return blocks;
            }
            
            // Process each hunk to find modification blocks
            const allHunkIds = new Set();
            originalRenderItems.forEach(item => {
              if (item.type === 'line' && item.meta && item.meta.hunk) {
                allHunkIds.add(item.meta.hunk.id);
              }
            });
            modifiedRenderItems.forEach(item => {
              if (item.type === 'line' && item.meta && item.meta.hunk) {
                allHunkIds.add(item.meta.hunk.id);
              }
            });
            
            allHunkIds.forEach(hunkId => {
              // Find blocks of removed lines in original and added lines in modified
              const removedBlocks = findChangedLineBlocks(originalRenderItems, hunkId, 'removed');
              const addedBlocks = findChangedLineBlocks(modifiedRenderItems, hunkId, 'added');
              
              const lineHeight = 20; // Approximate line height in pixels
              
              // Handle pure additions: no removed lines, only added lines
              if (removedBlocks.length === 0 && addedBlocks.length > 0) {
                // Find insertion point: after the last line before the first added block in modified
                let insertPos = -1;
                for (let i = 0; i < modifiedRenderItems.length; i++) {
                  const item = modifiedRenderItems[i];
                  if (item.type === 'line' && item.meta && item.meta.hunk && 
                      item.meta.hunk.id === hunkId && item.meta.type === 'added') {
                    // Find the previous line with correspondence in original
                    for (let j = i - 1; j >= 0; j--) {
                      const prevItem = modifiedRenderItems[j];
                      if (prevItem.type === 'line' && prevItem.meta) {
                        const prevOrigIdx = modifiedToOriginal.get(prevItem.index);
                        if (prevOrigIdx !== undefined && prevOrigIdx !== -1) {
                          const origPos = originalRenderItems.findIndex(origItem => 
                            origItem.type === 'line' && origItem.index === prevOrigIdx
                          );
                          if (origPos >= 0) {
                            insertPos = origPos + 1;
                            break;
                          }
                        }
                      }
                    }
                    break;
                  }
                }
                
                if (insertPos >= 0) {
                  const totalAddedHeight = addedBlocks.reduce((sum, block) => sum + block.count * lineHeight, 0);
                  originalRenderItems.splice(insertPos, 0, {
                    type: 'modification-placeholder',
                    hunkId: hunkId,
                    height: totalAddedHeight
                  });
                }
                return;
              }
              
              // Handle pure deletions: removed lines, no added lines
              if (removedBlocks.length > 0 && addedBlocks.length === 0) {
                // Find insertion point: after the last line before the first removed block in original
                let insertPos = -1;
                for (let i = 0; i < originalRenderItems.length; i++) {
                  const item = originalRenderItems[i];
                  if (item.type === 'line' && item.meta && item.meta.hunk && 
                      item.meta.hunk.id === hunkId && item.meta.type === 'removed') {
                    // Find the previous line with correspondence in modified
                    for (let j = i - 1; j >= 0; j--) {
                      const prevItem = originalRenderItems[j];
                      if (prevItem.type === 'line' && prevItem.meta) {
                        const prevModIdx = originalToModified.get(prevItem.index);
                        if (prevModIdx !== undefined && prevModIdx !== -1) {
                          const modPos = modifiedRenderItems.findIndex(modItem => 
                            modItem.type === 'line' && modItem.index === prevModIdx
                          );
                          if (modPos >= 0) {
                            insertPos = modPos + 1;
                            break;
                          }
                        }
                      }
                    }
                    break;
                  }
                }
                
                if (insertPos >= 0) {
                  const totalRemovedHeight = removedBlocks.reduce((sum, block) => sum + block.count * lineHeight, 0);
                  modifiedRenderItems.splice(insertPos, 0, {
                    type: 'modification-placeholder',
                    hunkId: hunkId,
                    height: totalRemovedHeight
                  });
                }
                return;
              }
              
              // Handle modifications: both sides have changes
              if (removedBlocks.length > 0 && addedBlocks.length > 0) {
                // Match blocks by order (first removed block matches first added block, etc.)
                const maxBlocks = Math.max(removedBlocks.length, addedBlocks.length);
                
                // Insert placeholders after each block pair where heights differ
                // Process in reverse order to maintain indices
                for (let blockIdx = maxBlocks - 1; blockIdx >= 0; blockIdx--) {
                  const removedBlock = removedBlocks[blockIdx] || null;
                  const addedBlock = addedBlocks[blockIdx] || null;
                  
                  if (!removedBlock && !addedBlock) continue;
                  
                  const removedCount = removedBlock ? removedBlock.count : 0;
                  const addedCount = addedBlock ? addedBlock.count : 0;
                  const heightDiff = (addedCount - removedCount) * lineHeight;
                  
                  if (Math.abs(heightDiff) > 1) {
                    if (heightDiff > 0 && removedBlock) {
                      // Modified side is taller - add placeholder to original after this removed block
                      originalRenderItems.splice(removedBlock.endIndex + 1, 0, {
                        type: 'modification-placeholder',
                        hunkId: hunkId,
                        height: heightDiff
                      });
                    } else if (heightDiff < 0 && addedBlock) {
                      // Original side is taller - add placeholder to modified after this added block
                      modifiedRenderItems.splice(addedBlock.endIndex + 1, 0, {
                        type: 'modification-placeholder',
                        hunkId: hunkId,
                        height: -heightDiff
                      });
                    }
                  }
                }
              }
            });

            // Render side-by-side without hunk headers, with inline checkboxes
            let html = '';
            
            html += '<div class="diff-sides-container">';
            
            // Left side (old/original)
            html += '<div class="diff-side" id="diff-side-original">';
            html += '<div class="diff-side-header">Original</div>';
            
            for (const item of originalRenderItems) {
              if (item.type === 'separator') {
                html += '<div class="diff-separator">';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '<div class="diff-separator-text">' + item.gapSize + ' line' + (item.gapSize !== 1 ? 's' : '') + ' hidden (lines ' + item.prevLineNum + '–' + (item.nextLineNum - 1) + ')</div>';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '</div>';
              } else if (item.type === 'modification-placeholder') {
                // Placeholder for modifications to equalize hunk heights
                const placeholderHunkId = item.hunkId ? escapeHtml(item.hunkId) : '';
                html += '<div class="diff-line diff-placeholder diff-placeholder-original"' + (placeholderHunkId ? ' data-hunk-id="' + placeholderHunkId + '"' : '') + ' style="height: ' + item.height + 'px; min-height: ' + item.height + 'px;">';
                html += '<div class="diff-line-checkbox-container"></div>';
                html += '<div class="diff-line-number old"></div>';
                html += '<div class="diff-line-content placeholder"></div>';
                html += '</div>';
              } else if (item.type === 'line') {
                const lineMeta = item.meta;
                const hunkInfo = lineMeta.hunk;
                // Only apply hunk highlighting to changed lines (removed), not context lines
                let hunkClass = '';
                let otherChangelistClass = '';
                if (hunkInfo) {
                  if (!hunkInfo.belongsToChangelist) {
                    // Lines from other changelists: muted greyish
                    otherChangelistClass = 'other-changelist';
                  } else if (lineMeta.type === 'removed') {
                    // Changed lines (removed): bluish background
                    hunkClass = hunkInfo.isSelected ? 'hunk-selected' : 'hunk-unselected';
                  }
                }

                // Add data-hunk-id to all lines with hunk info for scroll synchronization
                html += '<div class="diff-line ' + hunkClass + ' ' + otherChangelistClass + '"' + (hunkInfo ? ' data-hunk-id="' + escapeHtml(hunkInfo.id) + '"' : '') + '>';
                // Spacer to align with modified side checkboxes
                html += '<div class="diff-line-checkbox-container"></div>';
                html += '<div class="diff-line-number' + (lineMeta.type === 'removed' ? ' old' : '') + '">' + (lineMeta.num || '') + '</div>';
                html += '<div class="diff-line-content ' + lineMeta.type + '">' + escapeHtml(lineMeta.content) + '</div>';
                html += '</div>';
              }
            }
            html += '</div>';
            
            // Right side (new/modified)
            html += '<div class="diff-side" id="diff-side-modified">';
            // Determine all-hunks checkbox state for this file
            const selectedHunksForFile = selectedHunks[fileId] || [];
            const selectableHunks = (hunks || []).filter(h => h.belongsToChangelist);
            const allHunksSelected = selectableHunks.length > 0 && selectableHunks.every(h => selectedHunksForFile.includes(h.id));
            const someHunksSelected = selectableHunks.some(h => selectedHunksForFile.includes(h.id));
            html += '<div class="diff-side-header">';
            html += '<input type="checkbox" class="all-hunks-checkbox" data-file-id="' + fileId + '"' +
                    (allHunksSelected ? ' checked' : '') +
                    (selectableHunks.length === 0 ? ' disabled' : '') +
                    ' />';
            html += '<span>Modified</span>';
            html += '</div>';

            // Track which hunks have shown their checkbox
            const hunksWithCheckbox = new Set();
            
            for (const item of modifiedRenderItems) {
              if (item.type === 'separator') {
                html += '<div class="diff-separator">';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '<div class="diff-separator-text">' + item.gapSize + ' line' + (item.gapSize !== 1 ? 's' : '') + ' hidden (lines ' + item.prevLineNum + '–' + (item.nextLineNum - 1) + ')</div>';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '</div>';
              } else if (item.type === 'modification-placeholder') {
                // Placeholder for modifications to equalize hunk heights
                const placeholderHunkId = item.hunkId ? escapeHtml(item.hunkId) : '';
                html += '<div class="diff-line diff-placeholder diff-placeholder-modified"' + (placeholderHunkId ? ' data-hunk-id="' + placeholderHunkId + '"' : '') + ' style="height: ' + item.height + 'px; min-height: ' + item.height + 'px;">';
                html += '<div class="diff-line-checkbox-container"></div>';
                html += '<div class="diff-line-number"></div>';
                html += '<div class="diff-line-content placeholder"></div>';
                html += '</div>';
              } else if (item.type === 'line') {
                const lineMeta = item.meta;
                const hunkInfo = lineMeta.hunk;
                // Determine if this is a changed line (modified) or pure addition
                // Changed lines appear when both sides have changes in the same hunk
                let hunkClass = '';
                let otherChangelistClass = '';
                if (hunkInfo) {
                  if (!hunkInfo.belongsToChangelist) {
                    // Lines from other changelists: muted greyish
                    otherChangelistClass = 'other-changelist';
                  } else if (lineMeta.type === 'added') {
                    // Check if this is a pure addition or a changed line
                    // Pure additions have no corresponding removed lines in the same hunk
                    // Changed lines have both removed and added lines in the same hunk
                    const hunk = (hunks || []).find(h => h.id === hunkInfo.id);
                    if (hunk) {
                      // Check if this hunk has removed lines (indicating a change, not pure addition)
                      // Pure additions have no removed lines in the original side
                      // Changed lines have removed lines in the original side
                      let hasRemovedLines = false;
                      
                      // Check if this is a pure addition or a change
                      // Pure additions: oldLines === 0 (no lines removed from original)
                      // Changed lines: oldLines > 0 (some lines removed from original)
                      if (hunk.oldLines === 0) {
                        // Definitely a pure addition - no removed lines
                        hasRemovedLines = false;
                      } else {
                        // oldLines > 0, check if any of those lines are actually removed (not just context)
                        const oldStartIndex = (hunk.oldStart || 1) - 1;
                        const oldEndIndex = oldStartIndex + (hunk.oldLines || 0);
                        for (let k = oldStartIndex; k < oldEndIndex && k < originalLineMeta.length; k++) {
                          if (originalLineMeta[k] && originalLineMeta[k].type === 'removed') {
                            // Found a removed line - this is a change, not a pure addition
                            hasRemovedLines = true;
                            break;
                          }
                        }
                      }
                      
                      if (hasRemovedLines) {
                        // This hunk has removed lines, so added lines in it are part of a change
                        // Changed lines (modified): bluish background
                        hunkClass = hunkInfo.isSelected ? 'hunk-selected' : 'hunk-unselected';
                      } else {
                        // Pure additions (hunk has no removed lines): explicitly set to empty string
                        // This ensures NO hunk-selected or hunk-unselected class is applied
                        // CSS will then apply the default green background
                        hunkClass = '';
                      }
                    } else {
                      // No hunk found - treat as pure addition
                      hunkClass = '';
                    }
                  }
                }

                // Add data-hunk-id to all lines with hunk info for scroll synchronization
                // Trim classes to avoid extra spaces and ensure pure additions don't get hunk classes
                const classes = [hunkClass, otherChangelistClass].filter(c => c && c.trim()).join(' ');
                html += '<div class="diff-line' + (classes ? ' ' + classes : '') + '"' + (hunkInfo ? ' data-hunk-id="' + escapeHtml(hunkInfo.id) + '"' : '') + '>';
                
                // Add checkbox inline with first changed line of hunk (no separate header)
                // Only show checkbox on first changed line of each hunk
                html += '<div class="diff-line-checkbox-container">';
                if (hunkInfo && lineMeta.type === 'added' && !hunksWithCheckbox.has(hunkInfo.id)) {
                  hunksWithCheckbox.add(hunkInfo.id);
                  const disabled = !hunkInfo.belongsToChangelist;
                  html += '<input type="checkbox" class="hunk-checkbox" data-file-id="' + fileId + '" data-hunk-id="' + hunkInfo.id + '"' +
                          (hunkInfo.isSelected ? ' checked' : '') +
                          (disabled ? ' disabled' : '') +
                          ' />';
                }
                html += '</div>';
                
                html += '<div class="diff-line-number' + (lineMeta.type === 'added' ? ' new' : '') + '">' + (lineMeta.num || '') + '</div>';
                html += '<div class="diff-line-content ' + lineMeta.type + '">' + escapeHtml(lineMeta.content) + '</div>';
                html += '</div>';
              }
            }
            html += '</div>';
            html += '</div>';
            
            diffContent.innerHTML = html;

            
            // Set indeterminate state for the "all hunks" checkbox on the active file
            const allHunksCheckbox = diffContent.querySelector('.all-hunks-checkbox');
            if (allHunksCheckbox) {
              allHunksCheckbox.indeterminate = !allHunksSelected && someHunksSelected;
            }
            
            // Attach click handlers directly to each hunk checkbox
            document.querySelectorAll('.hunk-checkbox').forEach(checkbox => {
              checkbox.addEventListener('click', function(e) {
                if (updatingUI) {
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                }
                
                if (this.disabled) {
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                }
                
                const fileId = this.getAttribute('data-file-id');
                const hunkId = this.getAttribute('data-hunk-id');
                
                if (fileId && hunkId) {
                  e.stopPropagation();
                  e.preventDefault();
                  vscode.postMessage({ command: 'selectHunk', fileId: fileId, hunkId: hunkId });
                  return false;
                }
              });
            });

            // Attach handler for "all hunks" checkbox in the Modified header
            document.querySelectorAll('.all-hunks-checkbox').forEach(checkbox => {
              checkbox.addEventListener('click', function(e) {
                if (updatingUI) {
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                }
                
                if (this.disabled) {
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                }
                
                const fileId = this.getAttribute('data-file-id');
                const select = this.checked;
                if (fileId) {
                  e.stopPropagation();
                  vscode.postMessage({ command: 'selectAllHunks', fileId: fileId, select: select });
                  return false;
                }
              });
            });

            // Simple absolute scroll synchronization between original and modified panes.
            // Because we have stretched pure-addition/deletion separators to match the
            // height of their corresponding hunks on the other side, the total content
            // heights of both panes should now be effectively equal, so we can just
            // mirror scrollTop.
            requestAnimationFrame(function () {
              requestAnimationFrame(function () {
                var originalSide = document.getElementById('diff-side-original');
                var modifiedSide = document.getElementById('diff-side-modified');

                if (!originalSide || !modifiedSide) {
                  return;
                }

                var syncingFromOriginal = false;
                var syncingFromModified = false;
                var programmaticScrollContainer = null;

                originalSide.addEventListener('scroll', function () {
                  if (programmaticScrollContainer === originalSide) {
                    return;
                  }
                  if (syncingFromModified) {
                    return;
                  }

                  syncingFromOriginal = true;
                  requestAnimationFrame(function () {
                    programmaticScrollContainer = modifiedSide;
                    modifiedSide.scrollTop = originalSide.scrollTop;
                    requestAnimationFrame(function () {
                      programmaticScrollContainer = null;
                      syncingFromOriginal = false;
                    });
                  });
                }, { passive: true });

                modifiedSide.addEventListener('scroll', function () {
                  if (programmaticScrollContainer === modifiedSide) {
                    return;
                  }
                  if (syncingFromOriginal) {
                    return;
                  }

                  syncingFromModified = true;
                  requestAnimationFrame(function () {
                    programmaticScrollContainer = originalSide;
                    originalSide.scrollTop = modifiedSide.scrollTop;
                    requestAnimationFrame(function () {
                      programmaticScrollContainer = null;
                      syncingFromModified = false;
                    });
                  });
                }, { passive: true });
              });
            });
            } catch (error) {
              console.error('Error rendering diff:', error);
              const diffContent = document.getElementById('diff-content');
              const diffHeader = document.getElementById('diff-header-text');
              if (diffContent) {
                diffContent.innerHTML = '<div class="diff-empty" style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); font-size: 13px;">Error rendering diff</div>';
              }
              if (diffHeader) {
                diffHeader.textContent = 'Error';
              }
            }
          }
          
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
          
          function commit() {
            const message = document.getElementById('commit-message').value.trim();
            const amend = document.getElementById('amend-checkbox').checked;
            
            if (!message) {
              alert('Please enter a commit message');
              return;
            }
            
            if (selectedFiles.length === 0) {
              alert('Please select at least one file');
              return;
            }
            
            vscode.postMessage({
              command: 'commit',
              message: message,
              amend: amend
            });
          }
          
          function cancel() {
            vscode.postMessage({ command: 'cancel' });
          }
          
          // Keyboard shortcuts
          document.getElementById('commit-message').addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              cancel();
            }
          });
          
          // Auto-activate first selected file (only highlight the active file)
          if (selectedFiles.length > 0) {
            const firstFileId = selectedFiles[0];
            currentFileId = firstFileId;
            document.querySelectorAll('.file-item').forEach(item => {
              item.classList.remove('active');
            });
            const firstFileItem = document.querySelector('[data-file-id="' + firstFileId + '"]');
            if (firstFileItem) {
              firstFileItem.closest('.file-item').classList.add('active');
            }
            vscode.postMessage({ command: 'viewFile', fileId: firstFileId });
            vscode.postMessage({ command: 'getDiff', fileId: firstFileId });
          }
        </script>
      </body>
      </html>
    `;
  }

  private getStatusLabel(status: string): string {
    const labels: { [key: string]: string } = {
      modified: 'M',
      added: 'A',
      deleted: 'D',
      untracked: 'U',
      renamed: 'R',
    };
    return labels[status] || status;
  }

  private escapeHtml(text: string): string {
    const div = { textContent: text };
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
