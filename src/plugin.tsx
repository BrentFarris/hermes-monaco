import * as sdk from '@hermes/plugin-sdk';
import { useEffect } from 'react';
import { Controller } from './controller';
import { Workbench } from './Workbench';
import { initializeMonaco } from './monaco';
import styles from './styles.css';
import type { ProjectInfo } from './types';

export default {
  id: 'hermes-monaco',
  name: 'Hermes Monaco',
  description: 'Code workspace, search, bookmarks, and shared project scripts.',
  defaultEnabled: false,
  register(ctx) {
    if (!sdk.host?.state?.cwd || !ctx.rest || !sdk.host.openWorkspace) {
      sdk.host.notify({ kind: 'error', message: 'Hermes Monaco needs a recent Hermes Desktop/Webapp with workspace panes and plugin backend support.' });
      return;
    }
    const disposeMonaco = initializeMonaco();
    const style = document.createElement('style');
    style.dataset.hermesMonaco = '';
    style.textContent = styles;
    document.head.append(style);
    const route = () => ({ cwd: sdk.host.state.cwd.get(), profile: sdk.host.state.profile.get(),
      connection: sdk.host.state.connectionId?.get() || null,
      epoch: typeof sdk.gatewayActivationEpoch === 'function' ? sdk.gatewayActivationEpoch() : 0 });
    const controller = new Controller(ctx, route, undefined, sdk.host.request ? async captured => {
      const result = await sdk.host.request!<{ project: ProjectInfo | null }>('projects.for_cwd', { cwd: captured.cwd, profile: captured.profile });
      return result.project;
    } : undefined);
    let closeSplit: (() => void) | null = null;
    const expand = () => { closeSplit?.(); closeSplit = null; sdk.host.navigate('/hermes-monaco'); };
    const split = () => {
      sdk.host.navigate('/');
      closeSplit = sdk.host.openWorkspace!('hermes-monaco-code', {
        dock: { pane: 'workspace', pos: 'right' }, minWidth: '25rem', title: 'Code',
        render: () => <Workbench controller={controller} split onSplit={split} onExpand={expand} />,
        onClose: () => { closeSplit = null; },
      });
    };
    function FullWorkspace() {
      useEffect(() => { closeSplit?.(); closeSplit = null; }, []);
      return <Workbench controller={controller} split={false} onSplit={split} onExpand={expand} />;
    }
    const subscriptions = [sdk.host.state.cwd, sdk.host.state.profile, sdk.host.state.connectionId, sdk.host.state.gateway]
      .filter(atom => !!atom).map(atom => atom!.subscribe(() => controller.routeChanged()));
    ctx.register({ id: 'page', area: sdk.ROUTES_AREA, title: 'Code', data: { path: '/hermes-monaco' },
      render: () => <FullWorkspace /> });
    ctx.register({ id: 'nav', area: sdk.SIDEBAR_NAV_AREA, data: { path: '/hermes-monaco', label: 'Code', codicon: 'code' } });
    ctx.register({ id: 'open', area: sdk.PALETTE_AREA, data: { id: 'hermes-monaco.open', label: 'Code: Open workspace', keywords: ['editor', 'monaco', 'files'], run: expand } });
    ctx.register({ id: 'split', area: sdk.PALETTE_AREA, data: { id: 'hermes-monaco.split', label: 'Code: Split with chat', run: split } });
    ctx.onEvent?.('projects.changed', () => { void controller.perform(() => controller.refreshProject()); });
    ctx.addEventListener(window, 'focus', () => { controller.routeChanged(); void controller.perform(() => controller.refreshProject()); });
    ctx.addEventListener(window, 'pagehide', () => controller.persistAll());
    ctx.addEventListener(window, 'beforeunload', event => {
      controller.persistAll();
      if (controller.hasDrafts) { event.preventDefault(); (event as BeforeUnloadEvent).returnValue = ''; }
    });
    ctx.onDispose(() => { closeSplit?.(); subscriptions.forEach(dispose => dispose()); disposeMonaco(() => controller.dispose()); style.remove(); });
  },
} satisfies sdk.HermesPlugin;
