import type { PluginContext } from '@hermes/plugin-sdk';
import type { editor } from 'monaco-editor';
import { ApiError, Client, query, routeKey, sessionKey, StaleContext } from './api';
import { IndexedDraftStore, type DraftStore } from './drafts';
import { parentPath, preferences, remapPath, underPath } from './editorSettings';
import { languageForPath, monaco } from './monaco';
import { ImageReads } from './imageReads';
import { RequestQueue } from './requestQueue';
import { missingProjectRpc, pathKey, projectKey, projectSpec, refKey, sameRef, scriptKey, type ProjectSpec, type RootSpec } from './project';
import { isMarkdownPath, markdownState } from './markdown';
import type { ImageSnapshot, MarkdownViewMode, MarkdownViewState } from './types';
import type { FileRef, ProjectInfo, ProjectMetadata, ProjectSearchResults, ScriptRef } from './types';
import type { Bookmark, ConfigSnapshot, Draft, Entry, FileSnapshot, Output, Preferences, Route, Run, ScriptsConfig, SearchOptions, SearchResults, SessionMetadata, Workspace } from './types';
import { isRunning } from './types';

export type Tab = FileRef & {
  path: string; model: editor.ITextModel; baseline: string; revision: string | null;
  bom: boolean; eol: 'lf' | 'crlf'; dirty: boolean; deleted: boolean; keepOpen: boolean;
  conflict: FileSnapshot | null; viewState: editor.ICodeEditorViewState | null;
  markdown: MarkdownViewState | null;
  applying: boolean; decorations: Map<string, string>; dispose: () => void;
};

export type FolderSession = {
  key: string; workspace: Workspace; label: string; error: string; tabs: Tab[]; active: string | null;
  bookmarks: Bookmark[]; expanded: Set<string>; directories: Map<string, Entry[]>;
  config: ConfigSnapshot; configError: string; selectedScript: string;
};
export type Session = {
  key: string; name: string; spec: ProjectSpec; client: Client; roots: FolderSession[]; primary: string;
  tabs: Tab[]; active: FileRef | null; selected: FileRef | null; collapsed: Set<string>;
  selectedScript: ScriptRef | null; membership: number; updatingRoots?: boolean;
};

type OpenIntent = { sequence: number; keepOpen: boolean; replacePreview: boolean; line?: number; column: number; endColumn?: number };

const emptyConfig = (): ConfigSnapshot => ({ config: { version: 1, scripts: [] }, revision: null });
const metadataDefault = (): SessionMetadata => ({ version: 1, tabs: [], active: null, bookmarks: [], expanded: [''], selectedScript: '' });
const modelText = (text: string, eol: 'lf' | 'crlf') => text.replace(/\r\n|\r|\n/g, eol === 'crlf' ? '\r\n' : '\n');
const fileRef = (tab: FileRef): FileRef => ({ rootKey: tab.rootKey, path: tab.path });
type ProjectLookup = (route: Route) => Promise<ProjectInfo | null>;

export class Controller {
  session: Session | null = null;
  loading = false;
  error = '';
  recoveryError = '';
  projectError = '';
  prefs: Preferences;
  runs: Run[] = [];
  selectedRun = '';
  output: Output | null = null;
  outputOpen = false;
  launching = false;
  private sessions = new Map<string, FolderSession>();
  private committedSession: Session | null = null;
  private restoring = new Set<FolderSession>();
  private lastSpecs = new Map<string, ProjectSpec>();
  private projectRefresh: Promise<void> | null = null;
  private projectRefreshWanted = false;
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
  private imageReads = new ImageReads();
  private searches = new RequestQueue<SearchResults>(2);
  private cursor = 0;
  private lastRefresh = 0;
  private route: Route;

  constructor(public ctx: PluginContext, private readRoute: () => Route, private drafts: DraftStore = new IndexedDraftStore(), private lookupProject?: ProjectLookup) {
    this.route = readRoute();
    this.prefs = preferences(ctx.storage.get('preferences.v1', null));
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  changed = () => { this.version++; this.listeners.forEach(listener => listener()); };
  get currentRoute() { return this.route; }
  get activeTab() { return this.session?.tabs.find(tab => sameRef(tab, this.session!.active)) || null; }
  get hasDrafts() { return [...this.sessions.values()].some(session => session.tabs.some(tab => tab.dirty)); }
  get bookmarks() { return this.session?.roots.flatMap(root => root.bookmarks.map(mark => ({ ...mark, rootKey: root.key }))) || []; }
  get selectedScriptRoot() { return this.session?.roots.find(root => root.key === this.session!.selectedScript?.rootKey) || null; }
  get selectedScript() { return this.selectedScriptRoot?.config.config.scripts.find(script => script.id === this.session?.selectedScript?.scriptId); }
  get defaultRoot() {
    const session = this.session;
    return session?.roots.find(root => root.key === session.selected?.rootKey) || session?.roots.find(root => root.key === this.activeTab?.rootKey)
      || session?.roots.find(root => root.key === session.primary) || session?.roots[0] || null;
  }
  root(ref: FileRef | string) {
    const root = this.sessions.get(typeof ref === 'string' ? ref : ref.rootKey);
    if (!root) throw new StaleContext();
    return root;
  }
  detached(tab: FileRef) { return !this.session?.roots.some(root => root.key === tab.rootKey); }
  label(ref: FileRef) { return (this.session && this.session.roots.length > 1) || this.detached(ref) ? `${this.root(ref).label}/${ref.path}` : ref.path; }
  private resolveRef(ref: FileRef | string): FileRef {
    if (typeof ref !== 'string') return ref;
    const root = this.defaultRoot;
    if (!root) throw new StaleContext();
    return { rootKey: root.key, path: ref };
  }
  private assertRoot(root: FolderSession, session = this.session) {
    if (!session) throw new StaleContext();
    this.assertSession(session);
    if (session.updatingRoots) throw new StaleContext();
    if (!session.roots.includes(root)) throw new Error('This folder was removed from the project. Add it back in Hermes to save or run files.');
    if (root.error || !root.workspace.id) throw new Error(root.error || 'This folder is unavailable. Retry its connection.');
  }

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
    this.markdownNavigation = null;
    this.runs = [];
    this.selectedRun = '';
    this.output = null;
    this.cursor = 0;
    this.loading = !!next.cwd && this.visible > 0;
    this.error = '';
    this.projectError = '';
    this.changed();
    if (this.visible) void this.perform(() => this.activate());
  }

