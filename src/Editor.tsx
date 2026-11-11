import { useEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import { useTheme } from '@hermes/plugin-sdk';
import type { Controller, Tab } from './controller';
import { applyTheme, monaco } from './monaco';
import { Button, Modal } from './components';
import { MarkdownPreview } from './MarkdownPreview';
import type { MarkdownViewMode } from './types';

export function Editor({ controller, tab }: { controller: Controller; tab: Tab | null }) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null);
  const active = useRef(tab);
  const restoringModel = useRef(false);
  const sourceVisible = useRef(true);
  const stage = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const [cursor, setCursor] = useState('Ln 1, Col 1');
  const [compare, setCompare] = useState(false);
  const theme = useTheme();
  const mode = tab?.markdown?.mode || 'edit';
  const ratio = tab?.markdown?.splitRatio || 0.5;
  active.current = tab;
  sourceVisible.current = mode !== 'preview';
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
      if (active.current?.model === editor.getModel() && sourceVisible.current && !restoringModel.current) active.current.viewState = editor.saveViewState();
    });
    const scrollEvent = editor.onDidScrollChange(() => { if (active.current?.model === editor.getModel() && sourceVisible.current && !restoringModel.current) active.current.viewState = editor.saveViewState(); });
    editor.addAction({ id: 'hermes-monaco.save', label: 'Save file', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => controller.perform(() => controller.save()).then(() => {}) });
    editor.addAction({ id: 'hermes-monaco.bookmark', label: 'Bookmarks: Toggle line', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F2], contextMenuGroupId: 'navigation', run: () => {
      const position = editor.getPosition(); if (active.current && position) controller.toggleBookmark(active.current, position.lineNumber);
    } });
    return () => { if (active.current?.model === editor.getModel() && sourceVisible.current) active.current.viewState = editor.saveViewState(); glyph.dispose(); cursorEvent.dispose(); scrollEvent.dispose(); editor.dispose(); instance.current = null; };
  }, [controller]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setStacked(entries[0].contentRect.width < 720));
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (element.current) applyTheme(element.current); }, [theme]);
  useEffect(() => {
    const editor = instance.current!;
    const viewState = tab?.viewState;
    restoringModel.current = true;
    try {
      editor.setModel(tab?.model || null);
      if (viewState) editor.restoreViewState(viewState);
    } finally { restoringModel.current = false; }
    if (tab && sourceVisible.current) editor.focus();
    setCompare(false);
    return () => {
      // On unmount the editor lifetime effect has already saved the state
      // and disposed the instance. Do not replace that state with null.
      if (tab && tab.markdown?.mode !== 'preview' && !tab.model.isDisposed() && instance.current === editor && editor.getModel() === tab.model) tab.viewState = editor.saveViewState();
    };
  }, [tab]);
  useEffect(() => {
    const editor = instance.current!;
    if (mode === 'preview') return;
    const state = tab?.viewState;
    restoringModel.current = true;
    try { editor.layout(); if (state) editor.restoreViewState(state); }
    finally { restoringModel.current = false; }
    if (tab) editor.focus();
  }, [tab, mode]);
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

  const changeMode = (next: MarkdownViewMode) => {
    if (!tab) return;
    if (sourceVisible.current) tab.viewState = instance.current?.saveViewState() || tab.viewState;
    controller.setMarkdownMode(tab, next);
  };

  return <section className="hm-editor-column">
    {tab && <div className="hm-editor-heading"><div className="hm-breadcrumbs" title={tab.path}>{tab.path.split('/').join('  /  ')}</div>
      {tab.markdown && <div className="hm-markdown-modes" role="group" aria-label="Markdown view">
        {(['edit', 'split', 'preview'] as const).map(value => <Button key={value} aria-pressed={mode === value} onClick={() => changeMode(value)}>{value[0].toUpperCase() + value.slice(1)}</Button>)}
      </div>}
    </div>}
    {tab?.conflict && <div className="hm-conflict" role="status"><span>Changed on disk. Your edits are preserved.</span><Button onClick={() => setCompare(true)}>Compare versions</Button></div>}
    {tab?.deleted && <div className="hm-conflict" role="status"><span>This file was deleted on disk.</span><Button onClick={() => setCompare(true)}>Recover draft</Button></div>}
    <div className="hm-editor-stage" ref={stage} data-mode={mode} data-stacked={stacked}>
      <div className="hm-source-pane" style={{ display: mode === 'preview' ? 'none' : undefined, flex: mode === 'split' ? `${ratio} 1 0%` : undefined }}>
        <div className="hm-editor" ref={element} style={{ visibility: tab ? 'visible' : 'hidden' }} />
      </div>
      {tab?.markdown && mode === 'split' && <MarkdownDivider controller={controller} tab={tab} stage={stage.current} stacked={stacked} />}
      {tab?.markdown && mode !== 'edit' && <div className="hm-preview-pane" style={{ flex: mode === 'split' ? `${1 - ratio} 1 0%` : undefined }}>
        <MarkdownPreview controller={controller} tab={tab} />
      </div>}
      {!tab && <div className="hm-editor-empty"><span className="hm-empty-mark">{'{ }'}</span><h2>Your project, in focus.</h2><p>Open a file from the sidebar to start editing.</p><div><kbd>Ctrl Shift P</kbd> Open file <kbd>Ctrl Shift F</kbd> Search</div><p className="hm-subtle">Click the editor gutter to bookmark a line.</p></div>}
    </div>
    <div className="hm-status"><span>{tab ? cursor : 'Ready'}</span><span>{tab ? `${tab.eol.toUpperCase()} · UTF-8${tab.bom ? ' BOM' : ''} · ${tab.model.getLanguageId()}` : ''}</span><span>Guides {controller.prefs.guides ? controller.prefs.rulers.join(', ') : 'off'}</span></div>
    {compare && tab && <ConflictDialog controller={controller} tab={tab} onClose={() => setCompare(false)} />}
  </section>;
}

function MarkdownDivider({ controller, tab, stage, stacked }: { controller: Controller; tab: Tab; stage: HTMLDivElement | null; stacked: boolean }) {
  const drag = useRef<number | null>(null);
  const ratio = tab.markdown!.splitRatio;
  return <div className="hm-markdown-divider" role="separator" aria-label="Resize Markdown panes" tabIndex={0}
    aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)}
    onKeyDown={event => {
      const direction = event.key === (stacked ? 'ArrowUp' : 'ArrowLeft') ? -1 : event.key === (stacked ? 'ArrowDown' : 'ArrowRight') ? 1 : 0;
      if (!direction && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      controller.setMarkdownRatio(tab, event.key === 'Home' ? 0.2 : event.key === 'End' ? 0.8 : ratio + direction * 0.05);
    }}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = event.pointerId; }}
    onPointerMove={event => {
      if (drag.current !== event.pointerId || !stage || controller.activeTab !== tab) return;
      const bounds = stage.getBoundingClientRect();
      controller.setMarkdownRatio(tab, stacked ? (event.clientY - bounds.top) / bounds.height : (event.clientX - bounds.left) / bounds.width);
    }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }} />;
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

