# Third-party notices

## Echo

The `parseRulers` helper in `src/editorSettings.ts` was adapted from Echo's `web/src/code/columnGuides.ts`. Preview-tab behavior in `src/controller.ts` was adapted from `web/src/code/tabState.ts`: reuse a clean preview, keep it on double-click, and keep edited files. Markdown rendering, DOM patching, and the subscription lifecycle in `src/markdown.ts` and `src/MarkdownPreview.tsx` adapt `web/src/code/markdownPreview.ts`; its document styling informed the Hermes-themed rules in `src/styles.css`. Echo's editor was also consulted for behavioral inspiration.

MIT License

Copyright (c) 2026 Brent Farris; John 4:13-14

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Monaco Editor

Monaco Editor 0.56.0, Copyright (c) Microsoft Corporation, is licensed under MIT.
Its full license is included at `desktop/LICENSE.monaco-editor.txt`. The
generated bundle retains esbuild's extracted inline legal comments for
embedded dependencies. React is supplied by Hermes and is not bundled.

## Marked and DOMPurify

Marked 14.0.0 is licensed under MIT, Copyright (c) 2018+, MarkedJS, and
Copyright (c) 2011-2018, Christopher Jeffrey. Its full license and upstream
notices are included at `desktop/LICENSE.marked.txt`.

DOMPurify 3.4.17, Copyright (c) Cure53 and other contributors, is available
under Apache-2.0 or MPL-2.0. This distribution uses the Apache-2.0 option;
the full license is included at `desktop/LICENSE.dompurify.txt`. Its upstream
copyright/license banner is retained in the bundle.

Both are direct, exactly pinned dependencies shared with Monaco's dependency
graph, with no runtime CDN or separate Markdown service.
