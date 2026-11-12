import { test, expect, type Page } from '@playwright/test';

const issues = new WeakMap<Page, string[]>();
const editor = (page: Page) => page.locator('.hm-editor .monaco-editor').first();
const roots = (page: Page) => page.locator('.hm-root-group');
const root = (page: Page, label: string) => roots(page).filter({ has: page.locator('button.hm-root').filter({ hasText: label }) });
const mode = (page: Page, name: string) => page.getByRole('group', { name: 'Markdown view' }).getByRole('button', { name, exact: true });
async function fixture(page: Page) { return page.evaluate(() => (window as any).hmTest.fixture); }
async function write(page: Page, base: string, path: string, text: string) {
  expect((await page.request.post('/test/file', { data: { root: base, path, text } })).ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function disk(page: Page, base: string, path: string) { return (await (await page.request.get('/test/file', { params: { root: base, path } })).json()).text as string; }
async function project(page: Page, folders?: { path: string; label?: string; is_primary?: boolean }[]) {
  const { a, b } = await fixture(page);
  await page.evaluate(folders => (window as any).hmTest.sdk.setProjects([{ id: 'p_combined', name: 'Combined project', folders }]), folders || [{ path: a, label: 'Server', is_primary: true }, { path: b, label: 'Client' }]);
  await expect(page.locator('.hm-workspace-label')).toContainText('Combined project');
  await expect(roots(page)).toHaveCount(folders?.length || 2);
}
async function open(page: Page, folder: string, file = 'main.ts', keep = false) {
  const item = root(page, folder).getByRole('treeitem', { name: new RegExp(file.replaceAll('.', '\\.')) });
  if (keep) await item.dblclick(); else await item.click();
  await expect(page.locator('.hm-tab.is-active')).toContainText(file);
}
async function replace(page: Page, text: string) {
  await editor(page).click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace'); await page.keyboard.insertText(text);
}
async function bookmark(page: Page) { await editor(page).click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ControlOrMeta+F2'); }

test.beforeEach(async ({ page }) => {
  const errors: string[] = []; issues.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await expect(page.getByRole('treeitem', { name: /main\.ts/ })).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(issues.get(page)).toEqual([]); });

test('all project roots share tabs while duplicate paths save, bookmark, search and rename independently', async ({ page }) => {
  const { a, b } = await fixture(page); await project(page);
  await open(page, 'Server'); await open(page, 'Client');
  await expect(page.getByRole('tab')).toHaveCount(1); await expect(page.locator('.hm-tab.is-preview')).toContainText('Client');
  await page.getByRole('tab').dblclick(); await open(page, 'Server', 'main.ts', true);
  await replace(page, '// server unique needle\n'); await bookmark(page);
  await open(page, 'Client'); await replace(page, '// client unique needle\n'); await bookmark(page);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.hm-tab.is-active .hm-tab-state')).toHaveText('');
  expect(await disk(page, a, 'main.ts')).not.toContain('server unique'); expect(await disk(page, b, 'main.ts')).toContain('client unique');
  await page.keyboard.press('ControlOrMeta+Shift+f'); await page.getByLabel('Search project').fill('unique needle');
  await expect(page.locator('.hm-search-result')).toHaveCount(2);
  await page.locator('.hm-search-result').filter({ hasText: 'Server/main.ts' }).click();
  await expect(page.locator('.hm-tab.is-active')).toContainText('Server'); await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.hm-tab.is-active .hm-tab-state')).toHaveText('');
  expect(await disk(page, a, 'main.ts')).toContain('server unique');
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await expect(page.locator('.hm-bookmark')).toHaveCount(2);
  await page.locator('.hm-bookmark').filter({ hasText: 'Client/main.ts' }).getByRole('button').first().click();
  await expect(page.locator('.hm-tab.is-active')).toContainText('Client');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByLabel('New name').fill('client.ts');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await disk(page, b, 'client.ts')).toContain('client unique'); expect(await disk(page, a, 'main.ts')).toContain('server unique');
  await editor(page).click(); await page.keyboard.press('ControlOrMeta+Shift+p'); await page.getByLabel('Find file').fill('main.ts');
  await expect(page.locator('.hm-search-result')).toHaveCount(1); await expect(page.locator('.hm-search-result')).toContainText('Server/main.ts');
  await page.screenshot({ path: '.build/projects-tabs.png' });
});

test('Markdown links and images stay in their own root, and creation follows the selected root', async ({ page }) => {
  const { a, b } = await fixture(page);
  for (const [base, label, width] of [[a, 'Server', 30], [b, 'Client', 60]] as const) {
    await write(page, base, 'README.md', `# ${label}\n\n[Source](/main.ts)\n\n![Icon](icon.svg)`);
    await write(page, base, 'icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20"></svg>`);
  }
  await project(page); await open(page, 'Server', 'README.md', true);
  await open(page, 'Client', 'README.md', true);
  const preview = page.getByRole('region', { name: 'Markdown preview' });
  await expect(preview.getByRole('heading')).toHaveText('Client');
  await expect.poll(() => preview.getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(60);
  await preview.getByRole('link', { name: 'Source' }).click();
  await expect(page.locator('.hm-tab.is-active')).toContainText('Client');
  await page.getByRole('tab', { name: /README.md.*Server/ }).click();
  await expect(preview.getByRole('heading')).toHaveText('Server');
  await expect.poll(() => preview.getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(30);
  await root(page, 'Client').locator('button.hm-root').click();
  await page.getByRole('button', { name: 'Edit scripts', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Script folder').locator('option:checked')).toHaveText('Server');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByLabel('Workspace-relative path').fill('new λ.txt'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await disk(page, b, 'new λ.txt')).toBe('');
  await expect(page.locator('.hm-tab.is-active')).toContainText('Client');
});

test('folder edits preserve undo and view state; removed dirty roots recover after reload and reattachment', async ({ page }) => {
  const { a, b } = await fixture(page);
  await write(page, b, 'README.md', '# Client guide\n'); await project(page);
  await open(page, 'Client', 'main.ts', true);
  await open(page, 'Client', 'README.md', true);
  await editor(page).click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('#');
  await page.getByRole('separator', { name: 'Resize Markdown panes' }).focus(); await page.keyboard.press('ArrowRight');
  await mode(page, 'Preview').click();
  await project(page, [{ path: b, label: 'Client' }, { path: a, label: 'Server', is_primary: true }]);
  await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  await mode(page, 'Split').click(); await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.hm-tab.is-active .hm-tab-state')).toHaveText('');
  await expect(page.getByRole('separator', { name: 'Resize Markdown panes' })).toHaveAttribute('aria-valuenow', '55');
  await replace(page, '# Detached draft'); await mode(page, 'Preview').click();
  await project(page, [{ path: a, label: 'Server', is_primary: true }]);
  await expect(page.getByRole('tab')).toHaveCount(1); // Clean tabs from the removed root close.
  await expect(page.locator('.hm-conflict')).toContainText('Folder removed');
  await expect(page.getByRole('region', { name: 'Markdown preview' })).toContainText('Detached draft');
  await page.evaluate(() => (window as any).hmTest.reload());
  await expect(page.locator('.hm-conflict')).toContainText('Folder removed');
  await page.getByRole('tab', { name: /README.md/ }).click({ button: 'middle' });
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await project(page); await expect(page.locator('.hm-conflict')).toHaveCount(0);
  await page.getByRole('region', { name: 'Markdown preview' }).focus(); await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.hm-tab.is-active .hm-tab-state')).toHaveText('');
  expect(await disk(page, b, 'README.md')).toBe('# Detached draft');
  await page.getByRole('button', { name: 'Project B' }).click();
  await expect(roots(page)).toHaveCount(2); await expect(page.locator('.hm-tab.is-active')).toContainText('README.md');
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.profile.set('other'));
  await expect(page.getByText('No file open')).toBeVisible();
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.profile.set('default'));
  await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
});

test('imports legacy folder metadata and dirty drafts without losing Markdown settings or root isolation', async ({ page }) => {
  const { a, b } = await fixture(page);
  await write(page, a, 'README.md', '# Server guide\n'); await write(page, b, 'README.md', '# Client guide\n');
  await page.evaluate(() => (window as any).hmTest.unload());
  const snapshot = await (await page.request.get('/test/file', { params: { root: b, path: 'README.md' } })).json();
  await page.evaluate(async ({ a, b, snapshot }) => {
    const sdk = (window as any).hmTest.sdk;
    for (const folder of [a, b]) sdk.ctx.storage.set('session.v1:' + JSON.stringify(['local', 'default', folder]), {
      version: 1, tabs: ['README.md', 'main.ts'], active: 'README.md', preview: 'main.ts', expanded: [''], selectedScript: '',
      bookmarks: [{ id: 'legacy', path: 'README.md', line: 1, label: 'Legacy bookmark', preview: '# guide' }],
      markdown: { 'README.md': { mode: 'preview', splitRatio: 0.65, previewScrollTop: 0 } },
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('hermes-monaco-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('workspaces', 'readwrite');
        transaction.objectStore('workspaces').put({ version: 1, drafts: [{ path: 'README.md', text: '# Recovered legacy draft', baseline: snapshot.text, revision: snapshot.revision, bom: snapshot.bom, eol: snapshot.eol }] }, JSON.stringify(['local', 'default', b]));
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
    sdk.setProjects([{ id: 'p_combined', name: 'Combined project', folders: [{ path: a, label: 'Server', is_primary: true }, { path: b, label: 'Client' }] }]);
    await (window as any).hmTest.reload();
  }, { a, b, snapshot });
  await expect(roots(page)).toHaveCount(2); await expect(page.getByRole('tab')).toHaveCount(4);
  await expect(page.locator('.hm-tab.is-preview')).toHaveCount(1);
  await page.getByRole('tab', { name: /README.md.*Client/ }).click();
  await expect(mode(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Markdown preview' })).toContainText('Recovered legacy draft');
  await mode(page, 'Split').click(); await expect(page.getByRole('separator', { name: 'Resize Markdown panes' })).toHaveAttribute('aria-valuenow', '65');
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click(); await expect(page.locator('.hm-bookmark')).toHaveCount(2);
  await page.locator('.hm-bookmark').filter({ hasText: 'Client/README.md' }).getByRole('button', { name: 'Name bookmark', exact: true }).click();
  await page.getByLabel('Bookmark name').fill('Client note'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.hm-bookmark').filter({ hasText: 'Server/README.md' })).toContainText('Legacy bookmark');
  await expect(page.locator('.hm-bookmark').filter({ hasText: 'Client/README.md' })).toContainText('Client note');
  await page.locator('.hm-bookmark').filter({ hasText: 'Client/README.md' }).getByRole('button', { name: 'Remove bookmark', exact: true }).click();
  await expect(page.locator('.hm-bookmark')).toHaveCount(1); await expect(page.locator('.hm-bookmark')).toContainText('Server/README.md');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await root(page, 'Server').locator('button.hm-root').click();
  await page.evaluate(() => (window as any).hmTest.reload());
  await expect(root(page, 'Server').locator('button.hm-root')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.hm-tab.is-active')).toContainText('Client');
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.connectionId.set('other-backend'));
  await expect(page.getByText('No file open')).toBeVisible();
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.connectionId.set('local'));
  await expect(page.getByRole('region', { name: 'Markdown preview' })).toContainText('Recovered legacy draft');
  expect(await page.evaluate(({ a, b }) => [a, b].every(folder => !!(window as any).hmTest.sdk.ctx.storage.get('session.v1:' + JSON.stringify(['local', 'default', folder]), null)), { a, b })).toBe(true);
  await page.evaluate(() => (window as any).hmTest.sdk.host.navigate('/'));
  await expect(page.locator('.hm-workbench')).toHaveCount(0);
  await page.evaluate(a => (window as any).hmTest.sdk.setProjects([{ id: 'p_combined', name: 'Combined project', folders: [{ path: a, label: 'Server', is_primary: true }] }]), a);
  await page.evaluate(() => (window as any).hmTest.reload());
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(roots(page)).toHaveCount(1);
  await expect(page.locator('.hm-conflict')).toContainText('Folder removed');
  await expect(page.getByRole('region', { name: 'Markdown preview' })).toContainText('Recovered legacy draft');
});

test('scripts from every root retain separate configurations, launch identities and save all project drafts', async ({ page }) => {
  const { a, b, command } = await fixture(page);
  const config = JSON.stringify({ version: 1, scripts: [{ id: 'dev', name: 'Application', command, cwd: '.', shell: 'default' }] });
  await write(page, a, '.hermes/scripts.json', config); await write(page, b, '.hermes/scripts.json', config); await project(page);
  const select = page.getByLabel('Script', { exact: true });
  await expect(select.locator('optgroup')).toHaveCount(2);
  const values = await select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  expect(new Set(values).size).toBe(2);
  await page.getByRole('button', { name: 'Edit scripts', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Server app');
  await dialog.getByLabel('Script folder').selectOption({ label: 'Client' });
  await dialog.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Client app');
  await dialog.getByLabel('Script folder').selectOption({ label: 'Server · unsaved' });
  await expect(dialog.getByLabel('Name', { exact: true }).filter({ visible: true })).toHaveValue('Server app');
  await dialog.getByRole('button', { name: 'Save scripts', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(JSON.parse(await disk(page, a, '.hermes/scripts.json')).scripts[0].name).toBe('Server app');
  expect(JSON.parse(await disk(page, b, '.hermes/scripts.json')).scripts[0].name).toBe('Client app');
  await open(page, 'Server', 'main.ts', true); await replace(page, '// saved server before launch\n');
  await open(page, 'Client', 'main.ts', true); await replace(page, '// saved client before launch\n');
  await select.selectOption({ label: 'Server app' }); await editor(page).click(); await page.keyboard.press('F5');
  await expect(page.locator('.hm-output')).toContainText('saved server before launch');
  expect(await disk(page, b, 'main.ts')).toContain('saved client before launch');
  await select.selectOption({ label: 'Client app' }); await editor(page).click(); await page.keyboard.press('F5');
  await expect(page.locator('.hm-output')).toContainText('saved client before launch');
  await expect(page.getByLabel('View run').locator('option').filter({ hasText: /Server app|Client app/ })).toHaveCount(2);
  await page.getByRole('button', { name: 'Stop selected script', exact: true }).click();
  await select.selectOption({ label: 'Server app' }); await expect(page.getByRole('button', { name: 'Stop selected script', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop selected script', exact: true }).click();
  await write(page, b, '.hermes/scripts.json', '{"version":2,"scripts":[]}');
  await expect(page.locator('.hm-banner.hm-error')).toContainText('Client');
  await expect(page.getByRole('button', { name: 'Run selected script', exact: true })).toBeEnabled();
  await page.screenshot({ path: '.build/projects-scripts.png' });
});

test('missing and nested roots, duplicate labels, failed discovery, and old hosts remain usable', async ({ page }) => {
  const { a, b } = await fixture(page);
  await write(page, a, 'shared/a.txt', 'nested'); await write(page, b, 'shared/b.txt', 'nested');
  const folders = [{ path: a, label: 'Server', is_primary: true }, { path: a + '/shared' }, { path: b + '/shared' }, { path: b + '/missing', label: 'Unavailable' }];
  await project(page, folders);
  await expect(page.locator('.hm-root-error')).toHaveCount(1);
  const labels = await roots(page).locator('button.hm-root').allTextContents();
  expect(new Set(labels).size).toBe(4); expect(labels[1]).toContain(a); expect(labels[2]).toContain(b);
  await open(page, 'Server');
  await write(page, b, 'missing/new.txt', 'recovered');
  await page.getByRole('button', { name: 'Refresh files' }).click();
  await expect(page.locator('.hm-root-error')).toHaveCount(0);
  await page.evaluate(() => {
    const sdk = (window as any).hmTest.sdk; (window as any).originalLookup = sdk.projectRpc.lookup;
    sdk.projectRpc.lookup = async () => { throw new Error('Backend temporarily offline'); }; sdk.emit('projects.changed');
  });
  await expect(page.locator('.hm-banner.hm-error')).toContainText('Could not refresh project folders');
  await expect(roots(page)).toHaveCount(4); await expect(page.getByRole('tab')).toHaveCount(1);
  await page.evaluate(() => { const sdk = (window as any).hmTest.sdk; sdk.projectRpc.lookup = (window as any).originalLookup; });
  await page.getByRole('button', { name: 'Retry folders' }).click(); await expect(page.locator('.hm-banner.hm-error')).toHaveCount(0);
  await page.evaluate(() => { const sdk = (window as any).hmTest.sdk; sdk.projectRpc.lookup = async () => { throw new Error('Unknown method: projects.for_cwd'); }; sdk.emit('projects.changed'); });
  await expect(roots(page)).toHaveCount(1); await expect(page.getByRole('treeitem', { name: /main.ts/ })).toBeVisible();
});

test('membership changes during save cancel launch and stale project replies cannot replace another profile', async ({ page }) => {
  const { a, b, command } = await fixture(page);
  await write(page, a, '.hermes/scripts.json', JSON.stringify({ version: 1, scripts: [{ id: 'dev', name: 'Application', command }] }));
  await project(page); await open(page, 'Server'); await replace(page, '// pending save');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let pending = false, launches = 0;
  await page.route('**/api/plugins/hermes-monaco/file', async route => {
    if (route.request().method() === 'PUT') { pending = true; await gate; }
    await route.continue();
  });
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/runs')) launches++; });
  await editor(page).click(); await page.keyboard.press('F5'); await expect.poll(() => pending).toBe(true);
  await project(page, [{ path: a, label: 'Server', is_primary: true }]); release();
  await expect(page.getByRole('button', { name: 'Run selected script', exact: true })).toBeEnabled(); expect(launches).toBe(0);
  await page.evaluate(({ a, b }) => {
    const sdk = (window as any).hmTest.sdk; const original = sdk.projectRpc.lookup;
    sdk.projectRpc.lookup = async (cwd: string, profile: string, connection: string) => {
      if (profile === 'default') return new Promise(resolve => { (window as any).finishProjectLookup = () => resolve({ project: { id: 'p_stale', name: 'STALE', folders: [{ path: a }, { path: b }] } }); });
      return original(cwd, profile, connection);
    };
    sdk.emit('projects.changed');
  }, { a, b });
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishProjectLookup)).toBe('function');
  await page.evaluate(() => (window as any).hmTest.sdk.host.state.profile.set('other'));
  await expect(page.getByText('No file open')).toBeVisible();
  await page.evaluate(() => (window as any).finishProjectLookup());
  await expect(page.locator('.hm-workspace-label')).not.toContainText('STALE');
  await expect(roots(page)).toHaveCount(1);
});

test('slow folder rebinding pauses launch and refreshes search after the new roots are ready', async ({ page }) => {
  const { a, b, command } = await fixture(page);
  await write(page, a, '.hermes/scripts.json', JSON.stringify({ version: 1, scripts: [{ id: 'dev', name: 'Application', command }] }));
  await write(page, b, 'shared/readme.txt', 'new folder'); await project(page);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let pending = false, launches = 0;
  await page.route('**/api/plugins/hermes-monaco/workspace', async route => { pending = true; await gate; await route.continue(); });
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/runs')) launches++; });
  await page.evaluate(({ a, b }) => (window as any).hmTest.sdk.setProjects([{ id: 'p_combined', name: 'Combined project', folders: [{ path: a, label: 'Server', is_primary: true }, { path: b + '/shared', label: 'Shared' }] }]), { a, b });
  await expect.poll(() => pending).toBe(true);
  await expect(page.getByRole('button', { name: 'Run selected script', exact: true })).toBeDisabled();
  await page.locator('.hm-workbench').focus(); await page.keyboard.press('F5');
  await page.keyboard.press('ControlOrMeta+Shift+p'); await page.getByLabel('Find file').fill('readme');
  await expect(page.locator('.hm-search-summary')).toHaveText('0 results');
  release();
  await expect(page.getByRole('button', { name: 'Run selected script', exact: true })).toBeEnabled();
  await expect(page.locator('.hm-search-result')).toHaveCount(1);
  await expect(page.locator('.hm-search-result')).toContainText('Shared/readme.txt'); expect(launches).toBe(0);
});
