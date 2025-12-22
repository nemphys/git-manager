import * as vscode from 'vscode';
import { FileItem, FileStatus, Hunk } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class GitService {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async getStatus(): Promise<FileItem[]> {
    try {
      const { stdout } = await this.executeGitCommand(['status', '--porcelain']);
      const files: FileItem[] = [];

      const lines = stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);

      for (const line of lines) {
        // Git status --porcelain format is always "XY path" where:
        // - Positions 0-1: status code (2 characters, can include spaces)
        // - Position 2: space separator (always present)
        // - Position 3+: file path
        // The path always starts at position 3
        const status = line.substring(0, 2);
        let path: string;
        
        if (status[0] === 'R' || status[1] === 'R') {
          // For renamed files, format is "R  oldpath -> newpath"
          // Path part starts at position 3
          const pathPart = line.substring(3);
          // Extract the new path (after " -> ")
          const arrowIndex = pathPart.indexOf(' -> ');
          path = arrowIndex !== -1 ? pathPart.substring(arrowIndex + 4) : pathPart;
        } else {
          // For all other statuses, path starts at position 3 (after "XY ")
          // However, we need to handle edge cases where the format might be slightly different
          // Check if position 2 is a space (standard format)
          if (line.length > 2 && line[2] === ' ') {
            path = line.substring(3);
          } else {
            // Fallback: find the first space after position 1 and take everything after it
            const spaceIndex = line.indexOf(' ', 1);
            if (spaceIndex !== -1) {
              path = line.substring(spaceIndex + 1);
            } else {
              // Last resort: assume path starts at position 2
              path = line.substring(2);
            }
          }
        }

        // Determine if file is staged (first char is not space)
        const isStaged = status[0] !== ' ' && status[0] !== '?';

        const fileItem: FileItem = {
          id: this.generateFileId(path),
          path: path,
          name: this.getFileName(path),
          status: this.parseStatus(status),
          isSelected: false,
          relativePath: path,
          isStaged: isStaged,
        };

        files.push(fileItem);
      }

      return files;
    } catch (error) {
      console.error('Error getting Git status:', error);
      return [];
    }
  }

  async commitFiles(files: FileItem[], message: string, options?: { amend?: boolean; changelistId?: string }): Promise<boolean> {
    try {
      if (files.length === 0) {
        throw new Error('No files selected for commit');
      }

      // Check if any files have hunks assigned to the changelist
      const filesWithHunks: FileItem[] = [];
      const filesWithoutHunks: FileItem[] = [];
      const hunksToStage: Hunk[] = [];

      for (const file of files) {
        if (file.hunks && file.hunks.length > 0 && options?.changelistId) {
          // File has hunks - collect hunks from this changelist
          const changelistHunks = file.hunks.filter(h => h.changelistId === options.changelistId);
          if (changelistHunks.length > 0) {
            filesWithHunks.push(file);
            hunksToStage.push(...changelistHunks);
          } else {
            // File has hunks but none in this changelist - skip it
            continue;
          }
        } else {
          // File has no hunks or no changelist specified - use file-level staging
          filesWithoutHunks.push(file);
        }
      }

      // Stage hunks if we have any
      if (hunksToStage.length > 0) {
        // First, unstage all changes in these files to start clean
        const filePaths = [...new Set(hunksToStage.map(h => h.filePath))];
        for (const filePath of filePaths) {
          try {
            await this.unstageFile(filePath);
          } catch (e) {
            // Ignore errors if file wasn't staged
          }
        }

        // Stage only the hunks from this changelist
        for (const hunk of hunksToStage) {
          await this.stageHunk(hunk);
        }
      }

      // Stage files without hunks (backward compatibility)
      for (const file of filesWithoutHunks) {
        switch (file.status) {
          case FileStatus.UNTRACKED:
          case FileStatus.ADDED:
          case FileStatus.MODIFIED:
          case FileStatus.RENAMED:
            await this.executeGitCommand(['add', '--', file.path]);
            break;
          case FileStatus.DELETED:
            // Stage deletion
            await this.executeGitCommand(['rm', '--', file.path]);
            break;
          default:
            await this.executeGitCommand(['add', '--', file.path]);
        }
      }

      const allFilePaths = [...new Set([...filesWithHunks.map(f => f.path), ...filesWithoutHunks.map(f => f.path)])];
      
      if (allFilePaths.length === 0) {
        throw new Error('No files to commit');
      }

      // Commit only the selected files (limit commit to these paths even if other files are staged)
      const commitArgs = ['commit', '-m', message, '--only'];
      if (options?.amend) {
        commitArgs.push('--amend', '--no-edit');
      }
      commitArgs.push('--', ...allFilePaths);
      await this.executeGitCommand(commitArgs);

      return true;
    } catch (error) {
      console.error('Error committing files:', error);
      vscode.window.showErrorMessage(`Failed to commit files: ${error}`);
      return false;
    }
  }

  async pushCurrentBranch(): Promise<boolean> {
    try {
      // Determine current branch
      const { stdout: branchOut } = await this.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchOut.trim();
      if (!branch || branch === 'HEAD') {
        throw new Error('Unable to determine current branch');
      }
      // Push with upstream if needed
      try {
        await this.executeGitCommand(['push']);
      } catch (e) {
        // Fallback: set upstream explicitly
        await this.executeGitCommand(['push', '--set-upstream', 'origin', branch]);
      }
      return true;
    } catch (error) {
      console.error('Error pushing branch:', error);
      vscode.window.showErrorMessage(`Failed to push: ${error}`);
      return false;
    }
  }

  async getUnversionedFiles(): Promise<FileItem[]> {
    try {
      const { stdout } = await this.executeGitCommand(['ls-files', '--others', '--exclude-standard']);
      const files: FileItem[] = [];

      const lines = stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const fileItem: FileItem = {
          id: this.generateFileId(line),
          path: line,
          name: this.getFileName(line),
          status: FileStatus.UNTRACKED,
          isSelected: false,
          relativePath: line,
        };

        files.push(fileItem);
      }

      return files;
    } catch (error) {
      console.error('Error getting unversioned files:', error);
      return [];
    }
  }

  /**
   * Returns the original (base) and modified (working tree) contents for a file,
   * suitable for side‑by‑side diff rendering.
   *
   * - MODIFIED / RENAMED: original = content from HEAD, modified = current workspace file
   * - ADDED / UNTRACKED:  original = empty,           modified = current workspace file
   * - DELETED:            original = content from HEAD, modified = empty
   */
  async getFileContentsForDiff(
    filePath: string,
    status: FileStatus
  ): Promise<{ originalContent: string; modifiedContent: string }> {
    try {
      const absolutePath = path.join(this.workspaceRoot, filePath);

      // Helper to safely read workspace file (returns '' if missing)
      const readWorkspaceFile = (): string => {
        try {
          if (fs.existsSync(absolutePath)) {
            return fs.readFileSync(absolutePath, 'utf8');
          }
        } catch {
          // Ignore and fall through to empty string
        }
        return '';
      };

      // Deleted files – show content only on the left (original)
      if (status === FileStatus.DELETED) {
        try {
          const { stdout } = await this.executeGitCommand(['show', `HEAD:${filePath}`]);
          return {
            originalContent: stdout,
            modifiedContent: '',
          };
        } catch {
          return {
            originalContent: '',
            modifiedContent: '',
          };
        }
      }

      // Added / untracked – only current workspace content on the right (modified)
      if (status === FileStatus.ADDED || status === FileStatus.UNTRACKED) {
        const modifiedContent = readWorkspaceFile();
        return {
          originalContent: '',
          modifiedContent,
        };
      }

      // Modified / renamed – HEAD content on the left, workspace on the right
      try {
        const [headResult] = await Promise.all([
          this.executeGitCommand(['show', `HEAD:${filePath}`]),
        ]);
        const originalContent = headResult.stdout;
        const modifiedContent = readWorkspaceFile();
        return {
          originalContent,
          modifiedContent,
        };
      } catch {
        // Fallback: if HEAD content is not available (e.g. new repo), just show workspace content
        const modifiedContent = readWorkspaceFile();
        return {
          originalContent: '',
          modifiedContent,
        };
      }
    } catch (error) {
      console.error('Error getting file contents for diff:', error);
      return {
        originalContent: '',
        modifiedContent: '',
      };
    }
  }

  async addFileToGit(filePath: string): Promise<boolean> {
    try {
      await this.executeGitCommand(['add', filePath]);
      return true;
    } catch (error) {
      console.error('Error adding file to Git:', error);
      return false;
    }
  }

  async stageFile(filePath: string): Promise<boolean> {
    try {
      await this.executeGitCommand(['add', filePath]);
      return true;
    } catch (error) {
      console.error('Error staging file:', error);
      return false;
    }
  }

  async unstageFile(filePath: string): Promise<boolean> {
    try {
      // Use git restore --staged (modern approach) or fallback to reset HEAD
      try {
        await this.executeGitCommand(['restore', '--staged', '--', filePath]);
      } catch (error) {
        // Fallback to reset HEAD for older git versions
        await this.executeGitCommand(['reset', 'HEAD', '--', filePath]);
      }
      return true;
    } catch (error) {
      console.error('Error unstaging file:', error);
      return false;
    }
  }

  async isFileTracked(filePath: string): Promise<boolean> {
    try {
      const { stdout } = await this.executeGitCommand(['ls-files', filePath]);
      return stdout.trim().length > 0;
    } catch (error) {
      console.error('Error checking if file is tracked:', error);
      return false;
    }
  }

  async revertFiles(files: FileItem[]): Promise<boolean> {
    try {
      if (files.length === 0) {
        throw new Error('No files selected for revert');
      }

      const filePaths = files.map((f) => f.path);

      // First, unstage the files (reset HEAD)
      await this.executeGitCommand(['reset', 'HEAD', '--', ...filePaths]);

      // Then, revert the unstaged changes
      // Prefer disabling hooks; if that fails, fall back to normal checkout
      const hooksBypassArgs = this.getHooksBypassArgs();
      try {
        await this.executeGitCommand([...hooksBypassArgs, 'checkout', '--', ...filePaths]);
      } catch (e) {
        // Fallback without bypass if the config flag/path is not supported in the environment
        await this.executeGitCommand(['checkout', '--', ...filePaths]);
      }

      return true;
    } catch (error) {
      console.error('Error reverting files:', error);
      vscode.window.showErrorMessage(`Failed to revert files: ${error}`);
      return false;
    }
  }

  async stashFiles(files: FileItem[], message?: string): Promise<boolean> {
    try {
      if (files.length === 0) {
        throw new Error('No files selected for stash');
      }

      // Clear any existing lock files before starting
      await this.clearLockFiles();

      // Check current git status before any operations
      const { stdout: statusBefore } = await this.executeGitCommand(['status', '--porcelain']);

      // Check current staged files
      const { stdout: stagedBefore } = await this.executeGitCommand(['diff', '--cached', '--name-only']);

      // The direct stash approach with file paths doesn't work as expected
      // It stashes all staged files PLUS the specified files, not just the specified files
      // So we need to use the staging approach which properly isolates only selected files
      return await this.stashFilesWithStaging(files, message);
    } catch (error) {
      console.error('Error stashing files:', error);
      vscode.window.showErrorMessage(`Failed to stash files: ${error}`);
      return false;
    }
  }

  private async stashFilesWithStaging(files: FileItem[], message?: string): Promise<boolean> {
    try {
      // Get current staged files to restore later
      const { stdout: stagedFilesOutput } = await this.executeGitCommand(['diff', '--cached', '--name-only']);
      const currentStagedFiles = stagedFilesOutput
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      // Get all modified files to track what we need to restore
      const { stdout: allModifiedFiles } = await this.executeGitCommand(['diff', '--name-only']);
      const modifiedFiles = allModifiedFiles
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      // Create a temporary commit with only the selected files
      const selectedFilePaths = files.map((f) => f.path);

      // First, unstage all files
      if (currentStagedFiles.length > 0) {
        await this.executeGitCommand(['reset', 'HEAD']);
      }

      // Stage only the selected files
      for (const file of files) {
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
          try {
            await this.clearLockFiles(); // Clear locks before each operation

            switch (file.status) {
              case FileStatus.UNTRACKED:
                await this.executeGitCommand(['add', '--', file.path]);
                break;
              case FileStatus.ADDED:
              case FileStatus.MODIFIED:
              case FileStatus.RENAMED:
                await this.executeGitCommand(['add', '--', file.path]);
                break;
              case FileStatus.DELETED:
                await this.executeGitCommand(['rm', '--', file.path]);
                break;
              default:
                await this.executeGitCommand(['add', '--', file.path]);
            }
            break; // Success, exit retry loop
          } catch (error) {
            retryCount++;
            if (retryCount >= maxRetries) {
              throw error;
            }
            // Wait a bit before retrying
            await new Promise((resolve) => setTimeout(resolve, 100 * retryCount));
          }
        }
      }

      // Check what's staged after our operations
      const { stdout: stagedAfter } = await this.executeGitCommand(['diff', '--cached', '--name-only']);

      // Create a stash with only the staged files (our selected files)
      const stashArgs = ['stash', 'push', '--staged'];
      if (message) {
        stashArgs.push('-m', message);
      }
      await this.executeGitCommand(stashArgs);

      // Check what was actually stashed
      const { stdout: stashList } = await this.executeGitCommand(['stash', 'list', '-1']);
      const { stdout: stashShow } = await this.executeGitCommand(['stash', 'show', '--name-only', 'stash@{0}']);

      // Now restore the original state: re-stage all the files that were staged before
      if (currentStagedFiles.length > 0) {
        for (const filePath of currentStagedFiles) {
          try {
            await this.clearLockFiles();
            await this.executeGitCommand(['add', '--', filePath]);
          } catch (e) {
            // File might have been deleted or changed, ignore
          }
        }
      }

      return true;
    } catch (error) {
      console.error('Error in staging approach:', error);
      throw error;
    }
  }

  private async clearLockFiles(): Promise<void> {
    const lockPaths = [
      path.join(this.workspaceRoot, '.git', 'index.lock'),
      path.join(this.workspaceRoot, '.git', 'refs', 'heads', '.lock'),
      path.join(this.workspaceRoot, '.git', 'MERGE_HEAD.lock'),
      path.join(this.workspaceRoot, '.git', 'MERGE_MODE.lock'),
      path.join(this.workspaceRoot, '.git', 'MERGE_MSG.lock'),
    ];

    for (const lockPath of lockPaths) {
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch (error) {
        // Ignore errors when removing lock files
        console.warn(`Could not remove lock file ${lockPath}:`, error);
      }
    }
  }

  private getHooksBypassArgs(): string[] {
    // On most systems, pointing hooksPath to a non-existent dir disables hooks.
    // To be safe across platforms, create an empty temp dir and point hooksPath there.
    try {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hooks-empty-'));
      return ['-c', `core.hooksPath=${tempDir}`];
    } catch {
      // Fallback to a commonly non-existent path; if unsupported, the caller will retry without it
      return ['-c', 'core.hooksPath=/dev/null'];
    }
  }

  private async executeGitCommand(
    args: string[],
    options?: { retryOnLock?: boolean }
  ): Promise<{ stdout: string; stderr: string }> {
    const retryOnLock = options?.retryOnLock !== false;
    try {
      return await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const child = spawn('git', args, { cwd: this.workspaceRoot, shell: false });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        child.on('error', (err: any) => {
          reject(new Error(stderr || String(err)));
        });
        child.on('close', (code: number) => {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `git exited with code ${code}`));
          } else {
            resolve({ stdout, stderr });
          }
        });
      });
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      const lockPath = path.join(this.workspaceRoot, '.git', 'index.lock');
      const lockDetected =
        msg.includes('index.lock') ||
        msg.includes('Another git process seems to be running') ||
        msg.includes('unable to write new index file') ||
        msg.includes('Unable to create') ||
        msg.includes('File exists') ||
        msg.includes('lock') ||
        msg.includes('fatal:');

      if (retryOnLock && lockDetected && fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          // Retry once without further retries to prevent loops
          return await this.executeGitCommand(args, { retryOnLock: false });
        } catch (unlinkErr) {
          // Fall through and rethrow original error
        }
      }

      throw err;
    }
  }

  private parseStatus(status: string): FileStatus {
    const x = status[0];
    const y = status[1];

    if (x === 'M' || y === 'M') {
      return FileStatus.MODIFIED;
    }
    if (x === 'A' || y === 'A') {
      return FileStatus.ADDED;
    }
    if (x === 'D' || y === 'D') {
      return FileStatus.DELETED;
    }
    if (x === 'R' || y === 'R') {
      return FileStatus.RENAMED;
    }
    if (x === '?' || y === '?') {
      return FileStatus.UNTRACKED;
    }

    return FileStatus.MODIFIED;
  }

  private getFileName(path: string): string {
    return path.split('/').pop() || path;
  }

  private generateFileId(path: string): string {
    return Buffer.from(path).toString('base64');
  }

  private generateHunkId(filePath: string, oldStart: number, newStart: number): string {
    return Buffer.from(`${filePath}:${oldStart}:${newStart}`).toString('base64');
  }

  async getFileHunks(filePath: string): Promise<Hunk[]> {
    try {
      // Get diff for the file.
      const { stdout } = await this.executeGitCommand(['diff', '--', filePath]);
      
      if (!stdout.trim()) {
        return [];
      }

      const hunks: Hunk[] = [];
      const lines = stdout.split('\n');
      let currentHunk: Partial<Hunk> | null = null;
      let hunkContent: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Match hunk header: @@ -oldStart,oldLines +newStart,newLines @@
        const hunkHeaderMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        
        if (hunkHeaderMatch) {
          // Save previous hunk if exists
          if (currentHunk) {
            currentHunk.content = hunkContent.join('\n');
            currentHunk.id = this.generateHunkId(
              filePath,
              currentHunk.oldStart!,
              currentHunk.newStart!
            );
            hunks.push(currentHunk as Hunk);
          }

          // Start new hunk
          const oldStart = parseInt(hunkHeaderMatch[1], 10);
          const oldLines = hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1;
          const newStart = parseInt(hunkHeaderMatch[3], 10);
          const newLines = hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1;

          currentHunk = {
            filePath: filePath,
            oldStart: oldStart,
            oldLines: oldLines,
            newStart: newStart,
            newLines: newLines,
            isStaged: false,
            content: '',
          };
          hunkContent = [];
        } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
          // Collect hunk content (context lines, additions, deletions)
          hunkContent.push(line);
        }
      }

      // Save last hunk
      if (currentHunk) {
        currentHunk.content = hunkContent.join('\n');
        currentHunk.id = this.generateHunkId(
          filePath,
          currentHunk.oldStart!,
          currentHunk.newStart!
        );
        hunks.push(currentHunk as Hunk);
      }

      return hunks;
    } catch (error) {
      console.error('Error getting file hunks:', error);
      return [];
    }
  }

  async getStagedHunks(filePath: string): Promise<Hunk[]> {
    try {
      // Get staged diff for the file.
      const { stdout } = await this.executeGitCommand(['diff', '--cached', '--', filePath]);
      
      if (!stdout.trim()) {
        return [];
      }

      const hunks: Hunk[] = [];
      const lines = stdout.split('\n');
      let currentHunk: Partial<Hunk> | null = null;
      let hunkContent: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Match hunk header: @@ -oldStart,oldLines +newStart,newLines @@
        const hunkHeaderMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        
        if (hunkHeaderMatch) {
          // Save previous hunk if exists
          if (currentHunk) {
            currentHunk.content = hunkContent.join('\n');
            currentHunk.id = this.generateHunkId(
              filePath,
              currentHunk.oldStart!,
              currentHunk.newStart!
            );
            hunks.push(currentHunk as Hunk);
          }

          // Start new hunk
          const oldStart = parseInt(hunkHeaderMatch[1], 10);
          const oldLines = hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1;
          const newStart = parseInt(hunkHeaderMatch[3], 10);
          const newLines = hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1;

          currentHunk = {
            filePath: filePath,
            oldStart: oldStart,
            oldLines: oldLines,
            newStart: newStart,
            newLines: newLines,
            isStaged: true,
            content: '',
          };
          hunkContent = [];
        } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
          // Collect hunk content
          hunkContent.push(line);
        }
      }

      // Save last hunk
      if (currentHunk) {
        currentHunk.content = hunkContent.join('\n');
        currentHunk.id = this.generateHunkId(
          filePath,
          currentHunk.oldStart!,
          currentHunk.newStart!
        );
        hunks.push(currentHunk as Hunk);
      }

      return hunks;
    } catch (error) {
      console.error('Error getting staged hunks:', error);
      return [];
    }
  }

  async stageHunk(hunk: Hunk): Promise<boolean> {
    try {
      // Create a temporary patch file with only this hunk
      const tempPatchFile = path.join(os.tmpdir(), `git-hunk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.patch`);
      
      // Build the patch content
      const patchContent = `--- a/${hunk.filePath}\n+++ b/${hunk.filePath}\n@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.content}`;
      
      fs.writeFileSync(tempPatchFile, patchContent);

      try {
        // Apply the patch to the staging area
        await this.executeGitCommand(['apply', '--cached', tempPatchFile]);
        return true;
      } finally {
        // Clean up temp file
        try {
          if (fs.existsSync(tempPatchFile)) {
            fs.unlinkSync(tempPatchFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      console.error('Error staging hunk:', error);
      return false;
    }
  }

  async unstageHunk(hunk: Hunk): Promise<boolean> {
    try {
      // Create a reverse patch to unstage
      const tempPatchFile = path.join(os.tmpdir(), `git-hunk-unstage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.patch`);
      
      // Build reverse patch (swap old and new)
      const reverseContent = hunk.content
        .split('\n')
        .map(line => {
          if (line.startsWith('+')) {
            return '-' + line.substring(1);
          } else if (line.startsWith('-')) {
            return '+' + line.substring(1);
          }
          return line;
        })
        .join('\n');
      
      const patchContent = `--- a/${hunk.filePath}\n+++ b/${hunk.filePath}\n@@ -${hunk.newStart},${hunk.newLines} +${hunk.oldStart},${hunk.oldLines} @@\n${reverseContent}`;
      
      fs.writeFileSync(tempPatchFile, patchContent);

      try {
        // Apply reverse patch to unstage
        await this.executeGitCommand(['apply', '--cached', '--reverse', tempPatchFile]);
        return true;
      } finally {
        // Clean up temp file
        try {
          if (fs.existsSync(tempPatchFile)) {
            fs.unlinkSync(tempPatchFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      console.error('Error unstaging hunk:', error);
      return false;
    }
  }

  async getFileDiff(filePath: string, fileStatus: FileStatus): Promise<string> {
    try {
      // For new/untracked files, show the full file content as additions
      if (fileStatus === FileStatus.ADDED || fileStatus === FileStatus.UNTRACKED) {
        try {
          const fileContent = fs.readFileSync(path.join(this.workspaceRoot, filePath), 'utf8');
          const lines = fileContent.split('\n');
          let diff = `--- /dev/null\n+++ b/${filePath}\n`;
          diff += `@@ -0,0 +1,${lines.length} @@\n`;
          for (const line of lines) {
            diff += `+${line}\n`;
          }
          return diff;
        } catch (error) {
          return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,0 @@\n`;
        }
      }
      
      // For deleted files, show the file content as deletions
      if (fileStatus === FileStatus.DELETED) {
        try {
          const { stdout } = await this.executeGitCommand(['show', `HEAD:${filePath}`]);
          const lines = stdout.split('\n');
          let diff = `--- a/${filePath}\n+++ /dev/null\n`;
          diff += `@@ -1,${lines.length} +0,0 @@\n`;
          for (const line of lines) {
            diff += `-${line}\n`;
          }
          return diff;
        } catch (error) {
          return `--- a/${filePath}\n+++ /dev/null\n@@ -1,0 +0,0 @@\n`;
        }
      }
      
      // For modified files, get the unified diff
      const { stdout: unstagedDiff } = await this.executeGitCommand(['diff', '--', filePath]);
      const { stdout: stagedDiff } = await this.executeGitCommand(['diff', '--cached', '--', filePath]);
      
      // Combine staged and unstaged diffs
      if (stagedDiff.trim() && unstagedDiff.trim()) {
        // Both staged and unstaged changes - combine them
        return stagedDiff + '\n' + unstagedDiff;
      } else if (stagedDiff.trim()) {
        return stagedDiff;
      } else {
        return unstagedDiff;
      }
    } catch (error) {
      console.error('Error getting file diff:', error);
      return '';
    }
  }
}
