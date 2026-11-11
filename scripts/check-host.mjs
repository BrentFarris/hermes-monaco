// Validate against an actual Hermes checkout without copying its source into
// the distribution or changing that checkout.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transform } from 'esbuild';

if (!process.argv[2]) throw new Error('Usage: node scripts/check-host.mjs /path/to/hermes-agent');
const host = resolve(process.argv[2]);
const loader = await readFile(resolve(host, 'apps/desktop/src/contrib/runtime-loader.ts'), 'utf8');
const start = loader.indexOf('const importSpecifierRe =');
const end = loader.indexOf('export function unloadRuntimePlugin');
if (start < 0 || end <= start) throw new Error('Hermes loader changed; inspect its parser before updating this check.');
const parser = loader.slice(start, end);
const { code } = await transform(`const sdkImportMap=()=>({'@hermes/plugin-sdk':'blob:hermes-sdk','react':'blob:hermes-react','react/jsx-runtime':'blob:hermes-jsx'});\n${parser}\nexport {unsupportedImports, rewriteSpecifiers};`, { loader: 'ts', format: 'esm' });
const { unsupportedImports, rewriteSpecifiers } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
const unsupported = unsupportedImports(source);
if (unsupported.length) throw new Error('Hermes rejects imports: ' + unsupported.map(item => item.slice(0, 160)).join(', '));
const rewritten = rewriteSpecifiers(source);
if (!rewritten.includes('blob:hermes-sdk') || !rewritten.includes('blob:hermes-react')) throw new Error('Hermes did not rewrite the SDK/React imports');
console.log('Actual Hermes runtime import allowlist and source rewriting passed.');
