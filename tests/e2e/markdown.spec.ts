import { test, expect, type Page } from '@playwright/test';

const issues = new WeakMap<Page, string[]>();
const source = (page: Page) => page.locator('.hm-editor .monaco-editor').first();
const preview = (page: Page) => page.getByRole('region', { name: 'Markdown preview' });
const mode = (page: Page, name: string) => page.getByRole('group', { name: 'Markdown view' }).getByRole('button', { name, exact: true });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="teal"/></svg>';
const longDocument = '# Project guide\n\n' + Array.from({ length: 65 }, (_, i) => `## Section ${i}\n\nParagraph ${i}: a useful description of this project.\n\n`).join('');

async function write(page: Page, path: string, text: string, project = 'a') {
  const root = await page.evaluate(project => (window as any).hmTest.fixture[project], project);
  expect((await page.request.post('/test/file', { data: { root, path, text } })).ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function open(page: Page, name = 'README.md') {
  await page.getByRole('treeitem', { name: new RegExp(name.replaceAll('.', '\\.')) }).click();
  await expect(page.getByRole('tab', { name: new RegExp(name.replaceAll('.', '\\.')) })).toBeVisible();
}
async function replace(page: Page, text: string) {
  await source(page).click(); await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); await page.keyboard.insertText(text);
}
async function scrollPreview(page: Page, top: number) {
  await preview(page).dispatchEvent('wheel'); // stop initial scroll restoration
  await preview(page).evaluate((element, top) => { element.scrollTop = top; }, top);
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(top);
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; issues.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await expect(page.getByRole('treeitem', { name: /main\.ts/ })).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(issues.get(page)).toEqual([]); });

test('Markdown defaults to Split, renders GFM and sanitizes document HTML and duplicate Unicode anchors', async ({ page }) => {
  await write(page, 'README.MARKDOWN', `# Café λ\n\n# Café λ\n\n# Café λ-1\n\n- [x] Done\n- [ ] Later\n\n| Name | Value |\n|---|---|\n| test | **bold** |\n\n\`\`\`js\nconst x = '<tag>';\n\`\`\`\n\n<details><summary>More</summary><p>Document details</p></details>\n\n<script>window.mdUnsafe=true</script><img src="javascript:alert(1)" onerror="window.mdUnsafe=true" alt="Blocked image"><a href="javascript:alert(1)">Bad link</a><iframe src="/evil"></iframe><svg onload="window.mdUnsafe=true"></svg><p style="position:fixed" id="host-route">Safe text</p>`);
  await open(page, 'README.MARKDOWN');
  await expect(mode(page, 'Split')).toHaveAttribute('aria-pressed', 'true');
  await expect(source(page)).toBeVisible(); await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator('h1')).toHaveCount(3);
  expect(await preview(page).locator('h1').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.markdownAnchor))).toEqual(['café-λ', 'café-λ-1', 'café-λ-1-1']);
  await expect(preview(page).locator('table td strong')).toHaveText('bold');
  await expect(preview(page).locator('pre code')).toContainText("const x = '<tag>';");
  await expect(preview(page).locator('input')).toHaveCount(2);
  for (const checkbox of await preview(page).locator('input').all()) await expect(checkbox).toBeDisabled();
  await preview(page).getByText('More', { exact: true }).click();
  await expect(preview(page).locator('details')).toHaveAttribute('open', '');
  await expect(preview(page).locator('script,iframe,svg,[style],[onerror],#host-route')).toHaveCount(0);
  await expect(preview(page).getByText('Bad link')).not.toHaveAttribute('href');
  await expect(preview(page).getByText('Blocked image')).toHaveClass('hm-image-unavailable');
  expect(await page.evaluate(() => (window as any).mdUnsafe)).toBeUndefined();
  await mode(page, 'Preview').click(); await mode(page, 'Edit').click(); await mode(page, 'Split').click();
  await expect(page.locator('.hm-tab.is-preview')).toHaveCount(1);
  await expect(page.locator('.hm-tab-state')).toHaveText('');
  await open(page, 'main.ts');
  await expect(page.getByRole('group', { name: 'Markdown view' })).toHaveCount(0);
});

