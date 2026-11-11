import type { Preferences } from './types';

export const defaults: Preferences = { rulers: [80, 90], guides: true, fontSize: 14, tabSize: 4, insertSpaces: true, wordWrap: false };

// Adapted from Echo's columnGuides.ts, MIT; see THIRD_PARTY_NOTICES.md.
export function parseRulers(text: string): number[] | null {
  const parts = text.split(',').map(part => part.trim());
  if (!parts.every(part => /^\d+$/.test(part))) return null;
  const values = parts.map(Number);
  return values.every(n => Number.isInteger(n) && n >= 1 && n <= 10_000)
    ? [...new Set(values)].sort((a, b) => a - b) : null;
}

export function preferences(value: Partial<Preferences> | null): Preferences {
  const input = value || {};
  return {
    rulers: Array.isArray(input.rulers) ? parseRulers(input.rulers.join(',')) || defaults.rulers : defaults.rulers,
    guides: input.guides !== false,
    fontSize: Number.isFinite(input.fontSize) ? Math.max(10, Math.min(32, input.fontSize!)) : 14,
    tabSize: [2, 4, 8].includes(input.tabSize!) ? input.tabSize! : 4,
    insertSpaces: input.insertSpaces !== false, wordWrap: input.wordWrap === true,
  };
}

export const remapPath = (path: string, oldPath: string, newPath: string) =>
  path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
export const underPath = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
export const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

