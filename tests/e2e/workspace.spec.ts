import { test, expect, type Page } from '@playwright/test';

const browserIssues = new WeakMap<Page, string[]>();

const editor = (page: Page) => page.locator('.hm-editor .monaco-editor').first();
async function openFile(page: Page, name = 'main.ts') {
  await page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }).click();
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible();
}
async function replaceText(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}
async function fixture(page: Page) { return page.evaluate(() => (window as any).hmTest.fixture); }
async function disk(page: Page, root: string, path: string) {
  return (await page.request.get('/test/file', { params: { root, path } })).json();
}
async function externalWrite(page: Page, root: string, path: string, text: string) {
  await page.request.post('/test/file', { data: { root, path, text } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
test.beforeEach(async ({ page }) => {
  const issues: string[] = [];
  browserIssues.set(page, issues);
  page.on('pageerror', error => issues.push(error.message));
  page.on('console', message => { if (message.type() === 'error') issues.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('treeitem', { name: /main\.ts/ })).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(browserIssues.get(page)).toEqual([]); });

test('real Monaco editing, multiple guides, dirty close choices and external conflicts', async ({ page }) => {
  const { a } = await fixture(page);
  const originalEol = (await disk(page, a, 'main.ts')).eol === 'crlf' ? '\r\n' : '\n';
  await openFile(page);
  await expect(page.locator('.view-ruler')).toHaveCount(2);
  await replaceText(page, '// changed λ\nconst value = 42;\n');
  await expect(page.locator('.hm-tab-state')).toContainText('●');
  await page.getByRole('button', { name: 'Close main.ts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor(page).click(); await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await disk(page, a, 'main.ts')).text).toBe(['// changed λ', 'const value = 42;', ''].join(originalEol));
  await page.getByRole('button', { name: 'Editor settings', exact: true }).click();
  await page.getByLabel('Guide columns').fill('72, 80, 90, 120');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('.view-ruler')).toHaveCount(4);
  await externalWrite(page, a, 'main.ts', '// refreshed from disk\n');
  await expect(editor(page)).toContainText('refreshed from disk');
  await replaceText(page, '// unsaved local\n');
  await externalWrite(page, a, 'main.ts', '// external edit\n');
  await expect(page.getByText('Changed on disk. Your edits are preserved.')).toBeVisible();
  await expect(editor(page)).toContainText('unsaved local');
  await page.getByRole('button', { name: 'Compare versions' }).click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Use disk version' }).click();
  await expect(editor(page)).toContainText('external edit');
  await expect(page.locator('.hm-tab-state')).toHaveText('');
});

test('drafts survive workspace/profile/connection switches and plugin reload', async ({ page }) => {
  await openFile(page);
  await replaceText(page, '// draft only in alpha\n');
  await expect(page.locator('.hm-status > span').first()).toContainText('Ln 2, Col 1');
  await page.getByRole('button', { name: 'Project B' }).click();
  await expect(page.getByText('No file open')).toBeVisible();
  await openFile(page);
  await expect(editor(page)).toContainText('beta');
  await page.getByRole('button', { name: 'Project A' }).click();
  await expect(editor(page)).toContainText('draft only in alpha');
  await expect(page.locator('.hm-status > span').first()).toContainText('Ln 2, Col 1');
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.profile.set('other'));
  await expect(page.getByText('No file open')).toBeVisible();
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.profile.set('default'));
  await expect(editor(page)).toContainText('draft only in alpha');
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.connectionId.set('remote'));
  await expect(page.getByText('No file open')).toBeVisible();
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.connectionId.set('local'));
  await expect(editor(page)).toContainText('draft only in alpha');
  await page.evaluate(() => (window as any).hmTest.reload());
  await expect(editor(page)).toContainText('draft only in alpha');
  await expect(page.locator('.hm-tab-state')).toHaveText('●');
  await expect(page.locator('.hm-status > span').first()).toContainText('Ln 2, Col 1');
});

test('dirty buffer search, ignored files, bookmark movement and rename', async ({ page }) => {
  await openFile(page);
  await replaceText(page, 'const first = 1;\nconst needle = 2;\n');
  await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ControlOrMeta+F2');
  await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('// inserted\n');
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await expect(page.locator('.hm-bookmark')).toContainText('main.ts:3');
  await page.getByRole('button', { name: 'Name bookmark' }).click();
  await page.getByLabel('Bookmark name').fill('Important line');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.hm-bookmark')).toContainText('Important line');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search project').fill('needle');
  await expect(page.locator('.hm-search-result')).toHaveCount(1);
  await expect(page.locator('.hm-search-result')).toContainText('main.ts:3');
  await page.getByText('Files to search', { exact: true }).click();
  await page.getByLabel('Include ignored files').check();
  await expect(page.locator('.hm-search-result')).toHaveCount(2);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('New name').fill('renamed.ts');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('tab', { name: /renamed.ts/ })).toBeVisible();
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await expect(page.locator('.hm-bookmark')).toContainText('renamed.ts:3');
});

