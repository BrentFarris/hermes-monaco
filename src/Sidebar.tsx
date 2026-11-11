import { useEffect, useRef, useState } from 'react';
import type { Controller } from './controller';
import { StaleContext } from './api';
import { Button, Input, Modal, TextDialog } from './components';
import { parentPath, underPath } from './editorSettings';
import type { Bookmark, SearchOptions, SearchResults } from './types';

export type SidebarMode = 'files' | 'search' | 'bookmarks';
type FileAction = { kind: 'file' | 'folder' | 'rename' | 'move'; initial: string; path: string };

export function Sidebar({ controller, mode, quickOpen, onClose }: { controller: Controller; mode: SidebarMode; quickOpen: boolean; onClose(): void }) {
  const session = controller.session!;
  const [action, setAction] = useState<FileAction | null>(null);
  const [trash, setTrash] = useState('');
  const [trashError, setTrashError] = useState('');
  const [trashing, setTrashing] = useState(false);
  const [bookmark, setBookmark] = useState<Bookmark | null>(null);
  const select = session.selectedPath || controller.activeTab?.path || '';
  const selectedEntry = [...session.directories.values()].flat().find(entry => entry.path === select);
  const folder = selectedEntry?.directory ? select : parentPath(select);
  return <aside className="hm-sidebar">
    <header><strong>{quickOpen ? 'Open file' : mode === 'files' ? 'Files' : mode === 'search' ? 'Search' : 'Bookmarks'}</strong><Button title="Hide sidebar" aria-label="Hide sidebar" onClick={onClose}>‹</Button></header>
    {mode === 'files' && !quickOpen && <>
      <div className="hm-file-actions">
        <Button title="New file" aria-label="New file" onClick={() => setAction({ kind: 'file', path: '', initial: folder ? folder + '/' : '' })}>＋ File</Button>
        <Button title="New folder" aria-label="New folder" onClick={() => setAction({ kind: 'folder', path: '', initial: folder ? folder + '/' : '' })}>＋ Folder</Button>
        <Button title="Refresh files" aria-label="Refresh files" onClick={() => void controller.perform(() => controller.refresh())}>↻</Button>
      </div>
      <div className="hm-root" title={session.workspace.root}>{session.workspace.name}</div>
      <div className="hm-tree" role="tree" aria-label="Project files"><Tree controller={controller} path="" depth={0} /></div>
      {select && <div className="hm-selection-actions"><span title={select}>{select}</span><div>
        <Button onClick={() => setAction({ kind: 'rename', path: select, initial: select.split('/').pop()! })}>Rename</Button>
        <Button onClick={() => setAction({ kind: 'move', path: select, initial: select })}>Move</Button>
        <Button className="hm-danger" onClick={() => { setTrash(select); setTrashError(''); }}>Trash</Button>
      </div></div>}
    </>}
    {(mode === 'search' || quickOpen) && <Search controller={controller} files={quickOpen} />}
    {mode === 'bookmarks' && !quickOpen && <div className="hm-bookmarks">
      {!session.bookmarks.length && <p className="hm-empty-copy">Click beside a line number to add a bookmark. Your bookmarks stay with this workspace.</p>}
      {[...session.bookmarks].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line).map(mark => <div className="hm-bookmark" key={mark.id}>
        <button onClick={() => void controller.perform(() => controller.open(mark.path, mark.line))}><strong>{mark.label || mark.preview.trim() || `Line ${mark.line}`}</strong><small>{mark.path}:{mark.line}</small></button>
        <Button title="Name bookmark" aria-label="Name bookmark" onClick={() => setBookmark(mark)}>✎</Button>
        <Button title="Remove bookmark" aria-label="Remove bookmark" onClick={() => controller.updateBookmark(mark.id, null)}>×</Button>
      </div>)}
    </div>}
    {action && <TextDialog title={action.kind === 'file' ? 'New file' : action.kind === 'folder' ? 'New folder' : action.kind === 'rename' ? 'Rename entry' : 'Move entry'}
      label={action.kind === 'rename' ? 'New name' : 'Workspace-relative path'} initial={action.initial} onClose={() => setAction(null)}
      onSubmit={async value => {
        if (action.kind === 'file' || action.kind === 'folder') await controller.create(value, action.kind === 'folder');
        else {
          if (action.kind === 'rename' && /[/\\]/.test(value)) throw new Error('Use Move to change the parent folder.');
          const parent = parentPath(action.path);
          await controller.move(action.path, action.kind === 'rename' ? (parent ? parent + '/' : '') + value : value);
        }
      }} />}
    {trash && <Modal title="Move to OS trash" onClose={() => setTrash('')}>
      <p>Move <strong>{trash}</strong> to the backend computer’s trash?</p>
      {session.tabs.some(tab => tab.dirty && underPath(tab.path, trash)) && <p className="hm-error">Unsaved edits in this entry will be discarded.</p>}
      {trashError && <p role="alert" className="hm-error">{trashError}</p>}
      <footer><Button onClick={() => setTrash('')}>Cancel</Button><Button className="hm-danger" disabled={trashing} onClick={async () => {
        setTrashing(true);
        try { await controller.trash(trash); setTrash(''); }
        catch (error) { setTrashError(error instanceof Error ? error.message : String(error)); }
        finally { setTrashing(false); }
      }}>Move to trash</Button></footer>
    </Modal>}
    {bookmark && <TextDialog title="Name bookmark" label="Bookmark name" allowEmpty initial={bookmark.label || ''} onClose={() => setBookmark(null)} onSubmit={value => controller.updateBookmark(bookmark.id, value)} />}
  </aside>;
}

