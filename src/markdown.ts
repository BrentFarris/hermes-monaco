// Adapted from Echo's web/src/code/markdownPreview.ts (MIT).
// Copyright (c) 2026 Brent Farris; John 4:13-14. See THIRD_PARTY_NOTICES.md.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { MarkdownViewState } from './types';

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);
export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
export const markdownState = (state?: Partial<MarkdownViewState>): MarkdownViewState => ({
  mode: state?.mode === 'edit' || state?.mode === 'preview' ? state.mode : 'split',
  splitRatio: Number.isFinite(state?.splitRatio) ? Math.max(0.2, Math.min(0.8, state!.splitRatio!)) : 0.5,
  previewScrollTop: Number.isFinite(state?.previewScrollTop) ? Math.max(0, state!.previewScrollTop!) : 0,
});

export type MarkdownTarget = { kind: 'external'; url: string } | { kind: 'anchor'; fragment: string } | { kind: 'file'; path: string; fragment: string };

export function markdownTarget(value: string, source: string): MarkdownTarget | null {
  const href = value.trim();
  if (!href || /[\u0000-\u001f\u007f\\]/.test(href)) return null;
  if (/^https?:\/\//i.test(href)) {
    try { return { kind: 'external', url: new URL(href).href }; } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const hash = href.indexOf('#');
  let fragment: string, path: string;
  try {
    fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
    path = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?')[0]);
  } catch { return null; }
  if (/[\u0000-\u001f\u007f\\:]/.test(path) || path.startsWith('//')) return null;
  if (!path) return hash >= 0 ? { kind: 'anchor', fragment } : null;
  const parts = path.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  if (!parts.length) return null;
  path = parts.join('/');
  return path === source && hash >= 0 ? { kind: 'anchor', fragment } : { kind: 'file', path, fragment };
}

export function renderMarkdown(text: string, path: string): DocumentFragment {
  const html = marked.parse(text.replaceAll('\r\n', '\n'), { async: false, gfm: true, breaks: false });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['a', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 's', 'blockquote', 'pre', 'code',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'img', 'details', 'summary', 'div', 'span', 'kbd', 'samp', 'sub', 'sup', 'dl', 'dt', 'dd', 'abbr', 'input'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan', 'start', 'reversed', 'type', 'checked', 'disabled', 'open', 'lang'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const slugs = new Set<string>();
  for (const heading of fragment.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const base = (heading.textContent || '').normalize('NFC').trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
    let slug = base;
    for (let index = 1; slugs.has(slug); index++) slug = `${base}-${index}`;
    slugs.add(slug);
    heading.id = 'hm-markdown-heading-' + slug; heading.dataset.markdownAnchor = slug;
  }
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>('a')) {
    const target = markdownTarget(anchor.getAttribute('href') || '', path);
    anchor.removeAttribute('href');
    if (target?.kind === 'external') {
      anchor.href = target.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      anchor.dataset.markdownExternal = target.url;
    } else if (target) {
      anchor.href = '#' + encodeURIComponent(target.fragment);
      anchor.dataset.markdownFragment = target.fragment;
      if (target.kind === 'file') anchor.dataset.markdownPath = target.path;
    }
  }
  for (const image of fragment.querySelectorAll<HTMLImageElement>('img')) {
    const src = image.getAttribute('src') || '';
    const target = markdownTarget(src, path);
    image.removeAttribute('src');
    if (target?.kind === 'external') image.src = target.url;
    else if (target?.kind === 'file' && isImagePath(target.path)) image.dataset.markdownImage = target.path;
    else if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(src)) image.src = src;
    else { image.replaceWith(imagePlaceholder(image)); continue; }
    image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  }
  for (const input of fragment.querySelectorAll<HTMLInputElement>('input')) {
    if (input.type === 'checkbox') input.disabled = true;
    else input.remove();
  }
  return fragment;
}

export function imagePlaceholder(image: HTMLImageElement): HTMLElement {
  const placeholder = document.createElement('span');
  placeholder.className = 'hm-image-unavailable';
  placeholder.textContent = image.alt || 'Image unavailable';
  placeholder.title = 'Image unavailable';
  return placeholder;
}

// Preserve unchanged images, expanded details, text selection, and scroll while
// typing. Local image src is owned by the image loader, not the Markdown DOM.
export function patchMarkdown(target: Node, source: Node): void {
  let old = target.firstChild;
  for (const next of [...source.childNodes]) {
    if (!old) { target.appendChild(next); continue; }
    const following = old.nextSibling;
    if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName) target.replaceChild(next, old);
    else if (old instanceof Element && next instanceof Element) {
      const sameImage = old instanceof HTMLImageElement && !!old.dataset.markdownImage && old.dataset.markdownImage === (next as HTMLElement).dataset.markdownImage;
      for (const attribute of [...old.attributes]) {
        if (old instanceof HTMLDetailsElement && attribute.name === 'open' || sameImage && attribute.name === 'src') continue;
        if (!next.hasAttribute(attribute.name)) old.removeAttribute(attribute.name);
      }
      for (const attribute of [...next.attributes]) if (old.getAttribute(attribute.name) !== attribute.value) old.setAttribute(attribute.name, attribute.value);
      patchMarkdown(old, next);
    } else if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    old = following;
  }
  while (old) { const following = old.nextSibling; target.removeChild(old); old = following; }
}
