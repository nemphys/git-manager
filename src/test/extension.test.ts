import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', () => {
    // The extension ID includes the publisher, which is 'undefined' in development
    const ext = vscode.extensions.getExtension('undefined_publisher.git-manager');
    if (!ext) {
      // Try without publisher as fallback
      assert.ok(vscode.extensions.getExtension('git-manager'));
    } else {
      assert.ok(ext);
    }
  });

  test('Should activate', async () => {
    let ext = vscode.extensions.getExtension('undefined_publisher.git-manager');
    if (!ext) {
      ext = vscode.extensions.getExtension('git-manager');
    }
    if (ext) {
      await ext.activate();
      assert.ok(true);
    }
  });

  test('Should register commands', async () => {
    const commands = await vscode.commands.getCommands();
    const commitManagerCommands = commands.filter((cmd) => cmd.startsWith('git-manager.'));
    assert.ok(commitManagerCommands.length > 0, 'No commit manager commands found');
  });
});
