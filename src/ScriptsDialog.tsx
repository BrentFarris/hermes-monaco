import { useState } from 'react';
import type { Controller } from './controller';
import { Button, Input, Modal } from './components';
import type { Script, ScriptsConfig, Shell } from './types';

export function ScriptsDialog({ controller, onClose }: { controller: Controller; onClose(): void }) {
  const session = controller.session!;
  const [config, setConfig] = useState<ScriptsConfig>(() => structuredClone(session.config.config));
  const [revision] = useState(session.config.revision);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const script = config.scripts[selected];
  const update = (patch: Partial<Script>) => setConfig(value => ({ ...value, scripts: value.scripts.map((entry, i) => i === selected ? { ...entry, ...patch } : entry) }));
  const shift = (direction: number) => {
    const to = selected + direction;
    if (to < 0 || to >= config.scripts.length) return;
    const scripts = [...config.scripts];
    [scripts[selected], scripts[to]] = [scripts[to], scripts[selected]];
    setConfig({ ...config, scripts }); setSelected(to);
  };
  return <Modal title="Project scripts" onClose={onClose} className="hm-scripts-dialog">
    <p className="hm-subtle">Saved in <code>.hermes/scripts.json</code> for this repository. Commands run on the Hermes backend.</p>
    {session.configError && <p className="hm-error">{session.configError}</p>}
    <div className="hm-scripts-grid"><div className="hm-script-list">
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
    </div></div>
    {error && <p className="hm-error" role="alert">{error}</p>}
    <footer><Button disabled={session.config.revision === null} onClick={() => { void controller.perform(() => controller.open('.hermes/scripts.json')); onClose(); }}>Open configuration</Button><span className="hm-spacer" /><Button onClick={onClose}>Cancel</Button>
      <Button className="hm-primary" disabled={busy || !!session.configError} onClick={async event => {
        const fields = event.currentTarget.closest('dialog')?.querySelectorAll('textarea') || [];
        if ([...fields].some(field => !field.reportValidity())) return;
        setBusy(true); setError('');
        try { controller.assertSession(session); await controller.saveConfig(config, revision); onClose(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      }}>{busy ? 'Saving…' : 'Save scripts'}</Button>
    </footer>
  </Modal>;
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

