import * as vscode from 'vscode';
import { Hunk, Changelist } from './types';
import { GitService } from './gitService';

export class HunkDecorationProvider {
  private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
  private activeDecorations: Map<vscode.TextEditor, Map<string, vscode.DecorationOptions[]>> = new Map();
  private gitService: GitService;
  private changelists: Changelist[] = [];
  private activeChangelistId: string | undefined;
  private hunkAssignments: Map<string, string> = new Map(); // hunkId -> changelistId
  private hunksByFile: Map<string, Hunk[]> = new Map(); // filePath -> hunks
  private lastAppliedDecorations: Map<vscode.TextEditor, string> = new Map(); // editor -> serialized decorations
  private lastChangelistIds: string = ''; // Serialized changelist IDs for change detection
  private lastActiveChangelistId: string | undefined; // Track last active changelist ID
  private changelistColors: Map<string, { color: string; isActive: boolean }> = new Map(); // Store colors for dynamic icon creation

  constructor(gitService: GitService) {
    this.gitService = gitService;
  }

  updateChangelists(changelists: Changelist[]): void {
    // Check if changelists actually changed
    const newIds = changelists.map(c => c.id).sort().join(',');
    const changelistsChanged = newIds !== this.lastChangelistIds;
    
    this.changelists = changelists;
    this.lastChangelistIds = newIds;
    
    // Only recreate decoration types if changelists changed or active state changed
    const activeChanged = this.activeChangelistId !== this.lastActiveChangelistId;
    if (changelistsChanged || activeChanged) {
      this.updateDecorationTypes();
      // Clear last applied decorations cache so they'll be reapplied with new types
      this.lastAppliedDecorations.clear();
      // Immediately update decorations after recreating types
      this.updateAllDecorations();
    }
  }

  updateActiveChangelist(activeChangelistId: string | undefined): void {
    const changed = this.activeChangelistId !== activeChangelistId;
    this.activeChangelistId = activeChangelistId;
    this.lastActiveChangelistId = activeChangelistId;
    if (changed) {
      // Recreate decoration types to reflect active/inactive state
      this.updateDecorationTypes();
      // Clear last applied decorations so they'll be reapplied
      this.lastAppliedDecorations.clear();
      // Update all decorations
      this.updateAllDecorations();
    }
  }

  updateHunkAssignments(assignments: Map<string, string>): void {
    this.hunkAssignments = assignments;
  }

  updateHunksByFile(hunksByFile: Map<string, Hunk[]>): void {
    // Check if hunks actually changed by comparing serialized versions
    const newSerialized = this.serializeHunksByFile(hunksByFile);
    const oldSerialized = this.serializeHunksByFile(this.hunksByFile);
    
    if (newSerialized === oldSerialized) {
      return; // No changes, skip update to prevent blinking
    }
    
    this.hunksByFile = hunksByFile;
    // Update decorations immediately for visible editors
    this.updateAllDecorations();
  }