  assertSession(session: Session, membership = session.membership) {
    session.client.assertCurrent();
    if (this.session !== session || this.disposed || membership !== session.membership) throw new StaleContext();
  }

  async activate() {
    this.disposeIncompleteRestore();
    const generation = ++this.generation;
    this.route = this.readRoute();
    if (!this.route.cwd || this.disposed) { this.session = null; this.loading = false; this.changed(); return; }
    this.loading = true;
    this.error = '';
    this.changed();
    const client = this.newClient();
    try {
      const spec = await this.discover(client, true);
      const key = projectKey(this.route, spec.id, this.route.cwd);
      const metadata = this.ctx.storage.get<ProjectMetadata | null>('project.v1:' + key, null);
      const session: Session = { key, name: spec.name, spec, client, roots: [], primary: '', tabs: [], active: metadata?.active || null,
        selected: null, collapsed: new Set(metadata?.collapsed || []), selectedScript: metadata?.selectedScript || null, membership: 0 };
      this.session = session;
      for (const definition of spec.roots) {
        const root = await this.bindRoot(session, definition);
        if (!session.roots.includes(root)) session.roots.push(root);
        if (definition.primary) session.primary = root.key;
      }
      session.primary ||= session.roots[0]?.key || '';
      const detached: FolderSession[] = [];
      // Membership can change while Code is closed or the browser is offline.
      // Remember prior roots so their drafts can still reappear as detached.
      for (const old of [...(metadata?.roots || []), ...(metadata?.detachedRoots || [])]) {
        if ([...session.roots, ...detached].some(root => root.key === old.key)) continue;
        const root = await this.restoreFolder(session, { id: '', root: old.path, name: old.label }, old.label, '', old.key, true);
        for (const tab of [...root.tabs]) if (!tab.dirty) { root.tabs.splice(root.tabs.indexOf(tab), 1); tab.dispose(); }
        void this.persist(root);
        detached.push(root);
      }
      const tabs = [...session.roots, ...detached].flatMap(root => root.tabs).filter(tab => session.roots.some(root => root.key === tab.rootKey) || tab.dirty);
      const order = new Map((metadata?.tabs || []).map((ref, index) => [refKey(ref), index]));
      session.tabs = tabs.sort((a, b) => (order.get(refKey(a)) ?? Infinity) - (order.get(refKey(b)) ?? Infinity));
      const primary = session.roots.find(root => root.key === session.primary);
      if (!session.tabs.some(tab => sameRef(tab, session.active))) session.active = session.tabs.find(tab => tab.rootKey === primary?.key && tab.path === primary.active) || session.tabs[0] || null;
      // Legacy folder metadata may contain one preview per root. A combined
      // project owns only one, preferring its active file during migration.
      let temporary = session.tabs.find(tab => !tab.keepOpen && sameRef(tab, session.active)) || session.tabs.find(tab => !tab.keepOpen);
      session.tabs.forEach(tab => { if (tab !== temporary && !tab.keepOpen) tab.keepOpen = true; });
      if (!session.selectedScript) {
        const root = primary || session.roots[0];
        if (root?.selectedScript) session.selectedScript = { rootKey: root.key, scriptId: root.selectedScript };
      }
      this.committedSession = session;
      this.loading = false;
      await this.refresh();
      await this.refreshRuns();
      for (const [oldKey, old] of this.sessions) {
        if (this.sessions.size <= 8) break;
        if (!session.roots.includes(old) && !old.tabs.some(tab => tab.dirty)) {
          old.tabs.forEach(tab => tab.dispose()); this.sessions.delete(oldKey);
        }
      }
      this.changed();
    } finally {
      if (generation === this.generation) {
        this.loading = false; this.changed();
        if (this.projectRefreshWanted && this.visible) queueMicrotask(() => { void this.perform(() => this.refreshProject()); });
      }
    }
  }

  private newClient() {
    const generation = this.generation;
    return new Client(this.ctx, { ...this.route }, () => {
      if (generation !== this.generation || this.disposed) throw new StaleContext();
      return this.readRoute();
    });
  }

