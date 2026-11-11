import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Controller, Tab } from './controller';
import { Button, Input, Modal } from './components';
import { Editor } from './Editor';
import { Sidebar, type SidebarMode } from './Sidebar';
import { ScriptsDialog } from './ScriptsDialog';
import { RunOutput } from './RunOutput';
import { isRunning } from './types';
import { parseRulers } from './editorSettings';

export function Workbench({ controller, split, onSplit, onExpand }: { controller: Controller; split: boolean; onSplit(): void; onExpand(): void }) {
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [sidebar, setSidebar] = useState<SidebarMode>('files');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [scripts, setScripts] = useState(false);
  const [closing, setClosing] = useState<Tab | null>(null);
  const [closeError, setCloseError] = useState('');
  const [narrow, setNarrow] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const session = controller.session;
  useEffect(() => controller.attach(), [controller]);
  useEffect(() => {
    // Give an empty Code view keyboard focus without taking it from Monaco.
    if (!element.current?.contains(document.activeElement)) element.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    let last = false;
    const observer = new ResizeObserver(entries => {
      const next = entries[0].contentRect.width < 840;
      setNarrow(next);
      if (next !== last) {
        setSidebarOpen(!next); last = next;
        if (next) { controller.outputOpen = false; controller.changed(); }
      }
    });
    observer.observe(element.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setScripts(false); setClosing(null); }, [session?.key]);
  const show = (mode: SidebarMode, files = false) => { setSidebar(mode); setQuickOpen(files); setSidebarOpen(true); };
  const running = controller.runs.find(run => run.workspaceId === session?.workspace.id && run.scriptId === session.selectedScript && isRunning(run));
  const runCount = controller.runs.filter(isRunning).length;
  const selectedScript = session?.config.config.scripts.find(script => script.id === session.selectedScript);
  const runDisabled = !selectedScript || !!session?.configError || !!running || controller.launching || controller.loading;
  const close = (tab: Tab) => {
    if (tab.dirty) { setClosing(tab); setCloseError(''); }
    else void controller.perform(() => controller.close(tab));
  };
  return <div ref={element} tabIndex={-1} className={`hm-workbench${narrow ? ' hm-narrow' : ''}`} onKeyDownCapture={event => {
    if (event.target instanceof Element && event.target.closest('dialog')) return;
    if (event.key === 'F5' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat && !runDisabled) void controller.perform(() => controller.launch());
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'p') { event.preventDefault(); event.stopPropagation(); show('files', true); }
    if (key === 'f' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); show('search'); }
    if (key === 's') { event.preventDefault(); event.stopPropagation(); void controller.perform(() => event.shiftKey ? controller.saveAll() : controller.save()); }
  }}>
    <header className="hm-toolbar">
      <div className="hm-workspace-label"><span className="hm-code-icon">{'</>'}</span><div><strong>Code</strong><span title={session?.workspace.root || controller.currentRoute.cwd}>{session?.workspace.name || 'Workspace'}</span></div></div>
      <span className="hm-toolbar-divider" />
      <div className="hm-launch-controls"><select aria-label="Script" title={selectedScript?.command || 'Select a project script'} value={session?.selectedScript || ''}
        disabled={!session || !!session.configError} onChange={event => controller.selectScript(event.target.value)}>
        {!session?.config.config.scripts.length && <option value="">Add a script…</option>}
        {session?.config.config.scripts.map(script => <option value={script.id} key={script.id}>{script.name}</option>)}
      </select><Button className="hm-play" title="Save files and run selected script (F5)" aria-label="Run selected script" aria-keyshortcuts="F5" disabled={runDisabled}
        onClick={() => void controller.perform(() => controller.launch())}>{controller.launching ? '…' : '▶'}</Button>
      {running && <><Button title="Stop selected script" aria-label="Stop selected script" className="hm-danger" onClick={() => void controller.perform(() => controller.stop(running.id))}>■</Button><Button title="Restart selected script" aria-label="Restart selected script" disabled={controller.launching} onClick={() => void controller.perform(() => controller.launch(true))}>↻</Button></>}
      <Button title="Edit scripts" aria-label="Edit scripts" disabled={!session} onClick={() => setScripts(true)}>⋯</Button></div>
      <span className="hm-spacer" />
      <Button title="Editor settings" aria-label="Editor settings" onClick={() => setSettings(true)}>⚙</Button>
      <Button className="hm-layout-button" onClick={split ? onExpand : onSplit}>{split ? 'Expand' : 'Split with chat'}</Button>
    </header>
    {controller.error && <div className="hm-banner hm-error" role="alert"><span>{controller.error}</span><Button onClick={() => void controller.perform(() => controller.activate())}>Reconnect</Button><Button aria-label="Dismiss error" onClick={() => { controller.error = ''; controller.changed(); }}>×</Button></div>}
    {controller.recoveryError && <div className="hm-banner hm-error" role="alert">{controller.recoveryError}</div>}
    {session?.configError && <div className="hm-banner hm-error" role="alert"><span>{session.configError}</span><Button onClick={() => void controller.perform(() => controller.open('.hermes/scripts.json'))}>Open configuration</Button></div>}
    {!session || controller.loading ? <div className="hm-main-empty"><span className="hm-empty-mark">{'{ }'}</span><h2>{controller.loading ? 'Opening workspace…' : 'Open a project to begin'}</h2><p>{controller.loading ? 'Restoring files and editor state.' : 'Code follows the active chat’s workspace folder.'}</p>{!controller.loading && controller.currentRoute.cwd && <Button onClick={() => void controller.perform(() => controller.activate())}>Retry connection</Button>}</div> : <>
      <div className="hm-work-area">
        <nav className="hm-activity" aria-label="Editor views">{(['files', 'search', 'bookmarks'] as const).map((mode, index) => <Button key={mode} title={mode[0].toUpperCase() + mode.slice(1)} aria-label={mode[0].toUpperCase() + mode.slice(1)} aria-pressed={sidebarOpen && sidebar === mode}
          onClick={() => { if (sidebarOpen && sidebar === mode && !quickOpen) setSidebarOpen(false); else show(mode); }}>{['▱', '⌕', '⚑'][index]}</Button>)}
          <span className="hm-spacer" /><Button title="Run output" aria-label="Run output" aria-pressed={controller.outputOpen} onClick={() => { controller.outputOpen = !controller.outputOpen; controller.changed(); }}>▤{runCount > 0 && <small>{runCount}</small>}</Button>
        </nav>
        {sidebarOpen && <Sidebar key={session.key + sidebar + quickOpen} controller={controller} mode={sidebar} quickOpen={quickOpen} onClose={() => setSidebarOpen(false)} />}
        <main className="hm-main">
          <div className="hm-tabs" role="tablist" aria-label="Open files">{session.tabs.map(tab => <div className={'hm-tab ' + (session.active === tab.path ? 'is-active ' : '') + (tab.keepOpen ? '' : 'is-preview')} key={tab.path}
            onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
            onAuxClick={event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); close(tab); } }}>
            <button role="tab" aria-selected={session.active === tab.path} title={tab.path + (tab.keepOpen ? '' : ' (Preview — double-click to keep open)')}
              aria-description={tab.keepOpen ? undefined : 'Preview tab. Double-click to keep open.'}
              onClick={() => controller.selectTab(tab)} onDoubleClick={() => controller.keepOpen(tab)}><span className="hm-tab-icon">◇</span>{tab.path.split('/').pop()}<span className="hm-tab-state">{tab.conflict || tab.deleted ? '!' : tab.dirty ? '●' : ''}</span></button>
            <button className="hm-tab-close" aria-label={'Close ' + tab.path} onClick={() => close(tab)}>×</button>
          </div>)}{!session.tabs.length && <span className="hm-tab-placeholder">No file open</span>}</div>
          <Editor controller={controller} tab={controller.activeTab} />
          {controller.outputOpen && <RunOutput controller={controller} />}
        </main>
      </div>
    </>}
    {settings && <Settings controller={controller} onClose={() => setSettings(false)} />}
    {scripts && session && <ScriptsDialog controller={controller} onClose={() => setScripts(false)} />}
    {closing && <Modal title="Unsaved changes" onClose={() => setClosing(null)}><p>Save changes to <strong>{closing.path}</strong> before closing?</p>{closeError && <p className="hm-error">{closeError}</p>}<footer>
      <Button onClick={() => setClosing(null)}>Cancel</Button><Button onClick={async () => { await controller.close(closing, true); setClosing(null); }}>Discard</Button>
      <Button className="hm-primary" onClick={async () => { try { await controller.save(closing); if (closing.dirty) throw new Error('The file changed while saving.'); await controller.close(closing); setClosing(null); } catch (e) { setCloseError(e instanceof Error ? e.message : String(e)); } }}>Save</Button>
    </footer></Modal>}
  </div>;
}

