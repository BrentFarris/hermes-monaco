import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button as HermesButton, Input } from '@hermes/plugin-sdk';

export function Button({ children, title, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <HermesButton type="button" variant="ghost" size="sm" title={title} className={'hm-button ' + className} {...props}>{children}</HermesButton>;
}
export { Input };

export function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose(): void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={'hm-dialog ' + className} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><Button aria-label="Close dialog" onClick={onClose}>×</Button></header>
    {children}
  </dialog>;
}

export function TextDialog({ title, label, initial, submitLabel = 'Save', allowEmpty = false, onSubmit, onClose }: {
  title: string; label: string; initial: string; submitLabel?: string; allowEmpty?: boolean; onSubmit(value: string): Promise<unknown> | unknown; onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose}><form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSubmit(value); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }}><label>{label}<Input autoFocus value={value} onChange={event => setValue(event.target.value)} /></label>
    {error && <p className="hm-error" role="alert">{error}</p>}
    <footer><Button onClick={onClose}>Cancel</Button><Button type="submit" className="hm-primary" disabled={busy || (!allowEmpty && !value.trim())}>{busy ? 'Working…' : submitLabel}</Button></footer>
  </form></Modal>;
}