  private async discover(client: Client, cached = false): Promise<ProjectSpec> {
    const route = { ...this.route };
    const key = JSON.stringify([route.connection, route.profile, pathKey(route.cwd)]);
    try {
      const project = this.lookupProject ? await this.lookupProject(route) : null;
      client.assertCurrent();
      const spec = projectSpec(route.cwd, project);
      this.lastSpecs.set(key, spec); this.projectError = '';
      return spec;
    } catch (error) {
      client.assertCurrent();
      if (missingProjectRpc(error)) { this.projectError = ''; return projectSpec(route.cwd, null); }
      this.projectError = `Could not refresh project folders: ${error instanceof Error ? error.message : error}`;
      if (cached && this.lastSpecs.has(key)) return this.lastSpecs.get(key)!;
      throw error;
    }
  }

  private async bindRoot(session: Session, spec: RootSpec) {
    let workspace: Workspace, error = '';
    try { workspace = await session.client.call<Workspace>('/workspace', { cwd: spec.path }); }
    catch (failure) {
      if (failure instanceof StaleContext) throw failure;
      const previous = [...this.sessions.values()].find(root => pathKey(root.workspace.root) === pathKey(spec.path) && root.key === sessionKey(this.route, root.workspace.root));
      workspace = previous?.workspace || { id: '', root: spec.path, name: spec.label };
      error = failure instanceof Error ? failure.message : String(failure);
    }
    this.assertSession(session);
    return this.restoreFolder(session, workspace, spec.label, error);
  }

  private async restoreFolder(session: Session, workspace: Workspace, label: string, error: string, key = sessionKey(this.route, workspace.root), detached = false): Promise<FolderSession> {
    let folder = this.sessions.get(key);
    if (folder) { if (!detached) { folder.workspace = workspace; folder.error = error; folder.label = label; } return folder; }
    const metadata = this.ctx.storage.get<SessionMetadata>('session.v1:' + key, metadataDefault());
    const recovered = await this.drafts.load(key);
    this.assertSession(session);
    folder = { key, workspace, label, error, tabs: [], active: metadata.active, bookmarks: metadata.bookmarks || [],
      expanded: new Set(['', ...(metadata.expanded || []).slice(0, 49)]), directories: new Map(), config: emptyConfig(), configError: '', selectedScript: metadata.selectedScript || '' };
    this.restoring.add(folder);
    try {
      const files = [...new Set([...(detached ? [] : metadata.tabs || []), ...recovered.map(draft => draft.path)])].slice(0, 40);
      for (const path of files) {
        this.assertSession(session);
        const draft = recovered.find(item => item.path === path);
        let tab: Tab | undefined;
        try {
          if (detached || error || !workspace.id) throw new Error(error || 'Folder removed from project');
          const disk = await session.client.call<FileSnapshot>('/file' + query({ workspaceId: workspace.id, path }));
          this.assertSession(session);
          tab = this.addTab(folder, disk, draft);
        } catch (failure) {
          if (failure instanceof StaleContext) throw failure;
          if (draft) {
            tab = this.addTab(folder, { ...draft, text: draft.baseline, size: 0 }, draft);
            tab.deleted = failure instanceof ApiError && failure.code === 'not_found';
          }
          if (!detached && !error) this.error = `Could not restore ${label}/${path}: ${failure instanceof Error ? failure.message : failure}`;
        }
        if (tab) {
          tab.viewState = metadata.views?.[path] || null;
          if (tab.markdown) tab.markdown = markdownState(metadata.markdown?.[path]);
          tab.keepOpen = detached || metadata.preview !== path || tab.dirty || !!tab.conflict;
        }
      }
      this.assertSession(session);
      this.sessions.set(key, folder);
      return folder;
    } finally {
      this.restoring.delete(folder);
      if (!this.sessions.has(key)) folder.tabs.forEach(tab => { if (!tab.model.isDisposed()) tab.dispose(); });
    }
  }

  refreshProject() {
    this.projectRefreshWanted = true;
    if (this.loading || !this.visible) return Promise.resolve();
    if (this.projectRefresh) return this.projectRefresh;
    const operation = (async () => {
      while (this.projectRefreshWanted && !this.disposed && this.visible && !this.loading) {
        this.projectRefreshWanted = false;
        try { await this.refreshProjectNow(); }
        catch (error) { if (!(error instanceof StaleContext)) throw error; }
      }
    })().finally(() => { if (this.projectRefresh === operation) this.projectRefresh = null; });
    this.projectRefresh = operation;
    return operation;
  }

  private async refreshProjectNow() {
    const session = this.session;
    if (!session || this.loading) { if (!session && this.visible) await this.activate(); return; }
    let spec: ProjectSpec;
    try { spec = await this.discover(session.client); }
    catch (error) { if (error instanceof StaleContext) throw error; this.changed(); return; }
    this.assertSession(session);
    if (projectKey(this.route, spec.id, this.route.cwd) !== session.key) { this.persistAll(); await this.activate(); return; }
    if (JSON.stringify(spec) !== JSON.stringify(session.spec) || session.roots.some(root => root.error || !root.workspace.id)) {
      this.persistAll();
      session.membership++; ++this.generation;
      session.client = this.newClient();
      session.updatingRoots = true; this.changed();
      try {
        const roots: FolderSession[] = [];
        for (const definition of spec.roots) {
          const root = await this.bindRoot(session, definition);
          if (!roots.includes(root)) roots.push(root);
          if (definition.primary) session.primary = root.key;
        }
        for (const root of session.roots) if (!roots.includes(root)) {
          for (const tab of [...root.tabs]) {
            if (tab.dirty) { tab.keepOpen = true; continue; }
            root.tabs.splice(root.tabs.indexOf(tab), 1); tab.dispose();
          }
          void this.persist(root);
        }
        session.tabs = session.tabs.filter(tab => !tab.model.isDisposed());
        for (const root of roots) for (const tab of root.tabs) if (!session.tabs.includes(tab)) {
          tab.keepOpen = true; session.tabs.push(tab);
        }
        session.roots = roots; session.spec = spec; session.name = spec.name;
        if (!session.tabs.some(tab => sameRef(tab, session.active))) session.active = session.tabs[0] || null;
        if (!roots.some(root => root.key === session.selected?.rootKey)) session.selected = null;
        this.persistProject(session); this.changed();
      } finally { session.updatingRoots = false; this.changed(); }
    }
    await this.refresh();
  }

