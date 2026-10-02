// Shared "Islet" output channel.
import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Islet', { log: true });
  return channel;
}

export const log = {
  info(msg: string, ...args: unknown[]) {
    channel?.info(msg, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    channel?.warn(msg, ...args);
  },
  error(msg: string, err?: unknown) {
    channel?.error(err instanceof Error ? `${msg}: ${err.stack ?? err.message}` : err !== undefined ? `${msg}: ${String(err)}` : msg);
  },
};

export function showLog(): void {
  channel?.show(true);
}