test('unsaved rendering, hidden preview, cursor, undo, independent scroll and split resizing', async ({ page }) => {
  await write(page, 'README.md', longDocument); await open(page);
  const separator = page.getByRole('separator', { name: 'Resize Markdown panes' });
  await expect(separator).toHaveAttribute('aria-valuenow', '50');
  await source(page).click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.hm-status')).toContainText('Ln 1, Col 2');
  await page.keyboard.press('#');
  await expect(preview(page).locator('h2').first()).toHaveText('Project guide');
  await scrollPreview(page, 500);
  await mode(page, 'Preview').click(); await expect(source(page)).toBeHidden();
  await mode(page, 'Edit').click(); await expect(preview(page)).toHaveCount(0);
  await expect(page.locator('.hm-status')).toContainText('Ln 1, Col 3');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.hm-tab-state')).toHaveText('');
  await mode(page, 'Split').click();
  await expect(preview(page).locator('h1')).toHaveText('Project guide');
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(500);
  await source(page).click(); await page.keyboard.press('ControlOrMeta+End');
  const cursor = await page.locator('.hm-status span').first().textContent();
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(500);
  await mode(page, 'Preview').click(); await mode(page, 'Split').click();
  await expect(page.locator('.hm-status span').first()).toHaveText(cursor!);
  await separator.focus(); await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '55');
  const bounds = await page.locator('.hm-editor-stage').boundingBox(); const handle = await separator.boundingBox();
  await page.mouse.move(handle!.x + 2, handle!.y + 50); await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.65, handle!.y + 50); await page.mouse.up();
  await expect(separator).toHaveAttribute('aria-valuenow', '65');
  await page.setViewportSize({ width: 700, height: 950 });
  await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
  await separator.focus(); await page.keyboard.press('ArrowUp');
  await expect(separator).toHaveAttribute('aria-valuenow', '60');
  const sourceBounds = await page.locator('.hm-source-pane').boundingBox(), previewBounds = await preview(page).boundingBox();
  expect(previewBounds!.y).toBeGreaterThan(sourceBounds!.y + sourceBounds!.height - 1);
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(preview(page)).toHaveCSS('color', 'rgb(34, 38, 49)');
  await expect(preview(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: '.build/markdown-narrow.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await page.screenshot({ path: '.build/markdown-split.png' });
});