async function addScript(page: Page) {
  const { command } = await fixture(page);
  await page.getByRole('button', { name: 'Edit scripts', exact: true }).click();
  await page.getByRole('button', { name: 'Add script' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Application');
  await page.getByLabel('Command', { exact: true }).fill(command);
  await page.getByRole('button', { name: 'Save scripts' }).click();
  await expect(page.getByLabel('Script', { exact: true })).toHaveText('Application');
}

test('shared script editing, save before Play, live output, reconnect and stop', async ({ page }) => {
  await openFile(page);
  await replaceText(page, '// SAVE BEFORE RUN\n');
  await addScript(page);
  await page.getByRole('button', { name: 'Run selected script', exact: true }).click();
  await expect(page.locator('.hm-log')).toContainText('SAVE BEFORE RUN');
  await expect(page.locator('.hm-log')).toContainText('RUN READY');
  await expect(page.locator('.hm-stderr')).toContainText('STDERR READY');
  await expect(page.getByRole('button', { name: 'Run selected script', exact: true })).toBeDisabled();
  const restarted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/runs'));
  await page.getByRole('button', { name: 'Restart selected script', exact: true }).click();
  await restarted;
  await expect(page.locator('.hm-log')).toContainText('RUN READY');
  await page.getByRole('button', { name: 'Project B' }).click();
  await page.getByRole('button', { name: 'Project A' }).click();
  await expect(page.getByRole('button', { name: 'Stop selected script', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop selected script', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run selected script', exact: true })).toBeEnabled();
  const { a } = await fixture(page);
  const config = JSON.parse((await disk(page, a, '.hermes/scripts.json')).text);
  expect(config.scripts[0].name).toBe('Application');
});

test('failed saves and switching during a save cancel Play', async ({ page }) => {
  await openFile(page); await addScript(page);
  await replaceText(page, '// draft\n');
  let starts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/runs')) starts++; });
  await page.route('**/api/plugins/hermes-monaco/file', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fulfill({ json: { error: { code: 'permission', message: 'Fixture save failure', status: 403 } } });
  });
  await page.getByRole('button', { name: 'Run selected script', exact: true }).click();
  await expect(page.locator('.hm-banner[role=alert]')).toContainText('Fixture save failure');
  expect(starts).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/plugins/hermes-monaco/file', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    await gate; await route.continue();
  });
  const saving = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/file'));
  await page.getByRole('button', { name: 'Run selected script', exact: true }).click();
  await saving;
  await page.getByRole('button', { name: 'Project B' }).click();
  release();
  await expect(page.getByText('No file open')).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  expect(starts).toBe(0);
});

