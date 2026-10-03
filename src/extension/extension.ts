// Entry point of the Islet extension host.
import * as vscode from 'vscode';
import { createGitHubApi } from '../api/github';
import type { GitHubApi } from '../shared/api';
import { Auth } from './auth';
import { Controller, SIDEBAR_VIEW_ID } from './controller';
import { GitHubContentProvider, SCHEME } from './diff';
import { initLog, log } from './log';
import { RepoResolver } from './repo';
import { GradleTests } from './tests/controller';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(initLog());
  log.info('Activating Islet');

  // Created lazily so a failing API module cannot break activation.
  let api: GitHubApi | undefined;
  const getApi = (): GitHubApi => (api ??= createGitHubApi(auth.getToken));

  // Testing only: in extension development mode a token can come from ISLET_DEV_TOKEN.
  const devToken = context.extensionMode === vscode.ExtensionMode.Development ? process.env.ISLET_DEV_TOKEN : undefined;
  const auth = new Auth(getApi, devToken);
  const repos = new RepoResolver();
  const content = new GitHubContentProvider(auth.getToken);
  const controller = new Controller(context.extensionUri, auth, repos, getApi, content);

  context.subscriptions.push(
    auth,
    repos,
    content,
    controller,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, content),
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, controller, { webviewOptions: { retainContextWhenHidden: false } }),
    vscode.commands.registerCommand('islet.refresh', () => {
      controller.broadcast({ type: 'refresh' });
    }),
    vscode.commands.registerCommand('islet.signIn', () => controller.signIn().catch((err) => log.error('Sign-in failed', err))),
    vscode.commands.registerCommand('islet.openItem', () => controller.openItemByNumber().catch((err) => log.error('Open item failed', err))),
  );

  // Gradle test results in the Testing panel. Separate from the GitHub panel, so a failure here
  // cannot affect it.
  try {
    const gradleTests = new GradleTests(context.globalStorageUri.fsPath);
    context.subscriptions.push(
      gradleTests,
      vscode.commands.registerCommand('islet.showTestConsole', () => gradleTests.showConsole()),
    );
  } catch (err) {
    log.error('Gradle tests could not start', err);
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
