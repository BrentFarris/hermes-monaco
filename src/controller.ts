import type { PluginContext } from '@hermes/plugin-sdk';
import type { editor } from 'monaco-editor';
import { ApiError, Client, query, routeKey, sessionKey, StaleContext } from './api';
import { IndexedDraftStore, type DraftStore } from './drafts';
import { parentPath, preferences, remapPath, underPath } from './editorSettings';
import { languageForPath, monaco } from './monaco';
import type { Bookmark, ConfigSnapshot, Draft, Entry, FileSnapshot, Output, Preferences, Route, Run, ScriptsConfig, SearchOptions, SearchResults, SessionMetadata, Workspace } from './types';
import { isRunning } from './types';

export type Tab = {
  path: string; model: editor.ITextModel; baseline: string; revision: string | null;
  bom: boolean; eol: 'lf' | 'crlf'; dirty: boolean; deleted: boolean; keepOpen: boolean;
  conflict: FileSnapshot | null; viewState: editor.ICodeEditorViewState | null;
  applying: boolean; decorations: Map<string, string>; dispose: () => void;
};

export type Session = {
  key: string; workspace: Workspace; client: Client; tabs: Tab[]; active: string | null;
  bookmarks: Bookmark[]; expanded: Set<string>; directories: Map<string, Entry[]>;
  selectedPath: string; config: ConfigSnapshot; configError: string; selectedScript: string;
};

type OpenIntent = { sequence: number; keepOpen: boolean; replacePreview: boolean; line?: number; column: number; endColumn?: number };

const emptyConfig = (): ConfigSnapshot => ({ config: { version: 1, scripts: [] }, revision: null });
const metadataDefault = (): SessionMetadata => ({ version: 1, tabs: [], active: null, bookmarks: [], expanded: [''], selectedScript: '' });
const modelText = (text: string, eol: 'lf' | 'crlf') => text.replace(/\r\n|\r|\n/g, eol === 'crlf' ? '\r\n' : '\n');

export class Controller {
  session: Session | null = null;
  loading = false;
  error = '';
  recoveryError = '';
  prefs: Preferences;
  runs: Run[] = [];
  selectedRun = '';
  output: Output | null = null;
  outputOpen = false;
  launching = false;
  private sessions = new Map<string, Session>();
  private listeners = new Set<() => void>();
  private version = 0;
  private generation = 0;
  private visible = 0;
  private disposed = false;
  private refreshGeneration = -1;
  private runsGeneration = -1;
  private launchSequence = 0;
  private refreshIndex = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private openSequence = 0;
  private pendingOpens = new Map<string, { intent: OpenIntent; promise: Promise<Tab> }>();
  private pendingSaves = new Map<Tab, Promise<void>>();
  private cursor = 0;
  private lastRefresh = 0;
  private route: Route;

