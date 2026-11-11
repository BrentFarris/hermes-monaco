import { expect, it, vi } from 'vitest';
import type { PluginContext } from '@hermes/plugin-sdk';
import { ApiError, Client, sessionKey, StaleContext } from '../../src/api';

it.each(['connection', 'profile', 'cwd', 'epoch'] as const)('rejects responses after a %s switch', async field => {
  let current = { connection: 'a', profile: 'default', cwd: '/project', epoch: 1 };
  let resolve!: (value: unknown) => void;
  const rest = vi.fn(() => new Promise(done => { resolve = done; }));
  const client = new Client({ rest } as unknown as PluginContext, current, () => current);
  const pending = client.call('/file');
  const result = expect(pending).rejects.toBeInstanceOf(StaleContext);
  current = { ...current, [field]: field === 'epoch' ? 2 : 'other' };
  resolve({ text: 'stale' });
  await result;
  await expect(client.call('/runs', {})).rejects.toBeInstanceOf(StaleContext);
  expect(rest).toHaveBeenCalledTimes(1);
});

it('preserves structured conflicts through the native bridge envelope', async () => {
  const route = { connection: null, profile: '', cwd: '/p', epoch: 0 };
  const ctx = { rest: async () => ({ error: { code: 'conflict', message: 'Changed', current: { text: 'disk' } } }) } as unknown as PluginContext;
  try { await new Client(ctx, route, () => route).call('/file', {}, 'PUT'); throw Error('Expected conflict'); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).details.current).toEqual({ text: 'disk' }); }
});

it('keys state by backend/profile/root but restores it across connection epochs', () => {
  const route = { connection: 'a', profile: 'p', cwd: '/alias', epoch: 1 };
  expect(sessionKey(route, '/root')).toBe(sessionKey({ ...route, epoch: 2 }, '/root'));
  expect(sessionKey(route, '/root')).not.toBe(sessionKey({ ...route, profile: 'other' }, '/root'));
  expect(sessionKey(route, '/root')).not.toBe(sessionKey({ ...route, connection: 'b' }, '/root'));
});