  private serializeHunksByFile(hunksByFile: Map<string, Hunk[]>): string {
    const entries = Array.from(hunksByFile.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filePath, hunks]) => {
        const hunkIds = hunks.map(h => `${h.id}:${h.newStart}:${h.newLines}:${h.changelistId || ''}`).sort().join('|');
        return `${filePath}:${hunkIds}`;
      });
    return entries.join('||');
  }

  private updateDecorationTypes(): void {
    // Always recreate decoration types to ensure active/inactive state is correct
    // This is necessary because the icon style (filled vs hollow) depends on active state
    // Dispose old decoration types
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    this.decorationTypes.clear();

    // Create decoration types for each changelist
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

    // Assign colors to changelists - use same logic as tree view
    // Count non-default changelists to get consistent color indices
    for (let i = 0; i < this.changelists.length; i++) {
      const changelist = this.changelists[i];
      const isActive = changelist.id === this.activeChangelistId;
      
      let color: string;
      if (changelist.isDefault) {
        // Default changelist always gets gray
        color = '#9E9E9E';
      } else {
        // Count non-default changelists before this one to get the color index
        const nonDefaultBefore = this.changelists.slice(0, i).filter(c => !c.isDefault).length;
        color = colors[nonDefaultBefore % colors.length];
      }
      
      const decorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: this.createGutterIcon(color, isActive),
        gutterIconSize: 'auto', // Use 'auto' to fill the line height completely
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        isWholeLine: false,
      });

      this.decorationTypes.set(changelist.id, decorationType);
    }

    // Default decoration for hunks without changelist assignment (fallback)
    if (!this.decorationTypes.has('default')) {
      const isDefaultActive = 'default' === this.activeChangelistId;
      this.changelistColors.set('default', { color: '#9E9E9E', isActive: isDefaultActive });
      const defaultDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: this.createGutterIcon('#9E9E9E', isDefaultActive),
        gutterIconSize: 'auto',
        overviewRulerColor: '#9E9E9E',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        isWholeLine: false,
      });
      this.decorationTypes.set('default', defaultDecorationType);
    }
  }

  private createGutterIcon(color: string, isActive: boolean): vscode.Uri {
    // Create a thin vertical line as SVG (3px wide, full line height)
    // Active changelists: filled, non-active: hollow (outlined)
    // Using a tall icon (100px) that will be scaled to line height by VS Code
    // When multiple lines use the same icon, they should appear continuous
    let svg: string;
    if (isActive) {
      // Filled rectangle for active changelist - make it tall to ensure no gaps
      svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="3" height="100" viewBox="0 0 3 100" preserveAspectRatio="none">
          <rect width="3" height="100" fill="${color}" opacity="0.8"/>
        </svg>
      `;
    } else {
      // Hollow rectangle (outline) for non-active changelist
      // Draw as filled rectangles for top/bottom edges and lines for sides
      // This ensures top and bottom edges are always visible even when scaled
      const strokeWidth = 1.5;
      const edgeHeight = 1.5; // Height of top/bottom edge rectangles
      svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="3" height="100" viewBox="0 0 3 100" preserveAspectRatio="none">
          <!-- Top edge as filled rectangle -->
          <rect x="0" y="0" width="3" height="${edgeHeight}" fill="${color}" opacity="0.8"/>
          <!-- Right edge -->
          <line x1="3" y1="0" x2="3" y2="100" stroke="${color}" stroke-width="${strokeWidth}" opacity="0.8" stroke-linecap="square"/>
          <!-- Bottom edge as filled rectangle -->
          <rect x="0" y="${100 - edgeHeight}" width="3" height="${edgeHeight}" fill="${color}" opacity="0.8"/>
          <!-- Left edge -->
          <line x1="0" y1="0" x2="0" y2="100" stroke="${color}" stroke-width="${strokeWidth}" opacity="0.8" stroke-linecap="square"/>
        </svg>
      `;
    }
    const encoded = Buffer.from(svg).toString('base64');
    return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
  }

  private async updateAllDecorations(): Promise<void> {
    // Update all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      await this.updateDecorationsForEditor(editor);
    }
  }

  async updateDecorationsForEditor(editor: vscode.TextEditor): Promise<void> {
    if (!editor || !editor.document) {
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) {
      return;
    }

    const relativePath = vscode.workspace.asRelativePath(filePath);
    let hunks = this.hunksByFile.get(relativePath) || [];
    
    // If hunks aren't available yet, try fetching them directly (for immediate display)
    if (hunks.length === 0 && this.gitService) {
      try {
        const unstagedHunks = await this.gitService.getFileHunks(relativePath);
        const stagedHunks = await this.gitService.getStagedHunks(relativePath);
        hunks = [...unstagedHunks, ...stagedHunks];
        
        // Assign changelists to directly-fetched hunks
        for (const hunk of hunks) {
          if (!hunk.changelistId) {
            const assignedChangelistId = this.hunkAssignments.get(hunk.id);
            hunk.changelistId = assignedChangelistId || 'default';
          }
        }
        
        // Cache them
        if (hunks.length > 0) {
          this.hunksByFile.set(relativePath, hunks);
        }
      } catch (error) {
        // Ignore errors
      }
    }

    // Don't proceed if we have no hunks or no decoration types
    if (hunks.length === 0 || this.decorationTypes.size === 0) {
      return;
    }

    // Build decorations
    const decorationsByChangelist = this.buildDecorationsForHunks(hunks);
    
    // Serialize decorations to check if they changed
    const serialized = this.serializeDecorations(decorationsByChangelist);
    const lastSerialized = this.lastAppliedDecorations.get(editor);
    
    // Only update if decorations actually changed
    if (serialized === lastSerialized) {
      return;
    }
    
    this.lastAppliedDecorations.set(editor, serialized);

    // Clear existing decorations for this editor using old decoration types
    // We need to clear all possible decoration types, not just the ones we tracked
    // because decoration types might have been recreated
    const activeTypes = this.activeDecorations.get(editor) || new Map();
    for (const changelistId of activeTypes.keys()) {
      // Try to clear using old types - if they're disposed, this is a no-op
      try {
        const oldType = this.decorationTypes.get(changelistId);
        if (oldType) {
          editor.setDecorations(oldType, []);
        }
      } catch (error) {
        // Type might be disposed, ignore
      }
    }
    
    // Also clear using all current decoration types to ensure clean state
    for (const [changelistId, decorationType] of this.decorationTypes.entries()) {
      try {
        editor.setDecorations(decorationType, []);
      } catch (error) {
        // Ignore errors
      }
    }
    
    this.activeDecorations.set(editor, new Map());

    // Apply new decorations - ensure decoration types exist
    const newActiveDecorations = new Map<string, vscode.DecorationOptions[]>();
    for (const [changelistId, decorations] of decorationsByChangelist.entries()) {
      const decorationType = this.decorationTypes.get(changelistId);
      if (decorationType && decorations.length > 0) {
        try {
          editor.setDecorations(decorationType, decorations);
          newActiveDecorations.set(changelistId, decorations);
        } catch (error) {
          // Decoration type might be disposed, skip
          console.error('Error applying decorations:', error);
        }
      }
    }
    this.activeDecorations.set(editor, newActiveDecorations);
  }

  private serializeDecorations(decorationsByChangelist: Map<string, vscode.DecorationOptions[]>): string {
    const sorted = Array.from(decorationsByChangelist.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([changelistId, decorations]) => {
        const ranges = decorations.map(d => `${d.range.start.line}-${d.range.end.line}`).sort().join(',');
        return `${changelistId}:${ranges}`;
      });
    return sorted.join('|');
  }

  private buildDecorationsForHunks(hunks: Hunk[]): Map<string, vscode.DecorationOptions[]> {
    const decorationsByChangelist: Map<string, vscode.DecorationOptions[]> = new Map();

    for (const hunk of hunks) {
      const changelistId = this.hunkAssignments.get(hunk.id) || hunk.changelistId || 'default';
      const decorationType = this.decorationTypes.get(changelistId);
      
      if (!decorationType) {
        continue;
      }

      // Create one decoration per line to form a continuous vertical box
      // When the same decoration type is applied to consecutive lines, VS Code renders them as continuous
      const startLine = Math.max(0, hunk.newStart - 1);
      const endLine = Math.max(0, hunk.newStart + hunk.newLines - 2); // -2 because newStart is 1-based and we already -1
      
      const hoverMessage = new vscode.MarkdownString(
        `**Hunk** (Lines ${hunk.newStart}-${hunk.newStart + hunk.newLines - 1})\n\n` +
        `Changelist: ${this.getChangelistName(changelistId)}\n` +
        `Status: ${hunk.isStaged ? 'Staged' : 'Unstaged'}\n\n` +
        `Right-click to move to different changelist`
      );

      // Create one decoration per line in the hunk
      // The decoration type already has the icon set, so all lines will use the same icon
      // When applied to consecutive lines, they appear as a continuous vertical box
      for (let line = startLine; line <= endLine; line++) {
        const range = new vscode.Range(line, 0, line, 0);
        
        const decoration: vscode.DecorationOptions = {
          range: range,
          hoverMessage: hoverMessage,
        };

        if (!decorationsByChangelist.has(changelistId)) {
          decorationsByChangelist.set(changelistId, []);
        }
        decorationsByChangelist.get(changelistId)!.push(decoration);
      }
    }

    return decorationsByChangelist;
  }

  getHunkAtLine(filePath: string, line: number): Hunk | null {
    const hunks = this.hunksByFile.get(filePath) || [];
    for (const hunk of hunks) {
      const hunkStart = hunk.newStart;
      const hunkEnd = hunk.newStart + hunk.newLines - 1;
      if (line >= hunkStart && line <= hunkEnd) {
        return hunk;
      }
    }
    return null;
  }

  private getChangelistName(changelistId: string): string {
    const changelist = this.changelists.find(c => c.id === changelistId);
    return changelist ? changelist.name : 'Default';
  }

  getChangelistColor(changelistId: string): string {
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
    
    const changelist = this.changelists.find(c => c.id === changelistId);
    if (!changelist) {
      return '#9E9E9E';
    }
    
    if (changelist.isDefault) {
      return '#9E9E9E';
    }
    
    // Count non-default changelists before this one to get the color index
    const index = this.changelists.findIndex(c => c.id === changelistId);
    const nonDefaultBefore = this.changelists.slice(0, index).filter(c => !c.isDefault).length;
    return colors[nonDefaultBefore % colors.length];
  }

  dispose(): void {
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    this.decorationTypes.clear();
    this.activeDecorations.clear();
    this.lastAppliedDecorations.clear();
  }
}
