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
      const hunks = this.fileHunks.get(fileId) || [];
      const selectedHunks = this.selectedHunksByFile.get(fileId) || new Set();
      
      this.panel?.webview.postMessage({
        command: 'diffContent',
        fileId: fileId,
        diff: diffContent,
        hunks: hunks.map(h => {
          const hunkChangelistId = this.hunkAssignments.get(h.id) || h.changelistId || this.changelistId;
          const belongsToChangelist = hunkChangelistId === this.changelistId;
          return {
            id: h.id,
            oldStart: h.oldStart,
            oldLines: h.oldLines,
            newStart: h.newStart,
            newLines: h.newLines,
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
    const filesHtml = this.allFiles
      .map((file) => {
        const isSelected = this.selectedFileIds.has(file.id);
        const hunks = this.fileHunks.get(file.id) || [];
        const selectedHunks = this.selectedHunksByFile.get(file.id) || new Set();
        const allHunksSelected = hunks.length > 0 && hunks.every(h => selectedHunks.has(h.id));
        const someHunksSelected = hunks.some(h => selectedHunks.has(h.id));
        
        return `
          <div class="file-item ${isSelected ? 'selected' : ''}" data-file-id="${file.id}">
            <input 
              type="checkbox" 
              class="file-checkbox" 
              ${isSelected ? 'checked' : ''}
              data-file-id="${file.id}"
            />
            <span class="file-status ${file.status}">${this.getStatusLabel(file.status)}</span>
            <span class="file-name" data-file-id="${file.id}">${this.escapeHtml(file.name)}</span>
            <span class="file-path">${this.escapeHtml(file.relativePath)}</span>
            ${hunks.length > 0 ? `<span class="hunk-count">${selectedHunks.size}/${hunks.length} hunks</span>` : ''}
          </div>
        `;
      })
      .join('');

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
          
          .file-checkbox {
            margin: 0;
            cursor: pointer;
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
            flex: 1;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
          }
          
          .file-path {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 100px;
            flex-shrink: 1;
          }
          
          .hunk-count {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            margin-left: auto;
            padding-left: 8px;
            min-width: 100px;
            text-align: right;
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
            background-color: var(--vscode-diffEditor-insertedLineBackground);
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
          
          .diff-line-content.added {
            background-color: var(--vscode-diffEditor-insertedLineBackground);
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
            background-color: var(--vscode-diffEditor-removedLineBackground);
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
          
          .hunk-checkbox:disabled {
            opacity: 0.5;
            cursor: not-allowed;
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
          }
          
          .hunk-checkbox {
            margin: 0;
            cursor: pointer;
          }
          
          .hunk-header-text {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
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
            <div class="file-list">
              ${filesHtml || '<div style="padding: 12px; color: var(--vscode-descriptionForeground);">No files</div>'}
            </div>
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
          let selectedFiles = ${JSON.stringify(Array.from(this.selectedFileIds))};
          let selectedHunks = ${JSON.stringify(Object.fromEntries(Array.from(this.selectedHunksByFile.entries()).map(([f, h]) => [f, Array.from(h)])))};
          let currentFileId = null;
          // Initialize fileHunks with data from all files so hunk counts are always available
          let fileHunks = ${JSON.stringify(Object.fromEntries(Array.from(this.fileHunks.entries()).map(([fileId, hunks]) => [fileId, hunks.map(h => ({ id: h.id, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, isSelected: false, belongsToChangelist: false, changelistId: h.changelistId }))])))};
          
          // File checkbox handler - check flag first
          document.addEventListener('change', function(e) {
            if (updatingUI) return;
            if (e.target.classList.contains('file-checkbox')) {
              e.stopPropagation();
              const fileId = e.target.getAttribute('data-file-id');
              if (fileId) {
                vscode.postMessage({ command: 'selectFile', fileId: fileId });
              }
            }
          });
          
          // Simple flag to prevent recursive updates
          let updatingUI = false;
          
          // File click to view diff (controls the active/highlighted file)
          document.querySelectorAll('.file-name, .file-item').forEach(element => {
            element.addEventListener('click', function(e) {
              if (e.target.type === 'checkbox') return;
              const fileId = this.getAttribute('data-file-id') || this.closest('.file-item').getAttribute('data-file-id');
              if (fileId) {
                currentFileId = fileId;
                // Update only the active (highlighted) file; selection is driven by checkboxes
                document.querySelectorAll('.file-item').forEach(item => {
                  item.classList.remove('active');
                });
                this.closest('.file-item').classList.add('active');
                vscode.postMessage({ command: 'viewFile', fileId: fileId });
                vscode.postMessage({ command: 'getDiff', fileId: fileId });
              }
            });
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
                    if (fileHunksForFile.length > 0) {
                      if (!hunkCountElement) {
                        hunkCountElement = document.createElement('span');
                        hunkCountElement.className = 'hunk-count';
                        item.appendChild(hunkCountElement);
                      }
                      hunkCountElement.textContent = selectedHunksForFile.length + '/' + fileHunksForFile.length + ' hunks';
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
                displayDiff(message.fileId, message.diff, message.hunks);
                fileHunks[message.fileId] = message.hunks;
                // Update hunk count for this file after diff is loaded
                const fileItem = document.querySelector('[data-file-id="' + message.fileId + '"]');
                if (fileItem) {
                  const fileItemElement = fileItem.closest('.file-item');
                  if (fileItemElement) {
                    const selectedHunksForFile = selectedHunks[message.fileId] || [];
                    const fileHunksForFile = fileHunks[message.fileId] || [];
                    let hunkCountElement = fileItemElement.querySelector('.hunk-count');
                    if (fileHunksForFile.length > 0) {
                      if (!hunkCountElement) {
                        hunkCountElement = document.createElement('span');
                        hunkCountElement.className = 'hunk-count';
                        fileItemElement.appendChild(hunkCountElement);
                      }
                      hunkCountElement.textContent = selectedHunksForFile.length + '/' + fileHunksForFile.length + ' hunks';
                      hunkCountElement.style.display = '';
                    }
                  }
                }
                break;
            }
          });
          
          function displayDiff(fileId, diffText, hunks) {
            const diffSection = document.getElementById('diff-section');
            const diffContent = document.getElementById('diff-content');
            const diffHeader = document.getElementById('diff-header-text');
            
            if (!diffText || diffText === 'Error loading diff') {
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
            
            // Parse diff and create side-by-side view
            const lines = diffText.split('\\n');
            let oldLines = [];
            let newLines = [];
            let oldLineNum = null;
            let newLineNum = null;
            let currentHunkIndex = 0;
            let hunkHeaders = [];
            
            // Process diff lines
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              
              // File header - skip
              if (line.startsWith('---') || line.startsWith('+++')) {
                continue;
              }
              
              // Hunk header
              if (line.startsWith('@@')) {
                // Find matching hunk
                let matchingHunk = null;
                const match = line.match(/@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/);
                if (match) {
                  const hunkOldStart = parseInt(match[1]);
                  const hunkNewStart = parseInt(match[3]);
                  
                  // Find matching hunk from the hunks array
                  for (let j = 0; j < hunks.length; j++) {
                    const hunk = hunks[j];
                    if (hunk.oldStart === hunkOldStart && hunk.newStart === hunkNewStart) {
                      matchingHunk = hunk;
                      currentHunkIndex = j;
                      break;
                    }
                  }
                  
                  // If no exact match, use next hunk in sequence
                  if (!matchingHunk && currentHunkIndex < hunks.length) {
                    matchingHunk = hunks[currentHunkIndex];
                  }
                  
                  // Store hunk header with actual start line numbers
                  currentHunkHeader = {
                    line: line,
                    hunk: matchingHunk,
                    oldStart: hunkOldStart,
                    newStart: hunkNewStart,
                    inserted: false
                  };
                  hunkHeaders.push(currentHunkHeader);
                  
                  // Set line numbers for the lines that follow this hunk
                  oldLineNum = hunkOldStart;
                  newLineNum = hunkNewStart;
                }
                continue;
              }
              
              // Diff lines - build parallel arrays
              // Track if this is the first line after a hunk header
              const isFirstLineOfHunk = currentHunkHeader && !currentHunkHeader.inserted;
              
              if (line.startsWith('+') && !line.startsWith('+++')) {
                oldLines.push({ type: 'empty', num: null, content: '', hunkHeader: isFirstLineOfHunk ? currentHunkHeader : null });
                newLines.push({ type: 'added', num: newLineNum, content: line.substring(1), hunkHeader: isFirstLineOfHunk ? currentHunkHeader : null });
                if (isFirstLineOfHunk) currentHunkHeader.inserted = true;
                if (newLineNum !== null) newLineNum++;
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                oldLines.push({ type: 'removed', num: oldLineNum, content: line.substring(1), hunkHeader: isFirstLineOfHunk ? currentHunkHeader : null });
                newLines.push({ type: 'empty', num: null, content: '', hunkHeader: null });
                if (isFirstLineOfHunk) currentHunkHeader.inserted = true;
                if (oldLineNum !== null) oldLineNum++;
              } else if (line.startsWith(' ')) {
                oldLines.push({ type: 'context', num: oldLineNum, content: line.substring(1), hunkHeader: isFirstLineOfHunk ? currentHunkHeader : null });
                newLines.push({ type: 'context', num: newLineNum, content: line.substring(1), hunkHeader: isFirstLineOfHunk ? currentHunkHeader : null });
                if (isFirstLineOfHunk) currentHunkHeader.inserted = true;
                if (oldLineNum !== null) oldLineNum++;
                if (newLineNum !== null) newLineNum++;
              } else if (line.trim() === '') {
                oldLines.push({ type: 'context', num: oldLineNum, content: '', hunkHeader: isFirstLineOfHunk ? currentHunkHeader : null });
                newLines.push({ type: 'context', num: newLineNum, content: '', hunkHeader: isFirstLineOfHunk ? currentHunkHeader : null });
                if (isFirstLineOfHunk) currentHunkHeader.inserted = true;
                if (oldLineNum !== null) oldLineNum++;
                if (newLineNum !== null) newLineNum++;
              }
            }
            
            // Render side-by-side with hunk headers
            let html = '';
            let hunkHeaderIndex = 0;
            let oldLineIndex = 0;
            let newLineIndex = 0;
            
            // Build combined structure with hunk headers
            html += '<div class="diff-sides-container">';
            
            // Left side (old)
            html += '<div class="diff-side">';
            html += '<div class="diff-side-header">Original</div>';
            oldLineIndex = 0;
            hunkHeaderIndex = 0;
            
            for (let i = 0; i < oldLines.length; i++) {
              const oldLine = oldLines[i];
              
              // Check if this line has a hunk header attached (first line of a hunk)
              // On the left side, we only show the hunk header text, no checkbox
              if (oldLine.hunkHeader) {
                const hunkHeader = oldLine.hunkHeader;
                html += '<div class="hunk-header">';
                html += '<span class="hunk-header-text">' + escapeHtml(hunkHeader.line) + '</span>';
                html += '</div>';
              }
              
              html += '<div class="diff-line">';
              html += '<div class="diff-line-number' + (oldLine.type === 'removed' ? ' old' : '') + '">' + (oldLine.num !== null ? oldLine.num : '') + '</div>';
              html += '<div class="diff-line-content ' + (oldLine.type === 'empty' ? 'empty' : oldLine.type) + '">' + escapeHtml(oldLine.content) + '</div>';
              html += '</div>';
            }
            html += '</div>';
            
            // Right side (new)
            html += '<div class="diff-side">';
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
            newLineIndex = 0;
            hunkHeaderIndex = 0;
            
            for (let i = 0; i < newLines.length; i++) {
              const newLine = newLines[i];
              
              // Check if this line has a hunk header attached (first line of a hunk)
              if (newLine.hunkHeader) {
                const hunkHeader = newLine.hunkHeader;
                const hunk = hunkHeader.hunk;
                html += '<div class="hunk-header">';
                if (hunk) {
                  const disabled = !hunk.belongsToChangelist;
                  html += '<input type="checkbox" class="hunk-checkbox" data-file-id="' + fileId + '" data-hunk-id="' + hunk.id + '" ' + 
                          (hunk.isSelected ? 'checked' : '') + ' ' + (disabled ? 'disabled' : '') + ' />';
                } else {
                  html += '<input type="checkbox" class="hunk-checkbox" disabled />';
                }
                html += '<span class="hunk-header-text">' + escapeHtml(hunkHeader.line) + '</span>';
                html += '</div>';
              }
              
              html += '<div class="diff-line">';
              html += '<div class="diff-line-number' + (newLine.type === 'added' ? ' new' : '') + '">' + (newLine.num !== null ? newLine.num : '') + '</div>';
              html += '<div class="diff-line-content ' + (newLine.type === 'empty' ? 'empty' : newLine.type) + '">' + escapeHtml(newLine.content) + '</div>';
              html += '</div>';
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
