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
            margin: 0 4px 0 8px;
            flex-shrink: 0;
            align-self: center;
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
            background-color: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground) 40%, transparent);
          }
          
          .diff-line.hunk-selected .diff-line-content {
            background-color: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground) 40%, transparent);
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
            background-color: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground) 30%, var(--vscode-editor-inactiveSelectionBackground) 70%);
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

            // Parse diff text to determine line types (added/removed/context)
            const originalLineTypes = new Array(originalLines.length).fill('context');
            const modifiedLineTypes = new Array(modifiedLines.length).fill('context');
            
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
                  // Removed line
                  if (oldLineNum >= 0 && oldLineNum < originalLineTypes.length) {
                    originalLineTypes[oldLineNum] = 'removed';
                  }
                  oldLineNum++;
                } else if (line.startsWith('+') && !line.startsWith('+++')) {
                  // Added line
                  if (newLineNum >= 0 && newLineNum < modifiedLineTypes.length) {
                    modifiedLineTypes[newLineNum] = 'added';
                  }
                  newLineNum++;
                } else if (line.startsWith(' ')) {
                  // Context line (unchanged)
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

            // Render side-by-side without hunk headers, with inline checkboxes
            let html = '';
            
            html += '<div class="diff-sides-container">';
            
            // Left side (old/original)
            html += '<div class="diff-side" id="diff-side-original">';
            html += '<div class="diff-side-header">Original</div>';
            
            for (let idx = 0; idx < sortedOriginalLines.length; idx++) {
              const i = sortedOriginalLines[idx];
              const lineMeta = originalLineMeta[i];
              const hunkInfo = lineMeta.hunk;
              const hunkClass = hunkInfo
                ? (hunkInfo.isSelected ? 'hunk-selected' : 'hunk-unselected')
                : '';
              
              // Check if we should show a separator (gap in line numbers)
              const gapSize = idx > 0 ? (sortedOriginalLines[idx] - sortedOriginalLines[idx - 1] - 1) : 0;
              const showSeparator = gapSize > 0;

              if (showSeparator) {
                const prevLineNum = sortedOriginalLines[idx - 1] + 1;
                const nextLineNum = sortedOriginalLines[idx] + 1;
                const skippedLines = gapSize;
                html += '<div class="diff-separator">';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '<div class="diff-separator-text">' + skippedLines + ' line' + (skippedLines !== 1 ? 's' : '') + ' hidden (lines ' + prevLineNum + '–' + (nextLineNum - 1) + ')</div>';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '</div>';
              }

              html += '<div class="diff-line ' + hunkClass + '"' + (hunkInfo ? ' data-hunk-id="' + escapeHtml(hunkInfo.id) + '"' : '') + '>';
              // Spacer to align with modified side checkboxes
              html += '<div style="width: 20px; flex-shrink: 0;"></div>';
              html += '<div class="diff-line-number' + (lineMeta.type === 'removed' ? ' old' : '') + '">' + (lineMeta.num || '') + '</div>';
              html += '<div class="diff-line-content ' + lineMeta.type + '">' + escapeHtml(lineMeta.content) + '</div>';
              html += '</div>';
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

            for (let idx = 0; idx < sortedModifiedLines.length; idx++) {
              const i = sortedModifiedLines[idx];
              const lineMeta = modifiedLineMeta[i];
              const hunkInfo = lineMeta.hunk;
              const hunkClass = hunkInfo
                ? (hunkInfo.isSelected ? 'hunk-selected' : 'hunk-unselected')
                : '';
              
              // Check if we should show a separator (gap in line numbers)
              const gapSize = idx > 0 ? (sortedModifiedLines[idx] - sortedModifiedLines[idx - 1] - 1) : 0;
              const showSeparator = gapSize > 0;

              if (showSeparator) {
                const prevLineNum = sortedModifiedLines[idx - 1] + 1;
                const nextLineNum = sortedModifiedLines[idx] + 1;
                const skippedLines = gapSize;
                html += '<div class="diff-separator">';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '<div class="diff-separator-text">' + skippedLines + ' line' + (skippedLines !== 1 ? 's' : '') + ' hidden (lines ' + prevLineNum + '–' + (nextLineNum - 1) + ')</div>';
                html += '<div class="diff-separator-line"><span class="diff-separator-line-inner"></span></div>';
                html += '</div>';
              }

              html += '<div class="diff-line ' + hunkClass + '"' + (hunkInfo ? ' data-hunk-id="' + escapeHtml(hunkInfo.id) + '"' : '') + '>';
              
              // Add checkbox inline with first line of hunk (no separate header)
              if (lineMeta.isFirstInHunk && hunkInfo) {
                const disabled = !hunkInfo.belongsToChangelist;
                html += '<input type="checkbox" class="hunk-checkbox" data-file-id="' + fileId + '" data-hunk-id="' + hunkInfo.id + '"' +
                        (hunkInfo.isSelected ? ' checked' : '') +
                        (disabled ? ' disabled' : '') +
                        ' />';
              } else {
                // Empty space to align with lines that have checkboxes
                html += '<div style="width: 20px; flex-shrink: 0;"></div>';
              }
              
              html += '<div class="diff-line-number' + (lineMeta.type === 'added' ? ' new' : '') + '">' + (lineMeta.num || '') + '</div>';
              html += '<div class="diff-line-content ' + lineMeta.type + '">' + escapeHtml(lineMeta.content) + '</div>';
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

            // Synced scrolling between original and modified panes based on visible hunks
            // Use requestAnimationFrame to ensure DOM is fully rendered and layout is complete
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const originalSide = document.getElementById('diff-side-original');
                const modifiedSide = document.getElementById('diff-side-modified');
                
                if (!originalSide || !modifiedSide) return;
                
                let syncingFromOriginal = false;
                let syncingFromModified = false;

                // Find the hunk that is most visible and get its relative position in viewport
                function findVisibleHunkWithPosition(container) {
                  const scrollTop = container.scrollTop;
                  const viewportHeight = container.clientHeight;
                  const viewportTop = scrollTop;
                  const viewportBottom = scrollTop + viewportHeight;
                  const viewportCenter = scrollTop + viewportHeight / 2;
                  
                  // Get all lines with hunk IDs, grouped by hunk
                  const hunkGroups = new Map();
                  const lines = container.querySelectorAll('.diff-line[data-hunk-id]');
                  
                  for (const line of lines) {
                    const hunkId = line.getAttribute('data-hunk-id');
                    if (!hunkId) continue;
                    
                    if (!hunkGroups.has(hunkId)) {
                      hunkGroups.set(hunkId, []);
                    }
                    hunkGroups.get(hunkId).push(line);
                  }
                  
                  let bestHunk = null;
                  let bestScore = -1;
                  let bestHunkTop = 0;
                  let bestHunkBottom = 0;
                  
                  // For each hunk, calculate how much of it is visible
                  for (const [hunkId, hunkLines] of hunkGroups.entries()) {
                    if (hunkLines.length === 0) continue;
                    
                    // Find the top and bottom of this hunk group
                    let hunkTop = Infinity;
                    let hunkBottom = -Infinity;
                    
                    for (const line of hunkLines) {
                      const lineOffset = line.offsetTop;
                      const lineHeight = line.offsetHeight;
                      hunkTop = Math.min(hunkTop, lineOffset);
                      hunkBottom = Math.max(hunkBottom, lineOffset + lineHeight);
                    }
                    
                    // Calculate how much of this hunk is visible
                    const visibleTop = Math.max(viewportTop, hunkTop);
                    const visibleBottom = Math.min(viewportBottom, hunkBottom);
                    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
                    const hunkHeight = hunkBottom - hunkTop;
                    const visibilityRatio = hunkHeight > 0 ? visibleHeight / hunkHeight : 0;
                    
                    // Also consider distance from viewport center
                    const hunkCenter = (hunkTop + hunkBottom) / 2;
                    const distanceFromCenter = Math.abs(hunkCenter - viewportCenter);
                    const maxDistance = viewportHeight;
                    const distanceScore = 1 - Math.min(1, distanceFromCenter / maxDistance);
                    
                    // Combined score: visibility ratio + distance score
                    const score = visibilityRatio * 0.7 + distanceScore * 0.3;
                    
                    if (score > bestScore) {
                      bestScore = score;
                      bestHunk = hunkId;
                      bestHunkTop = hunkTop;
                      bestHunkBottom = hunkBottom;
                    }
                  }
                  
                  if (!bestHunk) return null;
                  
                  // Calculate relative position: where is the hunk top relative to viewport top (0-1)
                  const relativePosition = (bestHunkTop - viewportTop) / viewportHeight;
                  
                  return {
                    hunkId: bestHunk,
                    relativePosition: relativePosition,
                    hunkTop: bestHunkTop,
                    hunkBottom: bestHunkBottom
                  };
                }

                // Scroll target pane to show the same hunk at the same relative position
                function scrollTargetToMatchSource(targetContainer, hunkInfo) {
                  if (!hunkInfo || !hunkInfo.hunkId) return;
                  
                  const firstLine = targetContainer.querySelector('.diff-line[data-hunk-id="' + hunkInfo.hunkId + '"]');
                  if (!firstLine) return;
                  
                  // Find all lines of this hunk in target
                  const hunkLines = targetContainer.querySelectorAll('.diff-line[data-hunk-id="' + hunkInfo.hunkId + '"]');
                  if (hunkLines.length === 0) return;
                  
                  // Calculate hunk bounds in target
                  let targetHunkTop = Infinity;
                  for (const line of hunkLines) {
                    targetHunkTop = Math.min(targetHunkTop, line.offsetTop);
                  }
                  
                  // Calculate target scroll position to match relative position
                  const viewportHeight = targetContainer.clientHeight;
                  const targetScroll = targetHunkTop - (hunkInfo.relativePosition * viewportHeight);
                  
                  // Use instant scrolling for synchronous updates (no animation)
                  targetContainer.scrollTop = Math.max(0, targetScroll);
                }

                originalSide.addEventListener('scroll', () => {
                  // Only sync if not already syncing from modified side
                  if (syncingFromModified) return;
                  
                  syncingFromOriginal = true;
                  
                  const hunkInfo = findVisibleHunkWithPosition(originalSide);
                  if (hunkInfo) {
                    scrollTargetToMatchSource(modifiedSide, hunkInfo);
                  }
                  
                  requestAnimationFrame(() => {
                    syncingFromOriginal = false;
                  });
                }, { passive: true });

                modifiedSide.addEventListener('scroll', () => {
                  // Only sync if not already syncing from original side
                  if (syncingFromOriginal) return;
                  
                  syncingFromModified = true;
                  
                  const hunkInfo = findVisibleHunkWithPosition(modifiedSide);
                  if (hunkInfo) {
                    scrollTargetToMatchSource(originalSide, hunkInfo);
                  }
                  
                  requestAnimationFrame(() => {
                    syncingFromModified = false;
                  });
                }, { passive: true });
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
