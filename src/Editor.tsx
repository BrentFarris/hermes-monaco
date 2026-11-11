import { useEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import { useTheme } from '@hermes/plugin-sdk';
import type { Controller, Tab } from './controller';
import { applyTheme, monaco } from './monaco';
import { Button, Modal } from './components';

export function Editor({ controller, tab }: { controller: Controller; tab: Tab | null }) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null);
  const active = useRef(tab);
  const restoringModel = useRef(false);
  const [cursor, setCursor] = useState('Ln 1, Col 1');
  const [compare, setCompare] = useState(false);
  const theme = useTheme();
  active.current = tab;
  useEffect(() => {
    const container = element.current!;
    applyTheme(container);
    const editor = monaco.editor.create(container, { automaticLayout: true, glyphMargin: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, fixedOverflowWidgets: true,
      padding: { top: 14 }, renderWhitespace: 'selection', overviewRulerLanes: 0,
      fontFamily: 'Cascadia Code, SFMono-Regular, Consolas, Liberation Mono, monospace',
      theme: 'hermes-monaco', ariaLabel: 'Code editor',
    });
    instance.current = editor;
    const glyph = editor.onMouseDown(event => {
      const current = active.current;
      if (current && event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
        controller.toggleBookmark(current, event.target.position.lineNumber);
      }
    });
    const cursorEvent = editor.onDidChangeCursorPosition(event => {
      setCursor(`Ln ${event.position.lineNumber}, Col ${event.position.column}`);
      if (active.current && !restoringModel.current) active.current.viewState = editor.saveViewState();
    });
    const scrollEvent = editor.onDidScrollChange(() => { if (active.current && !restoringModel.current) active.current.viewState = editor.saveViewState(); });
    editor.addAction({ id: 'hermes-monaco.save', label: 'Save file', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => controller.perform(() => controller.save()).then(() => {}) });
    editor.addAction({ id: 'hermes-monaco.bookmark', label: 'Bookmarks: Toggle line', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F2], contextMenuGroupId: 'navigation', run: () => {
      const position = editor.getPosition(); if (active.current && position) controller.toggleBookmark(active.current, position.lineNumber);
    } });
    return () => { if (active.current) active.current.viewState = editor.saveViewState(); glyph.dispose(); cursorEvent.dispose(); scrollEvent.dispose(); editor.dispose(); instance.current = null; };
  }, [controller]);
  useEffect(() => { if (element.current) applyTheme(element.current); }, [theme]);
  useEffect(() => {
    const editor = instance.current!;
    const viewState = tab?.viewState;
    restoringModel.current = true;
    try {
      editor.setModel(tab?.model || null);
      if (viewState) editor.restoreViewState(viewState);
    } finally { restoringModel.current = false; }
    if (tab) editor.focus();
    setCompare(false);
    return () => {
      // On unmount the editor lifetime effect has already saved the state
      // and disposed the instance. Do not replace that state with null.
      if (tab && !tab.model.isDisposed() && instance.current === editor) tab.viewState = editor.saveViewState();
    };
  }, [tab]);
  useEffect(() => {
    const p = controller.prefs;
    instance.current?.updateOptions({ fontSize: p.fontSize, rulers: p.guides ? p.rulers : [], wordWrap: p.wordWrap ? 'on' : 'off', tabSize: p.tabSize, insertSpaces: p.insertSpaces });
  }, [controller.prefs]);
  useEffect(() => {
    const target = controller.navigation;
    if (!target || target.path !== tab?.path || !instance.current) return;
    instance.current.setSelection(new monaco.Range(target.line, target.column, target.line, target.endColumn || target.column));
    instance.current.revealLineInCenter(target.line); instance.current.focus();
  }, [controller.navigation, tab]);

  return <section className="hm-editor-column">
    {tab && <div className="hm-breadcrumbs" title={tab.path}>{tab.path.split('/').join('  /  ')}</div>}
    {tab?.conflict && <div className="hm-conflict" role="status"><span>Changed on disk. Your edits are preserved.</span><Button onClick={() => setCompare(true)}>Compare versions</Button></div>}
    {tab?.deleted && <div className="hm-conflict" role="status"><span>This file was deleted on disk.</span><Button onClick={() => setCompare(true)}>Recover draft</Button></div>}
    <div className="hm-editor-stage">
      <div className="hm-editor" ref={element} style={{ visibility: tab ? 'visible' : 'hidden' }} />
      {!tab && <div className="hm-editor-empty"><span className="hm-empty-mark">{'{ }'}</span><h2>Your project, in focus.</h2><p>Open a file from the sidebar to start editing.</p><div><kbd>Ctrl Shift P</kbd> Open file <kbd>Ctrl Shift F</kbd> Search</div><p className="hm-subtle">Click the editor gutter to bookmark a line.</p></div>}
    </div>
    <div className="hm-status"><span>{tab ? cursor : 'Ready'}</span><span>{tab ? `${tab.eol.toUpperCase()} · UTF-8${tab.bom ? ' BOM' : ''} · ${tab.model.getLanguageId()}` : ''}</span><span>Guides {controller.prefs.guides ? controller.prefs.rulers.join(', ') : 'off'}</span></div>
    {compare && tab && <ConflictDialog controller={controller} tab={tab} onClose={() => setCompare(false)} />}
  </section>;
}

function ConflictDialog({ controller, tab, onClose }: { controller: Controller; tab: Tab; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const diff = monaco.editor.createDiffEditor(ref.current!, { automaticLayout: true, readOnly: true, originalEditable: false,
      minimap: { enabled: false }, renderSideBySide: true, theme: 'hermes-monaco' });
    const original = monaco.editor.createModel(tab.conflict?.text || '', tab.model.getLanguageId());
    const modified = monaco.editor.createModel(tab.model.getValue(), tab.model.getLanguageId());
    diff.setModel({ original, modified });
    return () => { diff.dispose(); original.dispose(); modified.dispose(); };
  }, [tab, tab.conflict]);
  return <Modal title={tab.deleted ? 'Recover deleted file' : 'Resolve file conflict'} onClose={onClose} className="hm-wide-dialog">
    <p><strong>Disk version</strong> on the left · <strong>Your version</strong> on the right</p>
    <div ref={ref} className="hm-diff" />
    {error && <p role="alert" className="hm-error">{error}</p>}
    <footer><Button onClick={onClose}>Keep editing</Button>
      {tab.conflict && <Button onClick={() => { controller.acceptDisk(tab); onClose(); }}>Use disk version</Button>}
      <Button className="hm-primary" disabled={busy} onClick={async () => {
        setBusy(true); try { await controller.overwrite(tab); onClose(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
      }}>{tab.deleted ? 'Recreate file' : 'Save my version'}</Button>
    </footer>
  </Modal>;
}

