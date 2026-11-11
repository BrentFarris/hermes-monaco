import { expect, it } from 'vitest';
import { isMarkdownPath, markdownState, markdownTarget } from '../../src/markdown';
import { ImageReads } from '../../src/imageReads';
import type { ImageSnapshot } from '../../src/types';

it('detects Markdown extensions and normalizes old or malformed tab metadata', () => {
  expect(['readme.md', 'docs/NOTES.MARKDOWN', 'a.Md'].every(isMarkdownPath)).toBe(true);
  expect(['a.mdx', 'md', 'readme.md.txt'].some(isMarkdownPath)).toBe(false);
  expect(markdownState()).toEqual({ mode: 'split', splitRatio: 0.5, previewScrollTop: 0 });
  expect(markdownState({ mode: 'preview', splitRatio: 1.3, previewScrollTop: -20 })).toEqual({ mode: 'preview', splitRatio: 0.8, previewScrollTop: 0 });
  expect(markdownState({ splitRatio: NaN, previewScrollTop: Infinity }).splitRatio).toBe(0.5);
});

it('resolves document, root, Unicode, and heading links without touching host routes', () => {
  expect(markdownTarget('../guide/intro%20λ.md#caf%C3%A9', 'docs/readme.md')).toEqual({ kind: 'file', path: 'guide/intro λ.md', fragment: 'café' });
  expect(markdownTarget('/images/logo.svg', 'docs/readme.md')).toEqual({ kind: 'file', path: 'images/logo.svg', fragment: '' });
  expect(markdownTarget('readme.md#intro', 'docs/readme.md')).toEqual({ kind: 'anchor', fragment: 'intro' });
  expect(markdownTarget('#', 'readme.md')).toEqual({ kind: 'anchor', fragment: '' });
  expect(markdownTarget('other.md?raw=1#intro', 'docs/readme.md')).toEqual({ kind: 'file', path: 'docs/other.md', fragment: 'intro' });
  expect(markdownTarget('HTTPS://example.com/docs', 'readme.md')).toEqual({ kind: 'external', url: 'https://example.com/docs' });
});

it.each(['../../outside.md', '/../../outside.md', '%2e%2e/%2e%2e/private', 'javascript:alert(1)', 'data:text/html,x', '//evil.test/a', '%2f%2fevil.test/a', 'file:///private', 'C:/private', '..\\private', '%5cprivate', 'x%00.md', '%xx', 'x%3astream'])('blocks unsafe Markdown target %s', target => {
  expect(markdownTarget(target, 'docs/readme.md')).toBeNull();
});

it('limits image reads to four across document switches and discards stale queued/in-flight results', async () => {
  const reads = new ImageReads();
  const pending: (() => void)[] = [];
  let active = 0, maximum = 0, count = 0, oldCurrent = true;
  const snapshot: ImageSnapshot = { mimeType: 'image/png', revision: 'r', dataBase64: '' };
  const read = () => { count++; active++; maximum = Math.max(maximum, active); return new Promise<ImageSnapshot>(resolve => pending.push(() => { active--; resolve(snapshot); })); };
  const old = Array.from({ length: 9 }, () => reads.run(read, () => oldCurrent).catch(() => 'stale'));
  await Promise.resolve();
  expect(count).toBe(4);
  oldCurrent = false;
  const next = reads.run(read, () => true);
  pending.splice(0).forEach(resolve => resolve());
  expect(await Promise.all(old)).toEqual(Array(9).fill('stale'));
  // Completed old reads free capacity for the new document, never queued old jobs.
  await Promise.resolve();
  expect(count).toBe(5); expect(maximum).toBe(4);
  pending.splice(0).forEach(resolve => resolve());
  expect(await next).toEqual(snapshot);
  reads.dispose();
  await expect(reads.run(read, () => true)).rejects.toThrow('workspace changed');
});