function Tree({ controller, path, depth }: { controller: Controller; path: string; depth: number }) {
  const session = controller.session!;
  const entries = session.directories.get(path);
  if (!entries) return <div className="hm-subtle hm-tree-note">Loading…</div>;
  if (!entries.length) return <div className="hm-subtle hm-tree-note">Empty folder</div>;
  return <>{entries.map(entry => <div key={entry.path}>
    <button role="treeitem" aria-expanded={entry.directory ? session.expanded.has(entry.path) : undefined} aria-selected={session.selectedPath === entry.path}
      disabled={!entry.available} title={entry.available ? entry.path : 'This link leaves the workspace'} className={'hm-tree-row ' + (session.selectedPath === entry.path ? 'is-selected' : '')}
      style={{ paddingLeft: 10 + depth * 14 }} onClick={() => {
        session.selectedPath = entry.path; controller.changed();
        void controller.perform(() => entry.directory ? controller.toggleDirectory(entry.path) : controller.open(entry.path).then(() => {}));
      }}>
      <span className="hm-tree-chevron">{entry.directory ? session.expanded.has(entry.path) ? '⌄' : '›' : ''}</span>
      <span className={entry.directory ? 'hm-folder-icon' : 'hm-file-icon'}>{entry.directory ? '▰' : '◇'}</span><span>{entry.name}</span>{entry.linked && <small>↗</small>}
    </button>
    {entry.directory && session.expanded.has(entry.path) && <div role="group"><Tree controller={controller} path={entry.path} depth={depth + 1} /></div>}
  </div>)}</>;
}

function Search({ controller, files }: { controller: Controller; files: boolean }) {
  const [text, setText] = useState('');
  const [matchCase, setCase] = useState(false);
  const [word, setWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [ignored, setIgnored] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [result, setResult] = useState<SearchResults>({ items: [], truncated: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  const workspace = controller.session?.key;
  useEffect(() => {
    const id = ++generation.current;
    setResult({ items: [], truncated: false }); setError('');
    if (!text && !files) { setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(() => {
      const options: SearchOptions = { query: text, kind: files ? 'files' : 'text', case: matchCase, word, regex, ignored,
        include: include.split(',').map(s => s.trim()).filter(Boolean), exclude: exclude.split(',').map(s => s.trim()).filter(Boolean) };
      // Keep at most one search in flight. Superseded queued queries never hit
      // the backend; replies from an old query or workspace never paint.
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (id !== generation.current) return;
        try { const next = await controller.search(options); if (id === generation.current) setResult(next); }
        catch (e) { if (id === generation.current && !(e instanceof StaleContext)) setError(e instanceof Error ? e.message : String(e)); }
        finally { if (id === generation.current) setBusy(false); }
      });
    }, 250);
    return () => { clearTimeout(timer); ++generation.current; };
  }, [controller, text, files, matchCase, word, regex, ignored, include, exclude, workspace]);
  return <div className="hm-search">
    <div className="hm-search-controls"><Input autoFocus aria-label={files ? 'Find file' : 'Search project'} placeholder={files ? 'Find file by name…' : 'Search project…'} value={text} onChange={e => setText(e.target.value)} />
      {!files && <div className="hm-search-flags"><Button aria-pressed={matchCase} title="Match case" onClick={() => setCase(!matchCase)}>Aa</Button><Button aria-pressed={word} title="Whole word" onClick={() => setWord(!word)}>ab</Button><Button aria-pressed={regex} title="Regular expression" onClick={() => setRegex(!regex)}>.*</Button></div>}
      <details><summary>Files to search</summary><label>Include<Input placeholder="src/**, *.py" value={include} onChange={e => setInclude(e.target.value)} /></label><label>Exclude<Input placeholder="**/generated/**" value={exclude} onChange={e => setExclude(e.target.value)} /></label><label className="hm-check"><input type="checkbox" checked={ignored} onChange={e => setIgnored(e.target.checked)} /> Include ignored files</label></details>
    </div>
    <div className="hm-search-summary" role="status">{busy ? 'Searching…' : `${result.items.length} results${result.truncated ? ' · limit reached, narrow the search' : ''}`}</div>
    {error && <p className="hm-error" role="alert">{error}</p>}
    <div className="hm-search-results">{result.items.map((item, index) => <button key={item.path + ':' + index} className="hm-search-result"
      onClick={() => void controller.perform(() => controller.open(item.path, item.line, item.column, item.endColumn))}>
      <strong>{item.path}{item.line ? `:${item.line}` : ''}</strong>{item.preview !== undefined && <code>{item.preview}</code>}
    </button>)}</div>
  </div>;
}
