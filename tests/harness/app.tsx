import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as sdk from './sdk';

const workers = new Set<Worker>();
const intervals = new Set<number>();
const nativeSetInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
window.setInterval = ((...args: Parameters<typeof window.setInterval>) => { const id = nativeSetInterval(...args); intervals.add(id); return id; }) as typeof window.setInterval;
window.clearInterval = ((id?: number) => { if (id !== undefined) intervals.delete(id); nativeClearInterval(id); }) as typeof window.clearInterval;
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.add(this); }
  terminate() { workers.delete(this); super.terminate(); }
};
let plugin: { register(context: typeof sdk.ctx): void };
let moduleUrl = '';
async function load() {
  const source = await (await fetch('/plugin.js')).text();
  if (new TextEncoder().encode(source).length > 16 * 1024 * 1024) throw new Error('Hermes source limit exceeded');
  const modules: Record<string, string> = { '@hermes/plugin-sdk': 'sdk', react: 'react', 'react/jsx-runtime': 'jsx' };
  const rewritten = source.replace(/from\s*(['"])(@hermes\/plugin-sdk|react(?:\/jsx-runtime)?)\1/g,
    (_, quote, name) => `from${quote}${location.origin}/assets/${modules[name]}.js${quote}`);
  moduleUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
  plugin = (await import(/* @vite-ignore */ moduleUrl)).default;
  plugin.register(sdk.ctx);
}
const fixture = await (await fetch('/test/setup', { method: 'POST' })).json();
sdk.host.state.cwd.set(fixture.a);
const root = createRoot(document.getElementById('root')!);
function App() {
  const route = useSyncExternalStore(sdk.route.subscribe, sdk.route.get);
  const pane = useSyncExternalStore(sdk.pane.subscribe, sdk.pane.get);
  const contributions = useSyncExternalStore(sdk.contributions.subscribe, sdk.contributions.get);
  const errors = useSyncExternalStore(sdk.errors.subscribe, sdk.errors.get);
  const page = contributions.find(item => item.area === 'routes' && item.data.path === route);
  return <><header className="fixture-bar"><strong>Hermes · integration fixture</strong><button onClick={() => sdk.host.navigate('/hermes-monaco')}>Code</button>
    <button onClick={() => { sdk.theme.set(sdk.theme.get() === 'dark' ? 'light' : 'dark'); document.documentElement.classList.toggle('light'); }}>Theme</button>
    <button onClick={() => sdk.host.state.cwd.set(fixture.a)}>Project A</button><button onClick={() => sdk.host.state.cwd.set(fixture.b)}>Project B</button>
  </header>{errors.length > 0 && <div id="errors">{errors.join('\n')}</div>}
    <div className="fixture-body">{page ? <div className="fixture-pane">{page.render()}</div> : <div className="fixture-chat"><h2>Chat</h2><p>Code runs alongside your active workspace.</p></div>}
      {pane && <aside className="fixture-pane">{pane.render()}</aside>}</div></>;
}
root.render(<App />);
await load();
(window as any).hmTest = { fixture, sdk,
  workers: () => workers.size,
  intervals: () => intervals.size,
  async unload() { sdk.disposePlugin(); URL.revokeObjectURL(moduleUrl); },
  async reload() { sdk.disposePlugin(); await new Promise(resolve => setTimeout(resolve, 0)); URL.revokeObjectURL(moduleUrl); await load(); },
};