test('rapid switches discard stale file reads and recover partially restored drafts', async ({ page }) => {
  await openFile(page); await replaceText(page, '// main recovery\n');
  await openFile(page, 'data.json'); await replaceText(page, '{"recovered":true}');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/plugins/hermes-monaco/file?**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (!held && path === 'data.json') { held = true; await gate; }
    await route.continue();
  });
  await page.evaluate(() => (window as any).hmTest.reload());
  await expect.poll(() => held).toBe(true);
  // Switch while only the first draft has restored, then come back before
  // the delayed response returns. No duplicate Monaco URIs or lost drafts.
  await page.getByRole('button', { name: 'Project B' }).click();
  await expect(page.getByText('No file open')).toBeVisible();
  await page.getByRole('button', { name: 'Project A' }).click();
  await expect(editor(page)).toContainText('recovered');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('tab', { name: /main.ts/ }).click();
  await expect(editor(page)).toContainText('main recovery');
  await expect(page.locator('.hm-banner.hm-error')).toHaveCount(0);
});

test('create/move Unicode files, quick open, and unsupported trash retains the file', async ({ page }) => {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Workspace-relative path').fill('source λ');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByLabel('Workspace-relative path').fill('draft λ.py');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await replaceText(page, 'print("hello")\n');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await page.getByLabel('Workspace-relative path').fill('source λ/draft λ.py');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.hm-breadcrumbs')).toContainText('source λ');
  await editor(page).click(); await page.keyboard.press('ControlOrMeta+p');
  await page.getByLabel('Find file').fill('draft');
  await expect(page.locator('.hm-search-result')).toHaveCount(1);
  await page.locator('.hm-search-result').click();
  await expect(editor(page)).toContainText('hello');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.route('**/api/plugins/hermes-monaco/trash', route => route.fulfill({ json: { error: { code: 'trash_unavailable', message: 'OS trash unavailable in fixture', status: 501 } } }));
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('OS trash unavailable');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const { a } = await fixture(page);
  expect((await disk(page, a, 'source λ/draft λ.py')).text).toContain('hello');
});

test('Open configuration has schema validation and invalid configuration blocks Play', async ({ page }) => {
  await addScript(page);
  await page.getByRole('button', { name: 'Edit scripts', exact: true }).click();
  await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
  await expect(page.getByRole('tab', { name: /scripts.json/ })).toBeVisible();
  await replaceText(page, '{"version":2,"scripts":[]}');
  await expect(page.locator('.squiggly-error,.squiggly-warning')).not.toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.hm-banner.hm-error')).toContainText('version: 1');
  await expect(page.getByRole('button', { name: 'Run selected script', exact: true })).toBeDisabled();
});

test('JSON worker, CSP, themes, narrow layout, split and reload cleanup', async ({ page }) => {
  await openFile(page, 'data.json');
  await expect(page.locator('.hm-editor .monaco-editor')).toHaveCSS('background-color', 'rgb(23, 25, 30)');
  await replaceText(page, '{ "broken": }');
  await expect(page.locator('.squiggly-error')).not.toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).hmTest.workers())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await expect(page.locator('.hm-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.hm-editor .monaco-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.getByRole('button', { name: 'Split with chat' }).click();
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.locator('.hm-workbench')).toHaveCount(1);
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(page.locator('.hm-workbench')).toHaveCount(1);
  await page.setViewportSize({ width: 600, height: 850 });
  await expect(page.locator('.hm-sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.hm-sidebar')).toBeVisible();
  await page.screenshot({ path: '.build/monaco-narrow.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await page.screenshot({ path: '.build/monaco-workspace.png' });
  await page.evaluate(() => (window as any).hmTest.unload());
  await expect(page.locator('.hm-workbench')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).hmTest.workers())).toBe(0);
  expect(await page.locator('style[data-hermes-monaco]').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).hmTest.sdk.host.state.cwd.count())).toBe(0);
  expect(await page.evaluate(() => (window as any).hmTest.intervals())).toBe(0);
});
