import { cp, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const contents = ['plugin.yaml', '__init__.py', 'bootstrap.py', 'pyproject.toml', 'backend', 'dashboard', 'desktop', 'schemas', 'docs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
export async function stage(destination = resolve(root, '.build/package/hermes-monaco')) {
  await mkdir(destination, { recursive: true });
  for (const path of contents) {
    const source = resolve(root, path);
    // README/attribution are required for distributable packages.
    await stat(source);
    await cp(source, resolve(destination, path), { recursive: true,
      filter: file => !file.includes('__pycache__') && !file.endsWith('.pyc') && !file.endsWith('.map') });
  }
  return destination;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await stage());
