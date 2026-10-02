// Shared HTML shell for the sidebar view and the detail panels.
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export type WebviewName = 'sidebar' | 'detail';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

export function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, name: WebviewName, title: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', `${name}.css`));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', `${name}.js`));
  const src = webview.cspSource;
  const csp = [
    "default-src 'none'",
    `img-src ${src} https: data:`,
    `style-src ${src} 'unsafe-inline'`,
    `font-src ${src}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
