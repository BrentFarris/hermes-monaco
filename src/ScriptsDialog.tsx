import { useState } from 'react';
import type { Controller } from './controller';
import { Button, Input, Modal } from './components';
import type { Script, ScriptsConfig, Shell } from './types';

export function ScriptsDialog({ controller, onClose }: { controller: Controller; onClose(): void }) {
  const session = controller.session!;
  const [roots] = useState(() => [...session.roots]);
  const [rootKey, setRootKey] = useState(controller.selectedScriptRoot?.key || session.roots.find(root => root.key === controller.activeTab?.rootKey)?.key || session.primary);
  const [drafts, setDrafts] = useState(() => new Map(roots.map(root => [root.key, { config: structuredClone(root.config.config), revision: root.config.revision, dirty: false }])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = roots.find(item => item.key === rootKey)!;
  const dirty = [...drafts.values()].some(draft => draft.dirty);
  const changed = (key: string, config?: ScriptsConfig) => setDrafts(previous => {
    const next = new Map(previous), draft = next.get(key)!;
    next.set(key, { ...draft, config: config || draft.config, dirty: true }); return next;
  });
  return <Modal title="Project scripts" onClose={onClose} className="hm-scripts-dialog">
    {roots.length > 1 && <label className="hm-script-root-label">Folder<select aria-label="Script folder" value={rootKey} disabled={busy} onChange={event => setRootKey(event.target.value)}>
      {roots.map(item => <option key={item.key} value={item.key}>{item.label}{drafts.get(item.key)?.dirty ? ' · unsaved' : ''}</option>)}
    </select></label>}
    <p className="hm-subtle">Saved in <code>{roots.length > 1 ? root.label + '/' : ''}.hermes/scripts.json</code> for this repository. Commands run on the Hermes backend.</p>
    {roots.map(item => <div key={item.key} hidden={item.key !== rootKey} data-script-root={item.key} onChangeCapture={() => changed(item.key)}>
      {(item.error || item.configError) && <p className="hm-error">{item.error || item.configError}</p>}
      <fieldset disabled={busy || !!item.error || !!item.configError} className="hm-script-fieldset">
        <ScriptForm config={drafts.get(item.key)!.config} setConfig={config => changed(item.key, config)} />
      </fieldset>
    </div>)}
    {error && <p className="hm-error" role="alert">{error}</p>}
    <footer><Button disabled={dirty || !!root.error || (root.config.revision === null && !root.configError)} title={dirty ? 'Save or cancel your script changes before opening the configuration' : undefined}
      onClick={() => { void controller.perform(() => controller.open({ rootKey, path: '.hermes/scripts.json' })); onClose(); }}>Open configuration</Button><span className="hm-spacer" /><Button onClick={onClose}>Cancel</Button>
      <Button className="hm-primary" disabled={busy || (!dirty && !!root.configError)} onClick={async event => {
        const dialog = event.currentTarget.closest('dialog')!;
        for (const form of dialog.querySelectorAll<HTMLElement>('[data-script-root]')) {
          const invalid = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].find(field => !field.checkValidity());
          if (invalid) { setRootKey(form.dataset.scriptRoot!); setError('Correct the invalid script fields before saving.'); requestAnimationFrame(() => invalid.reportValidity()); return; }
        }
        setBusy(true); setError('');
        try {
          for (const item of roots) {
            const draft = drafts.get(item.key)!;
            if (!draft.dirty) continue;
            controller.assertSession(session);
            await controller.saveConfig(item, draft.config, draft.revision);
            setDrafts(previous => { const next = new Map(previous); next.set(item.key, { ...draft, revision: item.config.revision, dirty: false }); return next; });
          }
          onClose();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      }}>{busy ? 'Saving…' : 'Save scripts'}</Button>
    </footer>
  </Modal>;
}

function ScriptForm({ config, setConfig }: { config: ScriptsConfig; setConfig(config: ScriptsConfig): void }) {
  const [selected, setSelected] = useState(0);
  const script = config.scripts[selected];
  const update = (patch: Partial<Script>) => setConfig({ ...config, scripts: config.scripts.map((entry, i) => i === selected ? { ...entry, ...patch } : entry) });
  const shift = (direction: number) => {
    const to = selected + direction;
    if (to < 0 || to >= config.scripts.length) return;
    const scripts = [...config.scripts];
    [scripts[selected], scripts[to]] = [scripts[to], scripts[selected]];
    setConfig({ ...config, scripts }); setSelected(to);
  };
  return <div className="hm-scripts-grid"><div className="hm-script-list">
      {config.scripts.map((entry, index) => <button key={index} className={selected === index ? 'is-selected' : ''} onClick={() => setSelected(index)}><span>▶</span>{entry.name || 'Unnamed script'}</button>)}
      <Button onClick={() => {
        const id = 'script-' + crypto.randomUUID().slice(0, 8);
        setConfig({ ...config, scripts: [...config.scripts, { id, name: 'New script', command: '', cwd: '.', shell: 'default' }] });
        setSelected(config.scripts.length);
      }}>＋ Add script</Button>
    </div><div className="hm-script-form">
      {!script ? <p className="hm-empty-copy">Add a command to launch your app, run tests, or start a development server.</p> : <>
        <label>Name<Input value={script.name} onChange={e => update({ name: e.target.value })} placeholder="Launch application" /></label>
        <label>Command<textarea rows={3} value={script.command} onChange={e => update({ command: e.target.value })} placeholder="npm run dev" spellCheck={false} /></label>
        <div className="hm-form-row"><label>Working directory<Input value={script.cwd || '.'} onChange={e => update({ cwd: e.target.value })} /></label>
          <label>Shell<select value={script.shell || 'default'} onChange={e => update({ shell: e.target.value as Shell })}>{['default', 'pwsh', 'powershell', 'cmd', 'sh', 'bash'].map(shell => <option key={shell}>{shell}</option>)}</select></label></div>
        <details key={script.id}><summary>Environment and platform overrides</summary>
          <JsonField label="Environment variables (JSON object)" value={script.env || {}} onChange={env => update({ env: env as Record<string, string> })} />
          <JsonField label="Platform overrides (windows, linux, macos)" value={script.platforms || {}} onChange={platforms => update({ platforms: platforms as Script['platforms'] })} />
          <p className="hm-subtle">The process inherits its backend environment. Keep secrets out of this shared file.</p>
        </details>
        <div className="hm-script-edit-actions"><Button disabled={selected === 0} onClick={() => shift(-1)}>Move up</Button><Button disabled={selected === config.scripts.length - 1} onClick={() => shift(1)}>Move down</Button>
          <Button className="hm-danger" onClick={() => { setConfig({ ...config, scripts: config.scripts.filter((_, i) => i !== selected) }); setSelected(Math.max(0, selected - 1)); }}>Remove</Button></div>
      </>}
    </div></div>;
}

function JsonField({ label, value, onChange }: { label: string; value: object; onChange(value: object): void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  return <label>{label}<textarea rows={4} spellCheck={false} value={text} onChange={event => {
    setText(event.target.value);
    try {
      const parsed = JSON.parse(event.target.value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Enter a JSON object.');
      onChange(parsed); setError(''); event.target.setCustomValidity('');
    } catch (e) { const message = e instanceof Error ? e.message : String(e); setError(message); event.target.setCustomValidity(message); }
  }} />{error && <small className="hm-error">{error}</small>}</label>;
}