  private disposeIncompleteRestore() {
    this.restoring.forEach(root => root.tabs.forEach(tab => { if (!tab.model.isDisposed()) tab.dispose(); }));
    this.restoring.clear();
  }

  private addTab(session: FolderSession, snapshot: FileSnapshot, draft?: Draft): Tab {
    const model = monaco.editor.createModel(draft?.text ?? snapshot.text, languageForPath(snapshot.path),
      monaco.Uri.parse(`hermes-monaco://${encodeURIComponent(session.key)}/${snapshot.path.split('/').map(encodeURIComponent).join('/')}`));
    model.setEOL((draft?.eol ?? snapshot.eol) === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    model.updateOptions({ tabSize: this.prefs.tabSize, insertSpaces: this.prefs.insertSpaces });
    const baseline = modelText(draft?.baseline ?? snapshot.text, draft?.eol ?? snapshot.eol);
    const tab: Tab = { rootKey: session.key, path: snapshot.path, model, baseline, revision: draft ? draft.revision : snapshot.revision,
      bom: draft?.bom ?? snapshot.bom, eol: draft?.eol ?? snapshot.eol, dirty: model.getValue() !== baseline,
      deleted: false, keepOpen: true, conflict: draft && draft.revision !== snapshot.revision ? snapshot : null,
      viewState: null, markdown: isMarkdownPath(snapshot.path) ? markdownState() : null,
      applying: false, decorations: new Map(), dispose: () => {} };
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

  preview(ref: FileRef | string, line?: number, column = 1, endColumn?: number) {
    return this.open(ref, line, column, endColumn, true);
  }

  async open(value: FileRef | string, line?: number, column = 1, endColumn?: number, preview = false): Promise<Tab> {
    const session = this.session;
    if (!session) throw new StaleContext();
    const ref = this.resolveRef(value);
    const root = this.root(ref);
    this.assertSession(session);
    const intent: OpenIntent = { sequence: ++this.openSequence, keepOpen: !preview, replacePreview: preview, line, column, endColumn };
    const tab = session.tabs.find(item => sameRef(item, ref));
    if (tab) {
      if (!preview) tab.keepOpen = true;
      this.finishOpen(session, tab, intent);
      return tab;
    }

    // Double-clicks can arrive before the first read completes. Share that
    // read and upgrade its intent; never create duplicate Monaco models.
    this.assertRoot(root, session);
    const key = this.generation + '\n' + refKey(ref);
    const pending = this.pendingOpens.get(key);
    if (pending) {
      Object.assign(pending.intent, { ...intent, keepOpen: pending.intent.keepOpen || intent.keepOpen,
        replacePreview: pending.intent.replacePreview });
      return pending.promise;
    }
    const promise = this.loadTab(session, ref, intent).finally(() => { this.pendingOpens.delete(key); });
    this.pendingOpens.set(key, { intent, promise });
    return promise;
  }

  private async loadTab(session: Session, ref: FileRef, intent: OpenIntent): Promise<Tab> {
    const root = this.root(ref);
    const snapshot = await session.client.call<FileSnapshot>('/file' + query({ workspaceId: root.workspace.id, path: ref.path }));
    this.assertSession(session);
    const latest = intent.sequence === this.openSequence;
    if (!latest && !intent.keepOpen) throw new StaleContext();
    // Recheck after the read: the user may have edited or kept the old preview
    // while this file loaded. Older kept opens may finish in the background.
    const previous = session.tabs.find(tab => !tab.keepOpen);
    if (previous && (previous.dirty || previous.conflict || previous.deleted)) previous.keepOpen = true;
    const replaceIndex = intent.replacePreview && latest ? session.tabs.findIndex(tab => !tab.keepOpen) : -1;
    if (session.tabs.length >= 40 && replaceIndex < 0) throw new Error('Close an editor tab before opening more than 40 files.');
    const tab = this.addTab(root, snapshot);
    session.tabs.push(tab);
    tab.keepOpen = intent.keepOpen;
    if (replaceIndex >= 0) {
      const replaced = session.tabs[replaceIndex];
      session.tabs.pop(); // addTab appended the new model; reuse the preview's position.
      session.tabs[replaceIndex] = tab;
      const oldRoot = this.root(replaced);
      oldRoot.tabs.splice(oldRoot.tabs.indexOf(replaced), 1);
      replaced.dispose();
      this.persistMetadata(oldRoot);
    }
    this.finishOpen(session, tab, intent);
    return tab;
  }

  private finishOpen(session: Session, tab: Tab, intent: OpenIntent) {
    if (intent.sequence === this.openSequence) {
      session.active = fileRef(tab);
      session.selected = fileRef(tab);
      this.root(tab).active = tab.path;
      this.markdownNavigation = null;
      if (intent.line && tab.markdown?.mode === 'preview') tab.markdown.mode = 'split';
      this.navigation = intent.line ? { ...fileRef(tab), line: intent.line, column: intent.column, endColumn: intent.endColumn, nonce: intent.sequence } : null;
    }
    this.persistMetadata(this.root(tab)); this.persistProject(session);
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
    this.persistMetadata(this.root(tab)); this.persistProject(session);
    this.changed();
  }

  navigation: (FileRef & { line: number; column: number; endColumn?: number; nonce: number }) | null = null;
  markdownNavigation: { tab: Tab; fragment: string; nonce: number } | null = null;

  setMarkdownMode(tab: Tab, mode: MarkdownViewMode) {
    if (!tab.markdown || !this.session?.tabs.includes(tab)) return;
    tab.markdown.mode = mode;
    this.persistMetadata(this.root(tab));
    this.changed();
  }

  setMarkdownRatio(tab: Tab, ratio: number) {
    if (!tab.markdown || !this.session?.tabs.includes(tab)) return;
    tab.markdown.splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    this.markdownChanged(tab);
    this.changed();
  }

  markdownChanged(tab: Tab) {
    if (this.session?.tabs.includes(tab)) this.schedulePersist(this.root(tab));
  }

  readPreviewImage(tab: Tab, path: string, current: () => boolean) {
    const session = this.session;
    const client = session?.client;
    const root = this.root(tab);
    return this.imageReads.run(() => client!.call<ImageSnapshot>('/preview-image' + query({ workspaceId: root.workspace.id, path })),
      () => !this.disposed && !!session && this.session === session && session.client === client && session.roots.includes(root) && !root.error && this.activeTab === tab && tab.markdown?.mode !== 'edit' && current());
  }

  async openMarkdownLink(source: Tab, path: string, fragment: string) {
    const session = this.session;
    if (!session || this.activeTab !== source) return;
    const target = await this.open({ rootKey: source.rootKey, path });
    this.assertSession(session);
    if (this.activeTab !== target || !fragment || !target.markdown) return;
    if (target.markdown.mode === 'edit') this.setMarkdownMode(target, 'split');
    this.markdownNavigation = { tab: target, fragment, nonce: ++this.openSequence };
    this.changed();
  }

  async openMarkdownExternal(url: string) {
    if (!/^https?:\/\//i.test(url)) return;
    try { if (await this.ctx.os?.openExternal(url)) return; } catch { /* Browser fallback below. */ }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async save(tab = this.activeTab, session = this.session) {
    if (!tab || !session) return;
    // Serialize repeated Ctrl+S/Play saves of the same tab. A second request
    // must use the revision returned by the first, including newer typing.
    while (this.pendingSaves.has(tab)) await this.pendingSaves.get(tab);
    this.assertSession(session);
    if (!session.tabs.includes(tab)) throw new Error('The file was closed before it could be saved.');
    this.assertRoot(this.root(tab), session);
    const operation = this.saveFile(tab, session);
    this.pendingSaves.set(tab, operation);
    try { await operation; }
    finally { if (this.pendingSaves.get(tab) === operation) this.pendingSaves.delete(tab); }
  }

  private async saveFile(tab: Tab, session: Session) {
    this.assertSession(session);
    const root = this.root(tab);
    if (!tab.dirty) return;
    const text = tab.model.getValue();
    try {
      const snapshot = await session.client.call<FileSnapshot>('/file', {
        workspaceId: root.workspace.id, path: tab.path, text, expectedRevision: tab.revision, bom: tab.bom,
      }, 'PUT');
      this.assertSession(session);
      tab.baseline = text; tab.revision = snapshot.revision; tab.conflict = null; tab.deleted = false;
      tab.dirty = tab.model.getValue() !== text;
      await this.persist(root);
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
    const membership = session.membership;
    for (const tab of [...session.tabs]) {
      this.assertSession(session, membership);
      if (tab.conflict || tab.deleted) throw new Error(`Resolve the disk changes in ${this.label(tab)} before continuing.`);
      if (!tab.dirty) continue;
      await this.save(tab, session);
      // A save can finish while typing continues. Do not launch using a
      // mixture of saved and newer unsaved buffers.
      if (tab.dirty) throw new Error('A file changed while saving. Save again before running.');
    }
    this.assertSession(session, membership);
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
    this.applyDisk(this.root(tab), tab, tab.conflict);
    void this.persist(this.root(tab));
    this.changed();
  }

  private applyDisk(session: FolderSession, tab: Tab, snapshot: FileSnapshot) {
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
    if (sameRef(session.active, tab)) session.active = session.tabs[Math.min(index, session.tabs.length - 1)] || null;
    const root = this.root(tab);
    root.tabs.splice(root.tabs.indexOf(tab), 1);
    if (root.active === tab.path) root.active = root.tabs[0]?.path || null;
    tab.dispose();
    await this.persist(root); this.persistProject(session);
    this.changed();
  }

  async loadDirectory(value: FileRef | string) {
    const session = this.session;
    if (!session) return;
    const ref = this.resolveRef(value), root = this.root(ref);
    this.assertRoot(root, session);
    let result: { entries: Entry[]; truncated: boolean };
    try { result = await session.client.call('/entries' + query({ workspaceId: root.workspace.id, path: ref.path })); }
    catch (error) {
      if (!ref.path && error instanceof ApiError && ['not_found', 'permission', 'io_error', 'workspace_changed'].includes(error.code)) { root.error = error.message; this.changed(); }
      throw error;
    }
    this.assertSession(session);
    root.directories.set(ref.path, result.entries);
    if (result.truncated) this.error = `Showing the first 10,000 entries in ${this.label(ref)}.`;
    this.changed();
  }

  async toggleDirectory(ref: FileRef) {
    const session = this.session;
    if (!session) return;
    const root = this.root(ref), path = ref.path;
    session.selected = ref;
    if (!path) {
      if (session.collapsed.has(root.key)) { session.collapsed.delete(root.key); await this.loadDirectory(ref); }
      else session.collapsed.add(root.key);
      this.persistProject(session); this.changed(); return;
    }
    if (root.expanded.has(path)) root.expanded.delete(path);
    else {
      if (root.expanded.size >= 50) throw new Error('Collapse a folder before expanding more than 50 folders.');
      root.expanded.add(path);
      await this.loadDirectory(ref);
    }
    this.persistMetadata(root); this.changed();
  }

  async create(value: FileRef | string, directory: boolean) {
    const session = this.session;
    if (!session) return;
    const ref = this.resolveRef(value), root = this.root(ref), path = ref.path;
    this.assertRoot(root, session);
    await session.client.call('/entries', { workspaceId: root.workspace.id, path, directory });
    this.assertSession(session);
    root.expanded.add(parentPath(path)); session.collapsed.delete(root.key);
    await this.loadDirectory({ rootKey: root.key, path: parentPath(path) });
    if (!directory) await this.open(ref);
  }

  async move(ref: FileRef, destination: string) {
    const session = this.session;
    if (!session) return;
    const root = this.root(ref), path = ref.path, membership = session.membership;
    this.assertRoot(root, session);
    if (!path) throw new Error('Manage project folders in Hermes.');
    await this.saveAll(session);
    this.assertSession(session, membership);
    await session.client.call('/entries', { workspaceId: root.workspace.id, path, destination }, 'PATCH');
    this.assertSession(session);
    root.bookmarks.forEach(mark => { mark.path = remapPath(mark.path, path, destination); });
    const reordered = [...session.tabs].map(tab => {
      if (tab.rootKey !== root.key) return tab;
      const next = remapPath(tab.path, path, destination);
      if (next === tab.path) return tab;
      // Monaco model URIs are immutable. Recreate after the successful move so
      // JSON schemas, language services, and reopening the old name stay correct.
      const snapshot = { path: next, text: tab.model.getValue(), revision: tab.revision, bom: tab.bom, eol: tab.eol, size: 0 };
      const viewState = tab.viewState;
      root.tabs.splice(root.tabs.indexOf(tab), 1);
      tab.dispose();
      const replacement = this.addTab(root, snapshot);
      replacement.viewState = viewState;
      if (replacement.markdown && tab.markdown) replacement.markdown = { ...tab.markdown };
      replacement.keepOpen = tab.keepOpen;
      return replacement;
    });
    session.tabs = reordered;
    if (session.active?.rootKey === root.key) session.active = { rootKey: root.key, path: remapPath(session.active.path, path, destination) };
    root.active = root.active ? remapPath(root.active, path, destination) : null;
    root.expanded = new Set([...root.expanded].map(item => remapPath(item, path, destination)));
    root.directories.clear();
    session.selected = { rootKey: root.key, path: destination };
    await this.persist(root); this.persistProject(session);
    await this.refresh();
  }

  async trash(ref: FileRef) {
    const session = this.session;
    if (!session) return;
    const root = this.root(ref), path = ref.path;
    this.assertRoot(root, session);
    if (!path) throw new Error('Manage project folders in Hermes.');
    await session.client.call('/trash', { workspaceId: root.workspace.id, path });
    this.assertSession(session);
    for (const tab of [...root.tabs]) if (underPath(tab.path, path)) await this.close(tab, true);
    root.bookmarks = root.bookmarks.filter(mark => !underPath(mark.path, path));
    root.directories.clear(); session.selected = null;
    await this.persist(root); await this.refresh();
  }

  async refresh() {
    const session = this.session;
    const generation = this.generation;
    if (!session || session.updatingRoots || this.refreshGeneration === generation) return;
    this.refreshGeneration = generation;
    this.lastRefresh = Date.now();
    try {
      const available = session.roots.filter(root => !root.error && root.workspace.id);
      const dirs = available.flatMap(root => [...root.expanded].map(path => ({ rootKey: root.key, path })));
      const offset = this.refreshIndex++ * 4;
      const requestedDirs = dirs.slice(offset % (dirs.length || 1), offset % (dirs.length || 1) + 4);
      for (const root of available) if (!root.directories.has('') && !requestedDirs.some(ref => ref.rootKey === root.key && !ref.path)) requestedDirs.push({ rootKey: root.key, path: '' });
      const tabs = [...new Set([this.activeTab, ...session.tabs.slice(offset % (session.tabs.length || 1), offset % (session.tabs.length || 1) + 4)])].filter((tab): tab is Tab => !!tab);
      const operations = [
        ...requestedDirs.map(ref => this.loadDirectory(ref)),
        ...tabs.map(async tab => {
          const root = this.root(tab);
          if (!available.includes(root)) return;
          try {
            const snapshot = await session.client.call<FileSnapshot>('/file' + query({ workspaceId: root.workspace.id, path: tab.path }));
            this.assertSession(session);
            if (!session.tabs.includes(tab)) return;
            if (snapshot.revision !== tab.revision) {
              if (tab.dirty && tab.model.getValue() === modelText(snapshot.text, tab.eol) && tab.bom === snapshot.bom) {
                // A save can finish on disk after the view has switched away.
                // Identical bytes do not need a conflict-resolution dialog.
                tab.baseline = tab.model.getValue(); tab.revision = snapshot.revision; tab.dirty = false; tab.conflict = null;
              } else if (tab.dirty) tab.conflict = snapshot;
              else this.applyDisk(root, tab, snapshot);
            }
            tab.deleted = false;
          } catch (error) {
            if (error instanceof ApiError && error.code === 'not_found') { tab.deleted = true; tab.keepOpen = true; return; }
            throw error;
          }
        }),
        ...available.map(root => this.refreshConfig(root, session)),
      ];
      const results = await Promise.allSettled(operations);
      this.assertSession(session);
      for (const result of results) if (result.status === 'rejected' && !(result.reason instanceof StaleContext)) {
        if (result.reason instanceof ApiError && result.reason.code === 'workspace_missing') {
          this.refreshGeneration = -1; await this.activate(); return;
        }
        this.error = String(result.reason.message || result.reason);
      }
      this.ensureScriptSelection(session);
      session.roots.forEach(root => this.persistMetadata(root)); this.persistProject(session);
      this.changed();
    } finally { if (this.refreshGeneration === generation) this.refreshGeneration = -1; }
  }

  async search(options: SearchOptions): Promise<ProjectSearchResults> {
    const session = this.session;
    if (!session || session.updatingRoots) return { items: [], truncated: false };
    const client = session.client, membership = session.membership;
    const roots = session.roots.filter(root => !root.error && root.workspace.id);
    const current = () => !this.disposed && this.session === session && session.membership === membership && session.client === client;
    const results = await Promise.allSettled(roots.map(root => this.searches.run(() => client.call<SearchResults>('/search', { ...options, workspaceId: root.workspace.id,
      overlays: root.tabs.filter(tab => tab.dirty).map(tab => ({ path: tab.path, text: tab.model.getValue() })),
    }), current)));
    this.assertSession(session, membership);
    const combined: ProjectSearchResults = { items: [], truncated: false, errors: session.roots.filter(root => root.error).map(root => `${root.label}: ${root.error}`) };
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        combined.items.push(...result.value.items.map(item => ({ ...item, rootKey: roots[index].key })));
        combined.truncated ||= result.value.truncated;
      } else if (!(result.reason instanceof StaleContext)) combined.errors!.push(`${roots[index].label}: ${result.reason.message || result.reason}`);
    });
    combined.truncated ||= combined.items.length > 500;
    combined.items = combined.items.slice(0, 500);
    return combined;
  }

  toggleBookmark(tab: Tab, line: number) {
    if (!this.session) return;
    const session = this.root(tab);
    const existing = session.bookmarks.find(mark => mark.path === tab.path && mark.line === line);
    if (existing) session.bookmarks = session.bookmarks.filter(mark => mark !== existing);
    else session.bookmarks.push({ id: crypto.randomUUID(), path: tab.path, line, preview: tab.model.getLineContent(line) });
    this.decorate(session, tab); this.persistMetadata(session); this.changed();
  }

  updateBookmark(ref: { rootKey: string; id: string }, label: string | null) {
    const session = this.session?.roots.find(root => root.key === ref.rootKey);
    if (!session) return;
    if (label === null) session.bookmarks = session.bookmarks.filter(mark => mark.id !== ref.id);
    else { const mark = session.bookmarks.find(item => item.id === ref.id); if (mark) mark.label = label; }
    session.tabs.forEach(tab => this.decorate(session, tab));
    this.persistMetadata(session); this.changed();
  }

  private decorate(session: FolderSession, tab: Tab) {
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

  async refreshConfig(root: FolderSession, session = this.session) {
    if (!session) return;
    try {
      this.assertRoot(root, session);
      const config = await session.client.call<ConfigSnapshot>('/scripts' + query({ workspaceId: root.workspace.id }));
      this.assertSession(session);
      root.config = config; root.configError = '';
      if (!config.config.scripts.some(script => script.id === root.selectedScript)) root.selectedScript = config.config.scripts[0]?.id || '';
    } catch (error) {
      if (error instanceof StaleContext) throw error;
      root.configError = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  async saveConfig(root: FolderSession, config: ScriptsConfig, expectedRevision: string | null) {
    const session = this.session;
    if (!session) return;
    this.assertRoot(root, session);
    if (root.tabs.some(tab => tab.path === '.hermes/scripts.json' && tab.dirty)) throw new Error(`Save or discard ${root.label}/.hermes/scripts.json edits before using Edit scripts.`);
    const result = await session.client.call<ConfigSnapshot>('/scripts', { workspaceId: root.workspace.id, config, expectedRevision }, 'PUT');
    this.assertSession(session);
    root.config = result; root.configError = '';
    await this.refreshConfig(root, session); this.ensureScriptSelection(session);
    await this.loadDirectory({ rootKey: root.key, path: '' }); this.changed();
  }

  private ensureScriptSelection(session: Session) {
    const selected = session.selectedScript;
    const selectedRoot = session.roots.find(root => root.key === selected?.rootKey);
    // Retain an explicit selection through temporary invalid configuration.
    if (selectedRoot && (selectedRoot.error || selectedRoot.configError || selectedRoot.config.config.scripts.some(script => script.id === selected?.scriptId))) return;
    const ordered = [...session.roots].sort((a, b) => Number(b.key === session.primary) - Number(a.key === session.primary));
    const root = ordered.find(item => !item.error && !item.configError && item.config.config.scripts.length);
    session.selectedScript = root ? { rootKey: root.key, scriptId: root.selectedScript || root.config.config.scripts[0].id } : null;
  }

  selectScript(value: string) {
    const session = this.session;
    if (!session) return;
    const ref = session.roots.flatMap(root => root.config.config.scripts.map(script => ({ rootKey: root.key, scriptId: script.id }))).find(ref => scriptKey(ref) === value);
    if (ref) { session.selectedScript = ref; this.root(ref.rootKey).selectedScript = ref.scriptId; this.persistProject(session); this.changed(); }
  }

  async launch(restart = false) {
    const session = this.session;
    if (!session || this.launching) return;
    const selection = session.selectedScript;
    if (!selection) return;
    const root = this.root(selection.rootKey), scriptId = selection.scriptId, membership = session.membership;
    this.assertRoot(root, session);
    const sequence = ++this.launchSequence;
    this.launching = true; this.changed();
    try {
      await this.saveAll(session);
      this.assertSession(session, membership);
      await this.refreshConfig(root, session);
      if (root.configError) throw new Error(root.configError);
      if (!root.config.config.scripts.some(script => script.id === scriptId)) throw new Error('The selected script no longer exists.');
      this.assertSession(session, membership);
      if (restart) {
        const current = this.runs.find(run => run.workspaceId === root.workspace.id && run.scriptId === scriptId && isRunning(run));
        if (current) {
          await session.client.call(`/runs/${current.id}/stop`, {});
          for (let attempt = 0; attempt < 30; attempt++) {
            this.assertSession(session, membership);
            const { runs } = await session.client.call<{ runs: Run[] }>('/runs');
            if (!runs.some(run => run.id === current.id && isRunning(run))) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
      this.assertSession(session, membership);
      this.assertSaved(session);
      const run = await session.client.call<Run>('/runs', { workspaceId: root.workspace.id, scriptId, configRevision: root.config.revision });
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

  private persistMetadata(session: FolderSession) {
    try {
      this.ctx.storage.set('session.v1:' + session.key, { version: 1, tabs: session.tabs.map(tab => tab.path), active: session.active,
        preview: session.tabs.find(tab => !tab.keepOpen)?.path || null,
        views: Object.fromEntries(session.tabs.filter(tab => tab.viewState).map(tab => [tab.path, tab.viewState!])),
        markdown: Object.fromEntries(session.tabs.filter(tab => tab.markdown).map(tab => [tab.path, tab.markdown!])),
        bookmarks: session.bookmarks, expanded: [...session.expanded], selectedScript: session.selectedScript } satisfies SessionMetadata);
    } catch (error) { this.recoveryError = `Editor preferences could not be stored: ${error}`; }
  }

  private persistProject(session: Session) {
    try {
      const detached = [...new Set(session.tabs.filter(tab => !session.roots.some(root => root.key === tab.rootKey)).map(tab => tab.rootKey))].map(key => this.root(key));
      this.ctx.storage.set('project.v1:' + session.key, { version: 1, tabs: session.tabs.filter(tab => !tab.model.isDisposed()).map(fileRef), active: session.active ? fileRef(session.active) : null,
        collapsed: [...session.collapsed], selectedScript: session.selectedScript,
        roots: session.roots.map(root => ({ key: root.key, path: root.workspace.root, label: root.label })),
        detachedRoots: detached.map(root => ({ key: root.key, path: root.workspace.root, label: root.label })) } satisfies ProjectMetadata);
    } catch (error) { this.recoveryError = `Project preferences could not be stored: ${error}`; }
  }

  private schedulePersist(session: FolderSession) {
    clearTimeout(this.draftTimers.get(session.key));
    this.draftTimers.set(session.key, setTimeout(() => { void this.persist(session); }, 150));
  }

  async persist(session: FolderSession) {
    clearTimeout(this.draftTimers.get(session.key));
    this.draftTimers.delete(session.key);
    this.persistMetadata(session);
    const drafts: Draft[] = session.tabs.filter(tab => tab.dirty).map(tab => ({ path: tab.path, text: tab.model.getValue(),
      baseline: tab.baseline, revision: tab.revision, bom: tab.bom, eol: tab.eol }));
    try { await this.drafts.save(session.key, drafts); this.recoveryError = ''; }
    catch (error) { this.recoveryError = `Draft recovery could not be saved. Keep this window open and save your files: ${error}`; this.changed(); }
  }

  persistAll() {
    this.sessions.forEach(session => { void this.persist(session); });
    if (this.session && this.committedSession === this.session) this.persistProject(this.session);
  }
  dispose() {
    this.persistAll(); this.disposed = true; ++this.generation;
    this.imageReads.dispose();
    this.searches.dispose();
    this.disposeIncompleteRestore();
    clearInterval(this.timer);
    this.draftTimers.forEach(clearTimeout);
    this.sessions.forEach(session => session.tabs.forEach(tab => tab.dispose()));
    this.sessions.clear(); this.listeners.clear();
  }
}
