import React, { useSyncExternalStore } from 'react';
export const ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'sidebar.nav', PALETTE_AREA = 'palette';
export function atom<T>(value: T) {
  const listeners = new Set<() => void>();
  return { get: () => value, set(next: T) { value = next; listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }, count: () => listeners.size };
}
export const route = atom('/hermes-monaco');
export const pane = atom<{ render(): React.ReactNode; onClose?(): void } | null>(null);
export const theme = atom('dark');
export const errors = atom<string[]>([]);
export const externalLinks: string[] = [];
export const host = {
  state: { cwd: atom(''), profile: atom('default'), connectionId: atom('local'), gateway: atom('fixture') },
  navigate: route.set,
  notify: ({ message }: { message: string }) => errors.set([...errors.get(), message]),
  openWorkspace(_id: string, options: { render(): React.ReactNode; onClose?(): void }) {
    pane.get()?.onClose?.(); pane.set(options);
    return () => { if (pane.get() === options) { pane.set(null); options.onClose?.(); } };
  },
};
let epoch = 0;
export function gatewayActivationEpoch() { return epoch; }
export function reconnect() { epoch++; host.state.gateway.set('fixture-' + epoch); }
export function useTheme() { return useSyncExternalStore(theme.subscribe, theme.get); }
export function Button({ variant, size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) { return <button {...props} />; }
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} />; }

export const contributions = atom<any[]>([]);
let disposers: (() => void)[] = [];
export const ctx = {
  source: 'hermes-monaco',
  os: { async openExternal(url: string) { externalLinks.push(url); return true; } },
  register(contribution: any) {
    contributions.set([...contributions.get(), contribution]);
    const dispose = () => contributions.set(contributions.get().filter(item => item !== contribution));
    disposers.push(dispose); return dispose;
  },
  onDispose(callback: () => void) { disposers.push(callback); },
  addEventListener(target: EventTarget, name: string, listener: EventListener) {
    target.addEventListener(name, listener);
    const dispose = () => target.removeEventListener(name, listener);
    disposers.push(dispose); return dispose;
  },
  storage: {
    get<T>(key: string, fallback: T): T { const value = localStorage.getItem('hermes-monaco:' + key); return value ? JSON.parse(value) : fallback; },
    set(key: string, value: unknown) { localStorage.setItem('hermes-monaco:' + key, JSON.stringify(value)); },
    remove(key: string) { localStorage.removeItem('hermes-monaco:' + key); },
  },
  async rest(path: string, options: { method?: string; body?: unknown } = {}) {
    const response = await fetch('/api/plugins/hermes-monaco' + path, { method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Hermes-Profile': host.state.profile.get(), 'X-Hermes-Connection': host.state.connectionId.get() },
      body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  },
};
export function disposePlugin() { const list = disposers; disposers = []; list.reverse().forEach(dispose => dispose()); }
