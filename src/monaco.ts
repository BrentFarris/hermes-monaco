import * as core from 'monaco-editor/editor/editor.api';
import type * as Monaco from 'monaco-editor';
import 'monaco-editor/basic-languages/monaco.contribution';
import type { LanguageServiceDefaults } from 'monaco-editor/languages/features/json/register';
import { setupMode } from 'monaco-editor/languages/features/json/jsonMode';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices';
import { IEditorWorkerService } from 'monaco-editor/editor/common/services/editorWorker';
import 'monaco-editor/editor/browser/services/contribution.js';
import 'monaco-editor/editor/common/services/treeViewsDndService.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import schema from '../schemas/scripts.schema.json';

export const monaco = core as unknown as typeof Monaco;

export function initializeMonaco() {
  const stylesheet = document.createElement('style');
  stylesheet.dataset.hermesMonaco = 'monaco';
  stylesheet.textContent = __MONACO_STYLES__;
  document.head.append(stylesheet);
  const global = globalThis as typeof globalThis & { MonacoEnvironment?: Monaco.Environment };
  const previous = global.MonacoEnvironment;
  const urls = new Map<string, string>();
  const workers = new Set<Worker>();
  const environment = {
    getWorker(_id: string, label: string) {
      const name = label === 'json' ? 'json' : 'editor';
      let url = urls.get(name);
      if (!url) {
        url = URL.createObjectURL(new Blob([name === 'json' ? __JSON_WORKER__ : __EDITOR_WORKER__], { type: 'text/javascript' }));
        urls.set(name, url);
      }
      const worker = new Worker(url, { type: 'module', name: `hermes-monaco-${name}` });
      workers.add(worker);
      return worker;
    },
  };
  global.MonacoEnvironment = environment;
  // Own the JSON mode's disposer. The stock register entry starts a worker
  // manager on first use and does not expose its interval/provider cleanup.
  // Importing setupMode eagerly also registers its standalone services before
  // the first editor is created (late service registration is unsupported).
  const changes = new monaco.Emitter<LanguageServiceDefaults>();
  const defaults: LanguageServiceDefaults = {
    languageId: 'json', onDidChange: changes.event,
    diagnosticsOptions: { validate: true, allowComments: false, enableSchemaRequest: false,
      schemas: [{ uri: 'hermes-monaco://schemas/scripts.json', fileMatch: ['*/.hermes/scripts.json'], schema }] },
    modeConfiguration: { documentFormattingEdits: true, documentRangeFormattingEdits: true, completionItems: true,
      hovers: true, documentSymbols: true, tokens: true, foldingRanges: true, diagnostics: true, selectionRanges: true },
    setDiagnosticsOptions() {}, setModeConfiguration() {},
  };
  monaco.languages.register({ id: 'json', extensions: ['.json', '.bowerrc', '.jshintrc', '.eslintrc', '.babelrc', '.har'], aliases: ['JSON', 'json'] });
  const jsonMode = setupMode(defaults);
  return (disposeModels: () => void = () => {}) => {
    jsonMode.dispose(); changes.dispose();
    disposeModels();
    // Each runtime load owns its bundled Monaco singleton, including the
    // editor worker manager's idle timer (not just its Worker objects).
    StandaloneServices.get(IEditorWorkerService).dispose();
    stylesheet.remove();
    workers.forEach(worker => worker.terminate());
    urls.forEach(url => URL.revokeObjectURL(url));
    if (global.MonacoEnvironment === environment) global.MonacoEnvironment = previous;
  };
}

export function languageForPath(path: string): string {
  const name = path.split('/').pop()!.toLowerCase();
  const match = monaco.languages.getLanguages().find(language =>
    language.filenames?.some(file => file.toLowerCase() === name) || language.extensions?.some(extension => name.endsWith(extension.toLowerCase())));
  return match?.id || 'plaintext';
}

export function applyTheme(element: HTMLElement) {
  const styles = getComputedStyle(element);
  // Canvas resolves Hermes's CSS color formats (including OKLCH) into a
  // browser color; Monaco's theme API needs hex rather than CSS variables.
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const color = (value: string, fallback: string) => {
    context.fillStyle = fallback;
    context.fillStyle = value || fallback;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('');
  };
  const background = color(styles.backgroundColor, '#17191e');
  const foreground = color(styles.color, '#e4e7ed');
  const dark = parseInt(background.slice(1, 3), 16) + parseInt(background.slice(3, 5), 16) + parseInt(background.slice(5), 16) < 380;
  monaco.editor.defineTheme('hermes-monaco', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: {
    'editor.background': background, 'editor.foreground': foreground,
    'editorGutter.background': background,
    'editorRuler.foreground': dark ? '#ffffff24' : '#00000020',
  } });
  monaco.editor.setTheme('hermes-monaco');
}

