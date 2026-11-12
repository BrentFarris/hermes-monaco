import type { FileRef, ProjectInfo, Route, ScriptRef } from './types';

export const refKey = (ref: FileRef) => JSON.stringify([ref.rootKey, ref.path]);
export const sameRef = (a: FileRef | null, b: FileRef | null) => !!a && !!b && a.rootKey === b.rootKey && a.path === b.path;
export const scriptKey = (ref: ScriptRef | null) => ref ? JSON.stringify([ref.rootKey, ref.scriptId]) : '';
export const pathKey = (path: string) => {
  const clean = path.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return /^[a-z]:/i.test(clean) || clean.startsWith('//') ? clean.toLowerCase() : clean;
};
export const projectKey = (route: Route, id: string | null, root: string) => JSON.stringify([route.connection, route.profile, id ? 'project' : 'folder', id || pathKey(root)]);
export type RootSpec = { path: string; label: string; primary: boolean };
export type ProjectSpec = { id: string | null; name: string; roots: RootSpec[] };

export function projectSpec(cwd: string, project: ProjectInfo | null): ProjectSpec {
  const roots: RootSpec[] = [];
  const seen = new Set<string>();
  const folders = project?.folders.length ? project.folders : [{ path: cwd, is_primary: true }];
  for (const folder of folders) {
    if (!folder.path || seen.has(pathKey(folder.path))) continue;
    seen.add(pathKey(folder.path));
    roots.push({ path: folder.path, label: folder.label?.trim() || folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path,
      primary: !!folder.is_primary || !!project?.primary_path && pathKey(folder.path) === pathKey(project.primary_path) });
  }
  if (roots.length && !roots.some(root => root.primary)) roots[0].primary = true;
  const labels = roots.map(root => root.label);
  roots.forEach(root => { if (labels.filter(label => label === root.label).length > 1) root.label += ' — ' + root.path; });
  return { id: project?.id || null, name: project?.name || roots[0]?.label || 'Workspace', roots };
}

export const missingProjectRpc = (error: unknown) => {
  const value = error as { code?: number; message?: string };
  return value?.code === -32601 || /(?:unknown|not found|unsupported|no such) (?:rpc )?method|method.*(?:not found|not supported)|unknown rpc/i.test(value?.message || String(error));
};
