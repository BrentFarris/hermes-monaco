import { useEffect, useRef, useState } from 'react';
import type { Controller } from './controller';
import { Button, Input } from './components';
import { isRunning } from './types';

// Terminal control sequences are not HTML. Strip ANSI/OSC from this log view;
// a managed run does not grant a program control over browser markup or links.
export const plainOutput = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');

export function RunOutput({ controller }: { controller: Controller }) {
  const [height, setHeight] = useState(230);
  const [filter, setFilter] = useState('');
  const log = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const run = controller.runs.find(item => item.id === controller.selectedRun);
  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [controller.output?.cursor]);
  return <section className="hm-output" style={{ height }} aria-label="Run output">
    <div className="hm-output-resize" role="separator" aria-label="Resize output" aria-orientation="horizontal" tabIndex={0}
      onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setHeight(h => Math.max(120, Math.min(600, h + (e.key === 'ArrowUp' ? 20 : -20)))); } }}
      onPointerDown={event => {
        const start = event.clientY, original = height, target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (e: PointerEvent) => setHeight(Math.max(120, Math.min(600, original + start - e.clientY)));
        const finish = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', finish); };
        target.addEventListener('pointermove', move); target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', finish);
      }} />
    <header><strong>Run Output</strong><select aria-label="View run" value={controller.selectedRun} onChange={e => { controller.selectRun(e.target.value); follow.current = true; void controller.perform(() => controller.refreshRuns()); }}>
      <option value="">Select a run…</option>{controller.runs.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}{item.workspaceId !== controller.session?.workspace.id ? ' · ' + item.root.split(/[\\/]/).pop() : ''}</option>)}
    </select><span className="hm-spacer" /><Input aria-label="Filter output" placeholder="Filter output…" value={filter} onChange={e => setFilter(e.target.value)} />
      {run && isRunning(run) && <Button className="hm-danger" onClick={() => void controller.perform(() => controller.stop(run.id))}>■ Stop</Button>}
      <Button aria-label="Hide output" onClick={() => { controller.outputOpen = false; controller.changed(); }}>×</Button>
    </header>
    {run && <div className="hm-run-meta"><span className={'hm-run-state ' + run.status}>{run.status}{run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}</span><code title={run.command}>{run.command}</code><span title={run.root}>{run.root}</span></div>}
    {run?.error && <p className="hm-error">{run.error}</p>}
    {controller.output?.truncated && <div className="hm-log-notice">Older output was discarded to keep the log bounded.</div>}
    <pre ref={log} className="hm-log" tabIndex={0} onScroll={() => { if (log.current) follow.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 30; }}>
      {controller.output?.chunks.map(chunk => {
        const text = plainOutput(chunk.text);
        const shown = filter ? text.split('\n').filter(line => line.toLowerCase().includes(filter.toLowerCase())).join('\n') : text;
        return <span key={chunk.cursor} className={chunk.stream === 'stderr' ? 'hm-stderr' : ''}>{shown}</span>;
      })}
      {!run && <span className="hm-subtle">Select a script and press Play to start a run.</span>}
    </pre>
  </section>;
}

