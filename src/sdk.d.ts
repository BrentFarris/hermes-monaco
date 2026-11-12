// Minimal public SDK surface used by this plugin; verified against Hermes
// 2bd378ed (2026-11-05). Runtime feature checks live in plugin.tsx.
declare module '@hermes/plugin-sdk' {
  import type { ComponentType, ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
  export interface Atom<T> { get(): T; subscribe(callback: (value: T) => void): () => void }
  export interface PluginContext {
    source: string;
    register(contribution: { id: string; area: string; title?: string; order?: number; data?: unknown; render?: () => ReactNode }): () => void;
    onDispose(callback: () => void): void;
    onEvent?(type: string, listener: (event: unknown) => void): () => void;
    addEventListener(target: EventTarget, event: string, callback: EventListener): () => void;
    storage: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void; remove(key: string): void };
    os?: { openExternal(url: string): Promise<boolean> };
    rest<T>(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T>;
  }
  export interface HermesPlugin { id: string; name: string; description?: string; defaultEnabled?: boolean; register(ctx: PluginContext): void }
  export const host: {
    state: { cwd: Atom<string>; profile: Atom<string>; connectionId?: Atom<string | null>; gateway: Atom<string> };
    navigate(path: string): void;
    request?<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    notify(options: { kind: 'error' | 'info' | 'success' | 'warning'; message: string }): unknown;
    openWorkspace?: (id: string, options: { dock?: { pane: string; pos: 'right' | 'center' }; minWidth?: string; title: string; render: () => ReactNode; onClose?: () => void }) => () => void;
  };
  export function gatewayActivationEpoch(): number;
  export function useTheme(): unknown;
  export const Button: ComponentType<ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }>;
  export const Input: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  export const ROUTES_AREA: string;
  export const SIDEBAR_NAV_AREA: string;
  export const PALETTE_AREA: string;
}

declare module '*.css' { const css: string; export default css }
declare const __EDITOR_WORKER__: string;
declare const __JSON_WORKER__: string;
declare const __MONACO_STYLES__: string;

declare module 'monaco-editor/languages/features/json/jsonMode' {
  import type { IDisposable } from 'monaco-editor';
  import type { LanguageServiceDefaults } from 'monaco-editor/languages/features/json/register';
  export function setupMode(defaults: LanguageServiceDefaults): IDisposable;
}
declare module 'monaco-editor/editor/standalone/browser/standaloneServices' {
  export const StandaloneServices: { get(service: unknown): { dispose(): void } };
}
declare module 'monaco-editor/editor/common/services/editorWorker' {
  export const IEditorWorkerService: unknown;
}

