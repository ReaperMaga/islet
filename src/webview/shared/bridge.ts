// Messaging between a webview and the extension host.
// Inside VS Code it uses acquireVsCodeApi(). In a plain browser (dev preview pages in dev/)
// it falls back to window.__isletMock, provided by dist/mock.js.

import type { ToExtension, ToWebview } from '../../shared/protocol';
import { uid } from './ui';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __isletMock?: { post(msg: ToExtension, reply: (m: ToWebview) => void): void };
  }
}

type Listener = (msg: ToWebview) => void;
const listeners = new Set<Listener>();

const vscode: VsCodeApi | null = typeof window.acquireVsCodeApi === 'function' ? window.acquireVsCodeApi() : null;

function deliver(msg: ToWebview) {
  for (const l of listeners) l(msg);
}

if (vscode) {
  window.addEventListener('message', (e: MessageEvent<ToWebview>) => deliver(e.data));
}

export function post(msg: ToExtension): void {
  if (vscode) vscode.postMessage(msg);
  else if (window.__isletMock) window.__isletMock.post(msg, (m) => setTimeout(() => deliver(m), 250));
  else console.warn('[islet] no host for message', msg);
}

export function onMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type RequestMsg = Extract<ToExtension, { requestId: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Sends a request and resolves with the reply carrying the same requestId (or rejects on 'error'). */
export function request<T extends ToWebview>(msg: DistributiveOmit<RequestMsg, 'requestId'>): Promise<T> {
  const requestId = uid();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('GitHub took too long to respond. Try again.'));
    }, 30_000);
    const off = onMessage((m) => {
      if (!('requestId' in m) || m.requestId !== requestId) return;
      clearTimeout(timer);
      off();
      if (m.type === 'error') reject(new Error(m.message));
      else resolve(m as T);
    });
    post({ ...(msg as object), requestId } as ToExtension);
  });
}

export function getState<T>(): T | undefined {
  return (vscode?.getState() as T | undefined) ?? undefined;
}

export function setState<T>(state: T): void {
  vscode?.setState(state);
}

export const inVsCode = !!vscode;