test('relative files, root links, heading navigation, external SDK links and safe repository images', async ({ page }) => {
  await write(page, 'docs/guide λ.md', '# Guide\n\n[Root](/README.md#target)\n\n[Local](../main.ts)\n\n![Logo](../logo.svg)');
  await write(page, 'logo.svg', svg);
  await write(page, 'README.md', '# Welcome\n\n[Guide](docs/guide%20%CE%BB.md)\n\n[Jump](#target)\n\n[External](https://example.com/docs)\n\n![Missing](missing.png)\n\n' + longDocument + '\n## Target\n\nReached target');
  await open(page); const url = page.url();
  await preview(page).getByRole('link', { name: 'External', exact: true }).click();
  expect(await page.evaluate(() => (window as any).hmTest.sdk.externalLinks)).toEqual(['https://example.com/docs']);
  await expect(preview(page).getByText('Missing', { exact: true })).toHaveClass('hm-image-unavailable');
  await preview(page).getByRole('link', { name: 'Jump', exact: true }).click();
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  expect(page.url()).toBe(url);
  await scrollPreview(page, 0);
  await preview(page).getByRole('link', { name: 'Guide', exact: true }).click();
  await expect(page.locator('.hm-tab.is-active')).not.toHaveClass(/is-preview/);
  const image = preview(page).getByRole('img', { name: 'Logo' });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(80);
  await expect(preview(page).locator('svg')).toHaveCount(0);
  await preview(page).getByRole('link', { name: 'Root', exact: true }).click();
  await expect(page.getByRole('tab', { name: /README.md/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.hm-tab.is-preview')).toHaveCount(0);
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  expect(page.url()).toBe(url);
});

test('Markdown view metadata survives workspace, profile, connection, reload and file moves', async ({ page }) => {
  await write(page, 'README.md', longDocument); await write(page, 'README.md', '# Project B', 'b'); await open(page);
  await scrollPreview(page, 620);
  await page.getByRole('separator', { name: 'Resize Markdown panes' }).focus(); await page.keyboard.press('ArrowLeft');
  await mode(page, 'Preview').click();
  await page.getByRole('button', { name: 'Project B', exact: true }).click(); await open(page);
  await expect(mode(page, 'Split')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Project A', exact: true }).click();
  await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(620);
  for (const key of ['profile', 'connectionId']) {
    await page.evaluate(key => (window as any).hmTest.sdk.host.state[key].set('other'), key);
    await expect(page.getByText('No file open')).toBeVisible(); await open(page);
    await expect(mode(page, 'Split')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(key => (window as any).hmTest.sdk.host.state[key].set(key === 'profile' ? 'default' : 'local'), key);
    await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  }
  await page.evaluate(() => (window as any).hmTest.reload());
  await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(620);
  await page.getByRole('treeitem', { name: /README.md/ }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByLabel('New name').fill('GUIDE.MD');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('tab', { name: /GUIDE.MD/ })).toBeVisible();
  await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(620);
  await mode(page, 'Split').click();
  await expect(page.getByRole('separator', { name: 'Resize Markdown panes' })).toHaveAttribute('aria-valuenow', '45');
  await expect(page.locator('.hm-tab.is-preview')).toHaveCount(1);
});

test('external images omit referrers, unsafe URLs stay inert, and external links have a safe fallback', async ({ page }) => {
  const requests: string[] = [];
  await page.route('https://images.example.test/icon.svg', async route => {
    expect(route.request().headers()['referer']).toBeUndefined(); requests.push(route.request().url());
    await route.fulfill({ contentType: 'image/svg+xml', body: svg });
  });
  await write(page, 'README.md', '![External](https://images.example.test/icon.svg)\n\n![Traversal](../../private.png)\n\n<img alt="Inline SVG" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">\n\n[Fallback](https://example.com/help)');
  await open(page);
  const image = preview(page).getByRole('img', { name: 'External' });
  await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(80);
  expect(requests).toHaveLength(1);
  await expect(preview(page).locator('.hm-image-unavailable')).toHaveCount(2);
  await page.evaluate(() => {
    (window as any).hmTest.sdk.ctx.os.openExternal = async () => false;
    window.open = (...args: any[]) => { (window as any).openedLink = args; return null; };
  });
  await preview(page).getByRole('link', { name: 'Fallback' }).click();
  expect(await page.evaluate(() => (window as any).openedLink)).toEqual(['https://example.com/help', '_blank', 'noopener,noreferrer']);
});

test('clean external edits refresh Markdown; dirty drafts and conflicts survive preview and reload', async ({ page }) => {
  await write(page, 'README.md', '# First'); await open(page); await mode(page, 'Preview').click();
  await write(page, 'README.md', '# External update');
  await expect(preview(page).locator('h1')).toHaveText('External update');
  await mode(page, 'Edit').click(); await replace(page, '# Recoverable draft');
  await mode(page, 'Preview').click();
  await expect(preview(page).locator('h1')).toHaveText('Recoverable draft');
  await page.evaluate(() => (window as any).hmTest.reload());
  await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  await expect(preview(page).locator('h1')).toHaveText('Recoverable draft');
  await write(page, 'README.md', '# Conflicting disk');
  await expect(page.getByRole('button', { name: 'Compare versions' })).toBeVisible();
  await expect(preview(page).locator('h1')).toHaveText('Recoverable draft');
  await page.getByRole('button', { name: 'Compare versions' }).click();
  await page.getByRole('button', { name: 'Use disk version', exact: true }).click();
  await expect(preview(page).locator('h1')).toHaveText('Conflicting disk');
  await mode(page, 'Split').click(); await replace(page, '# Saved from preview');
  await mode(page, 'Preview').click(); await preview(page).focus(); await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.hm-tab-state')).toHaveText('');
  const root = await page.evaluate(() => (window as any).hmTest.fixture.a);
  expect((await (await page.request.get('/test/file', { params: { root, path: 'README.md' } })).json()).text).toBe('# Saved from preview');
});

test('search and bookmarks reveal source; preview keeps Open File, save and F5 behavior', async ({ page }) => {
  await write(page, 'README.md', '# Project\n\nneedle\n'); await open(page);
  await source(page).click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ControlOrMeta+F2');
  await mode(page, 'Preview').click(); await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await page.locator('.hm-bookmark').getByRole('button').first().click();
  await expect(mode(page, 'Split')).toHaveAttribute('aria-pressed', 'true');
  await mode(page, 'Preview').click(); await preview(page).focus(); await page.keyboard.press('ControlOrMeta+Shift+f');
  await page.getByLabel('Search project').fill('needle'); await page.locator('.hm-search-result').filter({ hasText: 'README.md' }).click();
  await expect(mode(page, 'Split')).toHaveAttribute('aria-pressed', 'true');
  await mode(page, 'Preview').click(); await preview(page).focus(); await page.keyboard.press('ControlOrMeta+Shift+p');
  await expect(page.getByRole('textbox', { name: 'Find file', exact: true })).toBeFocused();
  await mode(page, 'Split').click(); await replace(page, '# Unsaved for run\n');
  const { command } = await page.evaluate(() => (window as any).hmTest.fixture);
  await page.getByRole('button', { name: 'Edit scripts', exact: true }).click(); await page.getByRole('button', { name: 'Add script' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Preview run'); await page.getByLabel('Command', { exact: true }).fill(command);
  await page.getByRole('button', { name: 'Save scripts' }).click();
  await mode(page, 'Preview').click(); await preview(page).focus(); await page.keyboard.press('F5');
  await expect(page.getByRole('button', { name: 'Stop selected script', exact: true })).toBeVisible();
  await expect(page.locator('.hm-tab-state')).toHaveText('');
  await expect(page.locator('.hm-output')).toContainText('hello');
  await page.getByRole('button', { name: 'Stop selected script', exact: true }).click();
});

test('images load lazily, cap outstanding reads at four, discard old results and revoke URLs', async ({ page }) => {
  await page.evaluate(() => {
    const urls = new Set<string>(); const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = object => { const url = create(object); if (object instanceof Blob && object.type.startsWith('image/')) urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
    (window as any).imageUrls = urls;
  });
  for (let index = 0; index < 7; index++) await write(page, `image${index}.svg`, svg);
  await write(page, 'README.md', Array.from({ length: 7 }, (_, index) => `![${index}](image${index}.svg)`).join(' ') + '\n\n' + longDocument + '\n![Lazy](lazy.svg)');
  await write(page, 'other.md', '![New](image6.svg)');
  const waiting: (() => Promise<void>)[] = []; const paths: string[] = [];
  await page.route('**/preview-image?*', async route => {
    paths.push(new URL(route.request().url()).searchParams.get('path')!);
    await new Promise<void>(resolve => waiting.push(async () => { await route.fulfill({ response: await route.fetch() }); resolve(); }));
  });
  await open(page); await expect.poll(() => waiting.length).toBe(4);
  await open(page, 'other.md');
  await expect(preview(page).getByRole('img', { name: 'New' })).toBeVisible();
  expect(waiting.length).toBe(4);
  await Promise.all(waiting.splice(0).map(release => release()));
  await expect.poll(() => waiting.length).toBe(1);
  await waiting.shift()!();
  await expect(preview(page).getByRole('img', { name: 'New' })).toHaveAttribute('src', /^blob:/);
  expect(paths).toHaveLength(5); expect(paths).not.toContain('lazy.svg');
  await expect.poll(() => page.evaluate(() => (window as any).imageUrls.size)).toBe(1);
  await mode(page, 'Edit').click();
  await expect.poll(() => page.evaluate(() => (window as any).imageUrls.size)).toBe(0);
  await page.evaluate(() => (window as any).hmTest.unload());
  await expect(page.locator('.hm-workbench')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).hmTest.workers())).toBe(0);
  expect(await page.evaluate(() => (window as any).hmTest.intervals())).toBe(0);
});