function Settings({ controller, onClose }: { controller: Controller; onClose(): void }) {
  const [prefs, setPrefs] = useState({ ...controller.prefs });
  const [rulers, setRulers] = useState(prefs.rulers.join(', '));
  const valid = parseRulers(rulers);
  return <Modal title="Editor settings" onClose={onClose}><div className="hm-settings">
    <label className="hm-check"><input type="checkbox" checked={prefs.guides} onChange={e => setPrefs({ ...prefs, guides: e.target.checked })} /> Show column guides</label>
    <label>Guide columns<Input value={rulers} onChange={e => setRulers(e.target.value)} placeholder="80, 90" /></label>
    {!valid && <p className="hm-error">Enter comma-separated whole numbers from 1 to 10,000.</p>}
    <div className="hm-form-row"><label>Font size<Input type="number" min={10} max={32} value={prefs.fontSize} onChange={e => setPrefs({ ...prefs, fontSize: Number(e.target.value) })} /></label><label>Tab width<select value={prefs.tabSize} onChange={e => setPrefs({ ...prefs, tabSize: Number(e.target.value) })}>{[2, 4, 8].map(n => <option key={n}>{n}</option>)}</select></label></div>
    <label className="hm-check"><input type="checkbox" checked={prefs.insertSpaces} onChange={e => setPrefs({ ...prefs, insertSpaces: e.target.checked })} /> Indent with spaces</label>
    <label className="hm-check"><input type="checkbox" checked={prefs.wordWrap} onChange={e => setPrefs({ ...prefs, wordWrap: e.target.checked })} /> Wrap long lines</label>
  </div><footer><Button onClick={onClose}>Cancel</Button><Button className="hm-primary" disabled={!valid} onClick={() => { controller.setPreferences({ ...prefs, rulers: valid! }); onClose(); }}>Save settings</Button></footer></Modal>;
}

