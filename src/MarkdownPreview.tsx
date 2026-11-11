// Document rendering and incremental patching adapted from Echo (MIT).
// See THIRD_PARTY_NOTICES.md for attribution.
import { useEffect, useRef } from 'react';
import type { Controller, Tab } from './controller';
import { imagePlaceholder, patchMarkdown, renderMarkdown } from './markdown';

type ImageResource = { images: Set<HTMLImageElement>; url?: string; failed?: boolean; started?: boolean };
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

class DocumentPreview {
  private content = document.createElement('article');
  private resources = new Map<string, ImageResource>();
  private images = new Map<HTMLImageElement, string>();
  private observer: IntersectionObserver;
  private events = new AbortController();
  private subscription;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private restoring = true;
  private restoreTop: number;

  constructor(private host: HTMLDivElement, private controller: Controller, private tab: Tab) {
    this.restoreTop = tab.markdown!.previewScrollTop;
    this.content.className = 'hm-markdown-content';
    host.replaceChildren(this.content);
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        this.observer.unobserve(entry.target);
        const path = this.images.get(entry.target as HTMLImageElement);
        if (path) this.loadImage(path);
      }
    }, { root: host, rootMargin: '200px' });
    const signal = this.events.signal;
    host.addEventListener('click', this.link, { signal });
    host.addEventListener('auxclick', this.link, { signal });
    host.addEventListener('error', event => {
      if (event.target instanceof HTMLImageElement) { event.target.replaceWith(imagePlaceholder(event.target)); this.syncImages(); }
    }, { capture: true, signal });
    host.addEventListener('load', () => this.restoreScroll(), { capture: true, signal });
    for (const event of ['wheel', 'pointerdown', 'keydown']) host.addEventListener(event, () => { this.restoring = false; }, { signal });
    host.addEventListener('scroll', () => {
      if (this.restoring) return;
      tab.markdown!.previewScrollTop = host.scrollTop;
      controller.markdownChanged(tab);
    }, { signal });
    this.subscription = tab.model.onDidChangeContent(() => {
      if (this.timer !== undefined) return;
      this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 50);
    });
    this.render();
  }

  private restoreScroll() { if (this.restoring) this.host.scrollTop = this.restoreTop; }

  private render() {
    if (this.disposed || this.tab.model.isDisposed()) return;
    try {
      const top = this.host.scrollTop;
      patchMarkdown(this.content, renderMarkdown(this.tab.model.getValue(), this.tab.path));
      this.syncImages();
      this.host.scrollTop = top;
      this.restoreScroll();
    } catch {
      const error = document.createElement('p');
      error.className = 'hm-error'; error.setAttribute('role', 'status');
      error.textContent = 'The Markdown preview could not be rendered. You can continue in Edit.';
      this.content.replaceChildren(error);
      this.syncImages();
    }
  }

  private syncImages() {
    for (const [image, path] of this.images) {
      if (this.content.contains(image) && image.dataset.markdownImage === path) continue;
      this.observer.unobserve(image); this.images.delete(image);
      this.resources.get(path)?.images.delete(image);
    }
    for (const image of this.content.querySelectorAll<HTMLImageElement>('img[data-markdown-image]')) {
      if (this.images.has(image)) continue;
      const path = image.dataset.markdownImage!;
      let resource = this.resources.get(path);
      if (!resource) { resource = { images: new Set() }; this.resources.set(path, resource); }
      this.images.set(image, path); resource.images.add(image);
      if (resource.url) image.src = resource.url;
      else if (resource.failed) image.replaceWith(imagePlaceholder(image));
      else this.observer.observe(image);
    }
    for (const [path, resource] of this.resources) if (!resource.images.size) {
      if (resource.url) URL.revokeObjectURL(resource.url);
      this.resources.delete(path);
    }
  }

  private loadImage(path: string) {
    const resource = this.resources.get(path);
    if (!resource || resource.started) return;
    resource.started = true;
    const current = () => !this.disposed && this.resources.get(path) === resource && [...resource.images].some(image => this.content.contains(image) && image.dataset.markdownImage === path);
    void this.controller.readPreviewImage(this.tab, path, current).then(snapshot => {
      if (!current()) return;
      if (!imageTypes.has(snapshot.mimeType) || snapshot.dataBase64.length > 5_592_408) throw new Error('Unsupported image');
      const bytes = Uint8Array.from(atob(snapshot.dataBase64), character => character.charCodeAt(0));
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('Image too large');
      resource.url = URL.createObjectURL(new Blob([bytes], { type: snapshot.mimeType }));
      resource.images.forEach(image => { if (this.content.contains(image) && image.dataset.markdownImage === path) image.src = resource.url!; });
    }).catch(() => {
      if (!current()) return;
      resource.failed = true;
      resource.images.forEach(image => { if (this.content.contains(image) && image.dataset.markdownImage === path) image.replaceWith(imagePlaceholder(image)); });
    });
  }

  private link = (event: MouseEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null;
    if (!anchor || !this.content.contains(anchor)) return;
    // Never let document links change the host router, even if sanitization
    // removed an unsupported destination.
    event.preventDefault(); event.stopPropagation();
    if (anchor.dataset.markdownExternal) void this.controller.openMarkdownExternal(anchor.dataset.markdownExternal);
    else if (anchor.dataset.markdownPath) void this.controller.perform(() => this.controller.openMarkdownLink(this.tab, anchor.dataset.markdownPath!, anchor.dataset.markdownFragment || ''));
    else if (anchor.dataset.markdownFragment !== undefined) this.scrollTo(anchor.dataset.markdownFragment);
  };

  scrollTo(fragment: string) {
    const heading = [...this.content.querySelectorAll<HTMLElement>('[data-markdown-anchor]')].find(item => item.dataset.markdownAnchor === fragment);
    if (!heading && fragment) return;
    this.restoring = false;
    this.host.scrollTop = heading ? this.host.scrollTop + heading.getBoundingClientRect().top - this.host.getBoundingClientRect().top - 20 : 0;
    this.tab.markdown!.previewScrollTop = this.host.scrollTop;
    this.controller.markdownChanged(this.tab);
    this.host.focus({ preventScroll: true });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer); this.subscription.dispose(); this.events.abort(); this.observer.disconnect();
    for (const resource of this.resources.values()) if (resource.url) URL.revokeObjectURL(resource.url);
    this.resources.clear(); this.images.clear(); this.host.replaceChildren();
  }
}

export function MarkdownPreview({ controller, tab }: { controller: Controller; tab: Tab }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<DocumentPreview | null>(null);
  useEffect(() => {
    view.current = new DocumentPreview(host.current!, controller, tab);
    return () => { view.current?.dispose(); view.current = null; };
  }, [controller, tab]);
  useEffect(() => { if (tab.markdown?.mode === 'preview') host.current?.focus({ preventScroll: true }); }, [tab, tab.markdown?.mode]);
  useEffect(() => {
    const target = controller.markdownNavigation;
    if (target?.tab === tab) view.current?.scrollTo(target.fragment);
  }, [controller.markdownNavigation, tab]);
  return <div className="hm-markdown-preview" ref={host} tabIndex={0} role="region" aria-label="Markdown preview" />;
}
