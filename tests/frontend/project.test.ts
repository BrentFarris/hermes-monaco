import { expect, it } from 'vitest';
import { missingProjectRpc, pathKey, projectKey, projectSpec, refKey, sameRef, scriptKey } from '../../src/project';

it('keeps identical relative file and script names in different roots distinct', () => {
  const a = { rootKey: 'a', path: 'src/main.ts' }, b = { rootKey: 'b', path: 'src/main.ts' };
  expect(refKey(a)).not.toBe(refKey(b)); expect(sameRef(a, b)).toBe(false); expect(sameRef(a, { ...a })).toBe(true);
  expect(scriptKey({ rootKey: 'a', scriptId: 'dev' })).not.toBe(scriptKey({ rootKey: 'b', scriptId: 'dev' }));
});

it('keeps backend/profile/project identity stable across cwd and connection epoch changes', () => {
  const route = { connection: 'server', profile: 'default', cwd: '/a', epoch: 1 };
  const key = projectKey(route, 'p_project', '/a');
  expect(projectKey({ ...route, cwd: '/b', epoch: 2 }, 'p_project', '/b')).toBe(key);
  expect(projectKey({ ...route, profile: 'other' }, 'p_project', '/a')).not.toBe(key);
  expect(projectKey({ ...route, connection: 'other' }, 'p_project', '/a')).not.toBe(key);
  expect(projectKey(route, null, '/a')).not.toBe(projectKey(route, null, '/b'));
});

it('preserves project order, handles Windows aliases, and disambiguates duplicate folder labels', () => {
  const spec = projectSpec('C:\\Code\\App', { id: 'p', name: 'Project', primary_path: 'c:/code/app', folders: [
    { path: 'C:\\Code\\App', label: 'App' }, { path: 'c:/code/app/' }, { path: 'D:/other/App', label: 'App' }, { path: 'C:/Code/App/nested' },
  ] });
  expect(spec.roots).toHaveLength(3); expect(spec.roots[0].primary).toBe(true);
  expect(spec.roots[0].label).toContain('C:\\Code\\App'); expect(spec.roots[1].label).toContain('D:/other/App');
  expect(spec.roots[2].path).toBe('C:/Code/App/nested');
  expect(pathKey('/code/App')).not.toBe(pathKey('/code/app'));
});

it('falls back for ungrouped directories and distinguishes absent RPCs from transient failures', () => {
  expect(projectSpec('/code/app', null)).toEqual({ id: null, name: 'app', roots: [{ path: '/code/app', label: 'app', primary: true }] });
  expect(missingProjectRpc({ code: -32601 })).toBe(true);
  expect(missingProjectRpc(new Error('Unknown method: projects.for_cwd'))).toBe(true);
  expect(missingProjectRpc(new Error('Hermes gateway unavailable'))).toBe(false);
});
