import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bundle } from './build.mjs';
import { stage } from './package.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, '.build/harness');
await bundle();
await stage(resolve(root, '.test-runtime/plugins/hermes-monaco'));
await mkdir(output, { recursive: true });
const common = { absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' } };
const reactExports = Object.keys((await import('react')).default).filter(key => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default');
await build({ ...common, stdin: { contents: `import React from "react"; export default React; export const {${reactExports.join(',')}} = React;`, resolveDir: root }, outfile: resolve(output, 'react.js') });
await build({ ...common, stdin: { contents: 'import runtime from "react/jsx-runtime"; export const { jsx, jsxs, Fragment } = runtime;', resolveDir: root },
  plugins: [{ name: 'react-singleton', setup(api) { api.onResolve({ filter: /^react$/ }, () => ({ path: 'react', external: true })); } }], outfile: resolve(output, 'jsx.js') });
await build({ ...common, entryPoints: ['tests/harness/sdk.tsx'], external: ['react', 'react/jsx-runtime'], outfile: resolve(output, 'sdk.js') });
await build({ ...common, entryPoints: ['tests/harness/app.tsx'], external: ['/assets/*'],
  plugins: [{ name: 'shared-sdk', setup(api) {
    api.onResolve({ filter: /^\.\/sdk$/ }, () => ({ path: '/assets/sdk.js', external: true }));
    api.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: '/assets/jsx.js', external: true }));
    api.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture-react' }));
    api.onLoad({ filter: /.*/, namespace: 'fixture-react' }, () => ({ contents: `import React from '/assets/react.js'; export default React; export const {${reactExports.join(',')}} = React;`, loader: 'js' }));
  } }],
  outfile: resolve(output, 'app.js') });
// As in Hermes, shim URLs replace the few approved bare module imports.
for (const file of ['jsx.js', 'sdk.js', 'app.js']) {
  const path = resolve(output, file);
  const code = (await readFile(path, 'utf8')).replace(/from\s*(['"])(react(?:\/jsx-runtime)?)\1/g,
    (_, quote, name) => `from${quote}/assets/${name === 'react' ? 'react' : 'jsx'}.js${quote}`);
  await writeFile(path, code);
}
const localPython = resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const python = process.env.PYTHON || (existsSync(localPython) ? localPython : 'python');
const server = spawn(python, ['-m', 'uvicorn', 'tests.harness.server:app', '--host', '127.0.0.1', '--port', process.env.PORT || '4317', '--log-level', 'warning'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code || 0));
console.log(`Isolated Monaco harness: http://127.0.0.1:${process.env.PORT || 4317}`);
