import { expect, it, vi } from 'vitest';
import type { PluginContext } from '@hermes/plugin-sdk';
import type { DraftStore } from '../../src/drafts';
import type { Route } from '../../src/types';
vi.mock('../../src/monaco', () => ({ monaco: {}, languageForPath: () => 'plaintext' }));
import { Controller, type FolderSession, type Session, type Tab } from '../../src/controller';

function setup() {
  let route: Route = { connection: 'local', profile: 'default', cwd: '/a', epoch: 0 };
  const rest = vi.fn(async () => ({}));
  const ctx = { rest, storage: { get: (_: string, fallback: unknown) => fallback, set: vi.fn() } } as unknown as PluginContext;
  const drafts: DraftStore = { load: async () => [], save: async () => {} };
  const controller = new Controller(ctx, () => route, drafts);
  const root = { workspace: { id: 'a', root: '/a', name: 'a' }, key: 'a', tabs: [], selectedScript: 'dev',
    config: { config: { version: 1, scripts: [{ id: 'dev', name: 'Dev', command: 'echo hello' }] }, revision: 'one' },
    error: '', configError: '' } as unknown as FolderSession;
  const session = { key: 'project', tabs: [], roots: [root], membership: 0, selectedScript: { rootKey: root.key, scriptId: 'dev' },
    client: { assertCurrent() {}, call: vi.fn(async (path: string) => path === '/runs' ? { id: 'run' } : {}) } } as unknown as Session;
  (controller as unknown as { sessions: Map<string, FolderSession> }).sessions.set(root.key, root);
  controller.session = session;
  vi.spyOn(controller, 'refreshConfig').mockImplementation(async () => {});
  vi.spyOn(controller, 'refreshRuns').mockImplementation(async () => {});
  return { controller, session, switchWorkspace: () => { route = { ...route, cwd: '/b' }; controller.session = null; } };
}

it('cancels a launch when any file save fails', async () => {
  const { controller, session } = setup();
  session.tabs = [{ rootKey: 'a', dirty: true, path: 'a.ts' } as Tab];
  vi.spyOn(controller, 'save').mockRejectedValue(new Error('Permission denied'));
  await expect(controller.launch()).rejects.toThrow('Permission denied');
  expect(session.client.call).not.toHaveBeenCalled();
  expect(controller.launching).toBe(false);
});

it('rejects conflicts and edits to an earlier tab while later tabs save', async () => {
  const { controller, session } = setup();
  const first = { rootKey: 'a', dirty: true, path: 'a.ts', conflict: {} } as Tab;
  session.tabs = [first];
  await expect(controller.launch()).rejects.toThrow('Resolve');
  first.conflict = null;
  const second = { rootKey: 'a', dirty: true, path: 'b.ts' } as Tab;
  session.tabs.push(second);
  vi.spyOn(controller, 'save').mockImplementation(async tab => {
    tab!.dirty = false;
    if (tab === second) first.dirty = true;
  });
  await expect(controller.launch()).rejects.toThrow('A file changed');
  expect(session.client.call).not.toHaveBeenCalled();
});

it('cancels a launch when the workspace changes during saving', async () => {
  const { controller, session, switchWorkspace } = setup();
  session.tabs = [{ rootKey: 'a', dirty: true, path: 'a.ts' } as Tab];
  vi.spyOn(controller, 'save').mockImplementation(async tab => { tab!.dirty = false; switchWorkspace(); });
  await expect(controller.launch()).rejects.toThrow('workspace changed');
  expect(session.client.call).not.toHaveBeenCalled();
});

it('checks again for newer edits after reading the script configuration', async () => {
  const { controller, session } = setup();
  session.tabs = [{ rootKey: 'a', dirty: false, path: 'a.ts' } as Tab];
  vi.spyOn(controller, 'save').mockImplementation(async () => {});
  vi.mocked(controller.refreshConfig).mockImplementation(async () => { session.tabs[0].dirty = true; });
  await expect(controller.launch()).rejects.toThrow('A file changed');
  expect(session.client.call).not.toHaveBeenCalled();
});

it('serializes repeated saves and uses the returned revision for newer typing', async () => {
  const { controller, session } = setup();
  let text = 'first';
  const tab = { rootKey: 'a', path: 'a.ts', dirty: true, revision: 'old', model: { getValue: () => text } } as unknown as Tab;
  session.tabs = [tab];
  vi.spyOn(controller, 'persist').mockResolvedValue();
  let resolve!: (snapshot: any) => void;
  vi.mocked(session.client.call).mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValueOnce({ revision: 'second' });
  const first = controller.save(tab, session);
  text = 'newer';
  const second = controller.save(tab, session);
  expect(session.client.call).toHaveBeenCalledTimes(1);
  resolve({ revision: 'first' });
  await Promise.all([first, second]);
  expect(session.client.call).toHaveBeenLastCalledWith('/file', expect.objectContaining({ text: 'newer', expectedRevision: 'first' }), 'PUT');
  expect(tab.dirty).toBe(false);
});