  constructor(public ctx: PluginContext, private readRoute: () => Route, private drafts: DraftStore = new IndexedDraftStore()) {
    this.route = readRoute();
    this.prefs = preferences(ctx.storage.get('preferences.v1', null));
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  changed = () => { this.version++; this.listeners.forEach(listener => listener()); };
  get currentRoute() { return this.route; }
  get activeTab() { return this.session?.tabs.find(tab => tab.path === this.session!.active) || null; }
  get hasDrafts() { return [...this.sessions.values()].some(session => session.tabs.some(tab => tab.dirty)); }

  async perform<T>(action: () => Promise<T>): Promise<T | undefined> {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof StaleContext)) {
        this.error = error instanceof Error ? error.message : String(error);
        this.changed();
      }
    }
  }

  attach() {
    if (++this.visible === 1) {
      void this.perform(() => this.activate());
      this.timer = setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        if (Date.now() - this.lastRefresh > 1800) void this.perform(() => this.refresh());
        void this.perform(() => this.refreshRuns());
      }, 500);
    }
    return () => {
      if (--this.visible === 0) {
        clearInterval(this.timer);
        this.persistAll();
      }
    };
  }

  routeChanged() {
    const next = this.readRoute();
    if (routeKey(next) === routeKey(this.route)) return;
    this.persistAll();
    this.disposeIncompleteRestore();
    this.route = next;
    ++this.generation;
    ++this.launchSequence;
    this.launching = false;
    this.session = null;
    this.runs = [];
    this.selectedRun = '';
    this.output = null;
    this.cursor = 0;
    this.loading = !!next.cwd && this.visible > 0;
    this.error = '';
    this.changed();
    if (this.visible) void this.perform(() => this.activate());
  }

  assertSession(session: Session) {
    session.client.assertCurrent();
    if (this.session !== session || this.disposed) throw new StaleContext();
  }

  async activate() {
    this.disposeIncompleteRestore();
    const generation = ++this.generation;
    this.route = this.readRoute();
    if (!this.route.cwd || this.disposed) { this.session = null; this.loading = false; this.changed(); return; }
    this.loading = true;
    this.error = '';
    this.changed();
    const client = new Client(this.ctx, { ...this.route }, () => {
      if (generation !== this.generation || this.disposed) throw new StaleContext();
      return this.readRoute();
    });
    let restoring: Session | null = null;
    try {
      const workspace = await client.call<Workspace>('/workspace', { cwd: this.route.cwd });
      if (generation !== this.generation || this.disposed) throw new StaleContext();
      const key = sessionKey(this.route, workspace.root);
      let session = this.sessions.get(key);
      if (session) { session.workspace = workspace; session.client = client; }
      else {
        const metadata = this.ctx.storage.get<SessionMetadata>('session.v1:' + key, metadataDefault());
        const recovered = await this.drafts.load(key);
        client.assertCurrent();
        if (generation !== this.generation || this.disposed) throw new StaleContext();
        session = { key, workspace, client, tabs: [], active: null, bookmarks: metadata.bookmarks || [],
          expanded: new Set(['', ...(metadata.expanded || []).slice(0, 49)]), directories: new Map(), selectedPath: '',
          config: emptyConfig(), configError: '', selectedScript: metadata.selectedScript || '' };
        restoring = session;
        this.session = session;
        const files = [...new Set([...(metadata.tabs || []), ...recovered.map(draft => draft.path)])].slice(0, 40);
        for (const path of files) {
          this.assertSession(session);
          const draft = recovered.find(item => item.path === path);
          try {
            const disk = await client.call<FileSnapshot>('/file' + query({ workspaceId: workspace.id, path }));
            this.assertSession(session);
            const tab = this.addTab(session, disk, draft);
            tab.viewState = metadata.views?.[path] || null;
            tab.keepOpen = metadata.preview !== path || tab.dirty || !!tab.conflict;
          } catch (error) {
            if (error instanceof StaleContext) throw error;
            if (draft) {
              const tab = this.addTab(session, { ...draft, text: draft.baseline, size: 0 }, draft);
              tab.viewState = metadata.views?.[path] || null;
              tab.deleted = error instanceof ApiError && error.code === 'not_found';
            }
            this.error = `Could not restore ${path}: ${error instanceof Error ? error.message : error}`;
          }
        }
        session.active = session.tabs.some(tab => tab.path === metadata.active) ? metadata.active : session.tabs[0]?.path || null;
        this.sessions.set(key, session);
      }
      this.session = session;
      this.loading = false;
      await this.refresh();
      await this.refreshRuns();
      for (const [oldKey, old] of this.sessions) {
        if (this.sessions.size <= 8) break;
        if (old !== session && !old.tabs.some(tab => tab.dirty)) {
          old.tabs.forEach(tab => tab.dispose()); this.sessions.delete(oldKey);
        }
      }
      this.changed();
    } finally {
      if (restoring && !this.sessions.has(restoring.key)) restoring.tabs.forEach(tab => tab.dispose());
      if (generation === this.generation) { this.loading = false; this.changed(); }
    }
  }

  private disposeIncompleteRestore() {
    if (this.session && !this.sessions.has(this.session.key)) {
      this.session.tabs.forEach(tab => { if (!tab.model.isDisposed()) tab.dispose(); });
      this.session = null;
    }
  }

  private addTab(session: Session, snapshot: FileSnapshot, draft?: Draft): Tab {
    const model = monaco.editor.createModel(draft?.text ?? snapshot.text, languageForPath(snapshot.path),
      monaco.Uri.parse(`hermes-monaco://${encodeURIComponent(session.key)}/${snapshot.path.split('/').map(encodeURIComponent).join('/')}`));
    model.setEOL((draft?.eol ?? snapshot.eol) === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    model.updateOptions({ tabSize: this.prefs.tabSize, insertSpaces: this.prefs.insertSpaces });
    const baseline = modelText(draft?.baseline ?? snapshot.text, draft?.eol ?? snapshot.eol);
    const tab: Tab = { path: snapshot.path, model, baseline, revision: draft ? draft.revision : snapshot.revision,
      bom: draft?.bom ?? snapshot.bom, eol: draft?.eol ?? snapshot.eol, dirty: model.getValue() !== baseline,
      deleted: false, keepOpen: true, conflict: draft && draft.revision !== snapshot.revision ? snapshot : null,
      viewState: null, applying: false, decorations: new Map(), dispose: () => {} };
    if (draft && model.getValue() === modelText(snapshot.text, tab.eol) && tab.bom === snapshot.bom) {
      tab.baseline = model.getValue(); tab.revision = snapshot.revision; tab.dirty = false; tab.conflict = null;
    }
    session.tabs.push(tab);
    this.decorate(session, tab);
    const subscription = model.onDidChangeContent(() => {
      if (tab.applying) return;
      tab.dirty = model.getValue() !== tab.baseline;
      tab.keepOpen = true;
      for (const bookmark of session.bookmarks.filter(mark => mark.path === tab.path)) {
        const range = model.getDecorationRange(tab.decorations.get(bookmark.id) || '');
        if (range) { bookmark.line = range.startLineNumber; bookmark.preview = model.getLineContent(bookmark.line); }
      }
      this.schedulePersist(session);
      this.changed();
    });
    tab.dispose = () => { subscription.dispose(); model.dispose(); };
    return tab;
  }

  preview(path: string, line?: number, column = 1, endColumn?: number) {
    return this.open(path, line, column, endColumn, true);
  }

  async open(path: string, line?: number, column = 1, endColumn?: number, preview = false): Promise<Tab> {
    const session = this.session;
    if (!session) throw new StaleContext();
    this.assertSession(session);
    const intent: OpenIntent = { sequence: ++this.openSequence, keepOpen: !preview, replacePreview: preview, line, column, endColumn };
    const tab = session.tabs.find(item => item.path === path);
    if (tab) {
      if (!preview) tab.keepOpen = true;
      this.finishOpen(session, tab, intent);
      return tab;
    }

    // Double-clicks can arrive before the first read completes. Share that
    // read and upgrade its intent; never create duplicate Monaco models.
    const key = this.generation + '\n' + session.key + '\n' + path;
    const pending = this.pendingOpens.get(key);
    if (pending) {
      Object.assign(pending.intent, { ...intent, keepOpen: pending.intent.keepOpen || intent.keepOpen,
        replacePreview: pending.intent.replacePreview });
      return pending.promise;
    }
    const promise = this.loadTab(session, path, intent).finally(() => { this.pendingOpens.delete(key); });
    this.pendingOpens.set(key, { intent, promise });
    return promise;
  }

  private async loadTab(session: Session, path: string, intent: OpenIntent): Promise<Tab> {
    const snapshot = await session.client.call<FileSnapshot>('/file' + query({ workspaceId: session.workspace.id, path }));
    this.assertSession(session);
    const latest = intent.sequence === this.openSequence;
    if (!latest && !intent.keepOpen) throw new StaleContext();
    // Recheck after the read: the user may have edited or kept the old preview
    // while this file loaded. Older kept opens may finish in the background.
    const previous = session.tabs.find(tab => !tab.keepOpen);
    if (previous && (previous.dirty || previous.conflict || previous.deleted)) previous.keepOpen = true;
    const replaceIndex = intent.replacePreview && latest ? session.tabs.findIndex(tab => !tab.keepOpen) : -1;
    if (session.tabs.length >= 40 && replaceIndex < 0) throw new Error('Close an editor tab before opening more than 40 files.');
    const tab = this.addTab(session, snapshot);
    tab.keepOpen = intent.keepOpen;
    if (replaceIndex >= 0) {
      const replaced = session.tabs[replaceIndex];
      session.tabs.pop(); // addTab appended the new model; reuse the preview's position.
      session.tabs[replaceIndex] = tab;
      replaced.dispose();
    }
    this.finishOpen(session, tab, intent);
    return tab;
  }

  private finishOpen(session: Session, tab: Tab, intent: OpenIntent) {
    if (intent.sequence === this.openSequence) {
      session.active = tab.path;
      session.selectedPath = tab.path;
      this.navigation = intent.line ? { path: tab.path, line: intent.line, column: intent.column, endColumn: intent.endColumn, nonce: intent.sequence } : null;
    }
    this.persistMetadata(session);
    this.changed();
  }

  selectTab(tab: Tab) {
    const session = this.session;
    if (!session?.tabs.includes(tab)) return;
    this.finishOpen(session, tab, { sequence: ++this.openSequence, keepOpen: tab.keepOpen, replacePreview: false, column: 1 });
  }

  keepOpen(tab: Tab) {
    const session = this.session;
    if (!session?.tabs.includes(tab) || tab.keepOpen) return;
    tab.keepOpen = true;
    this.persistMetadata(session);
    this.changed();
  }

  navigation: { path: string; line: number; column: number; endColumn?: number; nonce: number } | null = null;

  async save(tab = this.activeTab, session = this.session) {
    if (!tab || !session) return;
    // Serialize repeated Ctrl+S/Play saves of the same tab. A second request
    // must use the revision returned by the first, including newer typing.
    while (this.pendingSaves.has(tab)) await this.pendingSaves.get(tab);
    this.assertSession(session);
    if (!session.tabs.includes(tab)) throw new Error('The file was closed before it could be saved.');
    const operation = this.saveFile(tab, session);
    this.pendingSaves.set(tab, operation);
    try { await operation; }
    finally { if (this.pendingSaves.get(tab) === operation) this.pendingSaves.delete(tab); }
  }

  private async saveFile(tab: Tab, session: Session) {
    this.assertSession(session);
    if (!tab.dirty) return;
    const text = tab.model.getValue();
    try {
      const snapshot = await session.client.call<FileSnapshot>('/file', {
        workspaceId: session.workspace.id, path: tab.path, text, expectedRevision: tab.revision, bom: tab.bom,
      }, 'PUT');
      this.assertSession(session);
      tab.baseline = text; tab.revision = snapshot.revision; tab.conflict = null; tab.deleted = false;
      tab.dirty = tab.model.getValue() !== text;
      await this.persist(session);
      this.changed();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') tab.conflict = (error.details.current as FileSnapshot) || null;
      if (error instanceof ApiError && ['deleted', 'not_found'].includes(error.code)) tab.deleted = true;
      this.changed();
      throw error;
    }
  }

  async saveAll(session = this.session) {
    if (!session) return;
    for (const tab of [...session.tabs]) {
      this.assertSession(session);
      if (tab.conflict || tab.deleted) throw new Error(`Resolve the disk changes in ${tab.path} before continuing.`);
      await this.save(tab, session);
      // A save can finish while typing continues. Do not launch using a
      // mixture of saved and newer unsaved buffers.
      if (tab.dirty) throw new Error('A file changed while saving. Save again before running.');
    }
    this.assertSaved(session);
  }

  private assertSaved(session: Session) {
    this.assertSession(session);
    if (session.tabs.some(tab => tab.dirty || tab.conflict || tab.deleted)) {
      throw new Error('A file changed while preparing to run. Save or resolve its changes, then try again.');
    }
  }

  async overwrite(tab: Tab) {
    if (tab.conflict) tab.revision = tab.conflict.revision;
    else if (tab.deleted) tab.revision = null;
    tab.dirty = true;
    await this.save(tab);
  }

  acceptDisk(tab: Tab) {
    if (!this.session || !tab.conflict) return;
    this.applyDisk(this.session, tab, tab.conflict);
    void this.persist(this.session);
    this.changed();
  }

  private applyDisk(session: Session, tab: Tab, snapshot: FileSnapshot) {
    tab.applying = true;
    try {
      tab.model.setValue(snapshot.text);
      tab.model.setEOL(snapshot.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      tab.baseline = tab.model.getValue(); tab.revision = snapshot.revision; tab.bom = snapshot.bom;
      tab.eol = snapshot.eol; tab.dirty = false; tab.conflict = null; tab.deleted = false;
      const lines = tab.model.getLinesContent();
      for (const mark of session.bookmarks.filter(item => item.path === tab.path)) {
        const matches = lines.flatMap((text, index) => text === mark.preview ? [index + 1] : []);
        mark.line = matches.length === 1 ? matches[0] : Math.min(mark.line, lines.length);
      }
      this.decorate(session, tab);
    } finally { tab.applying = false; }
  }

  async close(tab: Tab, discard = false) {
    const session = this.session;
    if (!session) return;
    const index = session.tabs.indexOf(tab);
    if (index < 0) return;
    if (tab.dirty && !discard) throw new Error('Save or discard this file before closing it.');
    session.tabs.splice(index, 1);
    if (session.active === tab.path) session.active = session.tabs[Math.min(index, session.tabs.length - 1)]?.path || null;
    tab.dispose();
    await this.persist(session);
    this.changed();
  }

  async loadDirectory(path: string) {
    const session = this.session;
    if (!session) return;
    const result = await session.client.call<{ entries: Entry[]; truncated: boolean }>('/entries' + query({ workspaceId: session.workspace.id, path }));
    this.assertSession(session);
    session.directories.set(path, result.entries);
    if (result.truncated) this.error = `Showing the first 10,000 entries in ${path || 'the workspace'}.`;
    this.changed();
  }

  async toggleDirectory(path: string) {
    const session = this.session;
    if (!session) return;
    session.selectedPath = path;
    if (session.expanded.has(path) && path) session.expanded.delete(path);
    else {
      if (session.expanded.size >= 50) throw new Error('Collapse a folder before expanding more than 50 folders.');
      session.expanded.add(path);
      await this.loadDirectory(path);
    }
    this.persistMetadata(session); this.changed();
  }

  async create(path: string, directory: boolean) {
    const session = this.session;
    if (!session) return;
    await session.client.call('/entries', { workspaceId: session.workspace.id, path, directory });
    this.assertSession(session);
    session.expanded.add(parentPath(path));
    await this.loadDirectory(parentPath(path));
    if (!directory) await this.open(path);
  }

  async move(path: string, destination: string) {
    const session = this.session;
    if (!session) return;
    await this.saveAll(session);
    await session.client.call('/entries', { workspaceId: session.workspace.id, path, destination }, 'PATCH');
    this.assertSession(session);
    session.bookmarks.forEach(mark => { mark.path = remapPath(mark.path, path, destination); });
    const reordered = [...session.tabs].map(tab => {
      const next = remapPath(tab.path, path, destination);
      if (next === tab.path) return tab;
      // Monaco model URIs are immutable. Recreate after the successful move so
      // JSON schemas, language services, and reopening the old name stay correct.
      const snapshot = { path: next, text: tab.model.getValue(), revision: tab.revision, bom: tab.bom, eol: tab.eol, size: 0 };
      const viewState = tab.viewState;
      tab.dispose();
      const replacement = this.addTab(session, snapshot);
      replacement.viewState = viewState;
      return replacement;
    });
    session.tabs = reordered;
    session.active = session.active ? remapPath(session.active, path, destination) : null;
    session.expanded = new Set([...session.expanded].map(item => remapPath(item, path, destination)));
    session.directories.clear();
    session.selectedPath = destination;
    await this.persist(session);
    await this.refresh();
  }

  async trash(path: string) {
    const session = this.session;
    if (!session) return;
    await session.client.call('/trash', { workspaceId: session.workspace.id, path });
    this.assertSession(session);
    for (const tab of [...session.tabs]) if (underPath(tab.path, path)) await this.close(tab, true);
    session.bookmarks = session.bookmarks.filter(mark => !underPath(mark.path, path));
    session.directories.clear(); session.selectedPath = '';
    await this.persist(session); await this.refresh();
  }

  async refresh() {
    const session = this.session;
    const generation = this.generation;
    if (!session || this.refreshGeneration === generation) return;
    this.refreshGeneration = generation;
    this.lastRefresh = Date.now();
    try {
      const dirs = [...session.expanded];
      const offset = this.refreshIndex++ * 4;
      const requestedDirs = ['', ...dirs.slice(offset % dirs.length, offset % dirs.length + 4)];
      const tabs = [...new Set([this.activeTab, ...session.tabs.slice(offset % (session.tabs.length || 1), offset % (session.tabs.length || 1) + 4)])].filter((tab): tab is Tab => !!tab);
      const operations = [
        ...[...new Set(requestedDirs)].map(path => this.loadDirectory(path)),
        ...tabs.map(async tab => {
          try {
            const snapshot = await session.client.call<FileSnapshot>('/file' + query({ workspaceId: session.workspace.id, path: tab.path }));
            this.assertSession(session);
            if (!session.tabs.includes(tab)) return;
            if (snapshot.revision !== tab.revision) {
              if (tab.dirty && tab.model.getValue() === modelText(snapshot.text, tab.eol) && tab.bom === snapshot.bom) {
                // A save can finish on disk after the view has switched away.
                // Identical bytes do not need a conflict-resolution dialog.
                tab.baseline = tab.model.getValue(); tab.revision = snapshot.revision; tab.dirty = false; tab.conflict = null;
              } else if (tab.dirty) tab.conflict = snapshot;
              else this.applyDisk(session, tab, snapshot);
            }
            tab.deleted = false;
          } catch (error) {
            if (error instanceof ApiError && error.code === 'not_found') { tab.deleted = true; tab.keepOpen = true; return; }
            throw error;
          }
        }),
        this.refreshConfig(session),
      ];
      const results = await Promise.allSettled(operations);
      this.assertSession(session);
      for (const result of results) if (result.status === 'rejected' && !(result.reason instanceof StaleContext)) {
        if (result.reason instanceof ApiError && result.reason.code === 'workspace_missing') {
          this.refreshGeneration = -1; await this.activate(); return;
        }
        this.error = String(result.reason.message || result.reason);
      }
      this.persistMetadata(session);
      this.changed();
    } finally { if (this.refreshGeneration === generation) this.refreshGeneration = -1; }
  }

  async search(options: SearchOptions): Promise<SearchResults> {
    const session = this.session;
    if (!session) return { items: [], truncated: false };
    return session.client.call('/search', { ...options, workspaceId: session.workspace.id,
      overlays: session.tabs.filter(tab => tab.dirty).map(tab => ({ path: tab.path, text: tab.model.getValue() })),
    });
  }

  toggleBookmark(tab: Tab, line: number) {
    const session = this.session;
    if (!session) return;
    const existing = session.bookmarks.find(mark => mark.path === tab.path && mark.line === line);
    if (existing) session.bookmarks = session.bookmarks.filter(mark => mark !== existing);
    else session.bookmarks.push({ id: crypto.randomUUID(), path: tab.path, line, preview: tab.model.getLineContent(line) });
    this.decorate(session, tab); this.persistMetadata(session); this.changed();
  }

  updateBookmark(id: string, label: string | null) {
    const session = this.session;
    if (!session) return;
    if (label === null) session.bookmarks = session.bookmarks.filter(mark => mark.id !== id);
    else { const mark = session.bookmarks.find(item => item.id === id); if (mark) mark.label = label; }
    session.tabs.forEach(tab => this.decorate(session, tab));
    this.persistMetadata(session); this.changed();
  }

  private decorate(session: Session, tab: Tab) {
    const marks = session.bookmarks.filter(mark => mark.path === tab.path);
    const ids = tab.model.deltaDecorations([...tab.decorations.values()], marks.map(mark => ({
      range: new monaco.Range(Math.max(1, Math.min(mark.line, tab.model.getLineCount())), 1, Math.max(1, Math.min(mark.line, tab.model.getLineCount())), 1),
      options: { glyphMarginClassName: 'hm-bookmark-glyph', isWholeLine: true,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    })));
    tab.decorations = new Map(marks.map((mark, index) => [mark.id, ids[index]]));
  }

  setPreferences(next: Preferences) {
    this.prefs = preferences(next);
    this.ctx.storage.set('preferences.v1', this.prefs);
    this.sessions.forEach(session => session.tabs.forEach(tab => tab.model.updateOptions({ tabSize: this.prefs.tabSize, insertSpaces: this.prefs.insertSpaces })));
    this.changed();
  }

  async refreshConfig(session = this.session) {
    if (!session) return;
    try {
      const config = await session.client.call<ConfigSnapshot>('/scripts' + query({ workspaceId: session.workspace.id }));
      this.assertSession(session);
      session.config = config; session.configError = '';
      if (!config.config.scripts.some(script => script.id === session.selectedScript)) session.selectedScript = config.config.scripts[0]?.id || '';
    } catch (error) {
      if (error instanceof StaleContext) throw error;
      session.configError = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  async saveConfig(config: ScriptsConfig, expectedRevision: string | null) {
    const session = this.session;
    if (!session) return;
    if (session.tabs.some(tab => tab.path === '.hermes/scripts.json' && tab.dirty)) throw new Error('Save or discard the open scripts.json edits before using Edit scripts.');
    const result = await session.client.call<ConfigSnapshot>('/scripts', { workspaceId: session.workspace.id, config, expectedRevision }, 'PUT');
    this.assertSession(session);
    session.config = result; session.configError = '';
    await this.refreshConfig(session); await this.loadDirectory(''); this.changed();
  }

  selectScript(id: string) {
    if (this.session) { this.session.selectedScript = id; this.persistMetadata(this.session); this.changed(); }
  }

  async launch(restart = false) {
    const session = this.session;
    if (!session || this.launching) return;
    const scriptId = session.selectedScript;
    const sequence = ++this.launchSequence;
    this.launching = true; this.changed();
    try {
      await this.saveAll(session);
      this.assertSession(session);
      await this.refreshConfig(session);
      if (session.configError) throw new Error(session.configError);
      if (!session.config.config.scripts.some(script => script.id === scriptId)) throw new Error('The selected script no longer exists.');
      this.assertSession(session);
      if (restart) {
        const current = this.runs.find(run => run.workspaceId === session.workspace.id && run.scriptId === scriptId && isRunning(run));
        if (current) {
          await session.client.call(`/runs/${current.id}/stop`, {});
          for (let attempt = 0; attempt < 30; attempt++) {
            this.assertSession(session);
            const { runs } = await session.client.call<{ runs: Run[] }>('/runs');
            if (!runs.some(run => run.id === current.id && isRunning(run))) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
      this.assertSaved(session);
      const run = await session.client.call<Run>('/runs', { workspaceId: session.workspace.id, scriptId, configRevision: session.config.revision });
      this.assertSession(session);
      this.selectRun(run.id); this.outputOpen = true;
      await this.refreshRuns();
    } finally { if (sequence === this.launchSequence) { this.launching = false; this.changed(); } }
  }

  selectRun(id: string) { this.selectedRun = id; this.output = null; this.cursor = 0; this.changed(); }
  async stop(runId: string) {
    if (!this.session) return;
    await this.session.client.call(`/runs/${runId}/stop`, {}); await this.refreshRuns();
  }

  async refreshRuns() {
    const session = this.session;
    const generation = this.generation;
    if (!session || this.runsGeneration === generation) return;
    this.runsGeneration = generation;
    try {
      const result = await session.client.call<{ runs: Run[] }>('/runs');
      this.assertSession(session);
      this.runs = result.runs;
      if (this.selectedRun && !this.runs.some(run => run.id === this.selectedRun)) this.selectRun('');
      if (this.outputOpen && this.selectedRun) {
        const selected = this.selectedRun;
        const output = await session.client.call<Output>(`/runs/${selected}/output?cursor=${this.cursor}`);
        this.assertSession(session);
        if (selected === this.selectedRun) {
          this.cursor = output.cursor;
          const chunks = [...(this.output?.chunks || []), ...output.chunks];
          let size = chunks.reduce((total, chunk) => total + chunk.text.length, 0);
          while (size > 1_048_576 && chunks.length > 1) size -= chunks.shift()!.text.length;
          this.output = { ...output, chunks, truncated: output.truncated || this.output?.truncated || false };
        }
      }
      this.changed();
    } finally { if (this.runsGeneration === generation) this.runsGeneration = -1; }
  }

  private persistMetadata(session: Session) {
    try {
      this.ctx.storage.set('session.v1:' + session.key, { version: 1, tabs: session.tabs.map(tab => tab.path), active: session.active,
        preview: session.tabs.find(tab => !tab.keepOpen)?.path || null,
        views: Object.fromEntries(session.tabs.filter(tab => tab.viewState).map(tab => [tab.path, tab.viewState!])),
        bookmarks: session.bookmarks, expanded: [...session.expanded], selectedScript: session.selectedScript } satisfies SessionMetadata);
    } catch (error) { this.recoveryError = `Editor preferences could not be stored: ${error}`; }
  }

  private schedulePersist(session: Session) {
    clearTimeout(this.draftTimers.get(session.key));
    this.draftTimers.set(session.key, setTimeout(() => { void this.persist(session); }, 150));
  }

  async persist(session: Session) {
    clearTimeout(this.draftTimers.get(session.key));
    this.draftTimers.delete(session.key);
    this.persistMetadata(session);
    const drafts: Draft[] = session.tabs.filter(tab => tab.dirty).map(tab => ({ path: tab.path, text: tab.model.getValue(),
      baseline: tab.baseline, revision: tab.revision, bom: tab.bom, eol: tab.eol }));
    try { await this.drafts.save(session.key, drafts); this.recoveryError = ''; }
    catch (error) { this.recoveryError = `Draft recovery could not be saved. Keep this window open and save your files: ${error}`; this.changed(); }
  }

  persistAll() { this.sessions.forEach(session => { void this.persist(session); }); }
  dispose() {
    this.persistAll(); this.disposed = true; ++this.generation;
    this.disposeIncompleteRestore();
    clearInterval(this.timer);
    this.draftTimers.forEach(clearTimeout);
    this.sessions.forEach(session => session.tabs.forEach(tab => tab.dispose()));
    this.sessions.clear(); this.listeners.clear();
  }
}
