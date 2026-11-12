import { expect, it, vi } from 'vitest';
import type { PluginContext } from '@hermes/plugin-sdk';
import type { DraftStore } from '../../src/drafts';
import type { SearchOptions, SearchResults } from '../../src/types';
vi.mock('../../src/monaco', () => ({ monaco: {}, languageForPath: () => 'plaintext' }));
import { Controller, type FolderSession, type Session, type Tab } from '../../src/controller';

const options: SearchOptions = { query: 'needle', kind: 'text', case: false, word: false, regex: false, ignored: false, include: [], exclude: [] };
function setup() {
  const ctx = { storage: { get: (_: string, fallback: unknown) => fallback } } as unknown as PluginContext;
  const drafts: DraftStore = { load: async () => [], save: async () => {} };
  const controller = new Controller(ctx, () => ({ connection: 'local', profile: 'default', cwd: '/a', epoch: 0 }), drafts);
  const roots = ['a', 'b', 'c'].map(key => ({ key, label: key, error: '', workspace: { id: key }, tabs: [] } as unknown as FolderSession));
  const call = vi.fn<(...args: any[]) => Promise<SearchResults>>();
  const session = { roots, membership: 0, client: { assertCurrent() {}, call } } as unknown as Session;
  controller.session = session;
  return { controller, roots, session, call };
}
const results = (count: number): SearchResults => ({ items: Array.from({ length: count }, (_, index) => ({ path: 'same.ts', line: index + 1, preview: 'needle' })), truncated: false });

it('searches at most two roots concurrently and limits combined results to 500', async () => {
  const { controller, call } = setup();
  const pending: ((value: SearchResults) => void)[] = [];
  call.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const search = controller.search(options);
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  pending[0](results(200));
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  pending[1](results(200)); pending[2](results(200));
  const found = await search;
  expect(found.items).toHaveLength(500); expect(found.truncated).toBe(true);
  expect(found.items[0].rootKey).toBe('a'); expect(found.items[200].rootKey).toBe('b'); expect(found.items[400].rootKey).toBe('c');
});

it('discards stale queued roots without exceeding the limit across membership changes', async () => {
  const { controller, session, call } = setup();
  const pending: ((value: SearchResults) => void)[] = [];
  call.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const oldSearch = controller.search(options).catch(error => error);
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  session.membership++;
  session.roots = session.roots.slice(0, 1);
  const newSearch = controller.search({ ...options, query: 'new' });
  await Promise.resolve(); expect(call).toHaveBeenCalledTimes(2);
  pending[0](results(1));
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  expect(call.mock.calls[2][1]).toMatchObject({ workspaceId: 'a', query: 'new' });
  pending[1](results(1)); pending[2](results(1));
  expect((await oldSearch).message).toContain('workspace changed');
  expect((await newSearch).items).toHaveLength(1);
  expect(call).toHaveBeenCalledTimes(3);
});

it('keeps dirty overlays and partial failures attached to their owning root', async () => {
  const { controller, roots, call } = setup();
  roots[0].tabs = [{ dirty: true, path: 'same.ts', model: { getValue: () => 'unsaved a' } } as Tab];
  roots[1].tabs = [{ dirty: true, path: 'same.ts', model: { getValue: () => 'unsaved b' } } as Tab];
  roots[2].error = 'Folder unavailable';
  call.mockImplementation(async (_, body) => { if (body.workspaceId === 'b') throw new Error('Search failed'); return results(1); });
  const found = await controller.search(options);
  expect(call.mock.calls[0][1]).toMatchObject({ workspaceId: 'a', overlays: [{ path: 'same.ts', text: 'unsaved a' }] });
  expect(call.mock.calls[1][1]).toMatchObject({ workspaceId: 'b', overlays: [{ path: 'same.ts', text: 'unsaved b' }] });
  expect(found.items[0].rootKey).toBe('a');
  expect(found.errors).toEqual(['c: Folder unavailable', 'b: Search failed']);
});
