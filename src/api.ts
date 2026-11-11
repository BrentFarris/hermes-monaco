import type { PluginContext } from '@hermes/plugin-sdk';
import type { Route } from './types';

export const routeKey = (route: Route) => JSON.stringify([route.connection, route.profile, route.cwd, route.epoch]);
export const sessionKey = (route: Route, root: string) => JSON.stringify([route.connection, route.profile, root]);
export class StaleContext extends Error { constructor() { super('The active workspace changed.'); } }
export class ApiError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}

export class Client {
  constructor(private ctx: PluginContext, private route: Route, private currentRoute: () => Route) {}
  assertCurrent() { if (routeKey(this.route) !== routeKey(this.currentRoute())) throw new StaleContext(); }
  async call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    this.assertCurrent();
    const result = await this.ctx.rest<T & { error?: { code: string; message: string; [key: string]: unknown } }>(path, { method, body, timeoutMs: 30_000 });
    this.assertCurrent();
    // Structured errors travel in an HTTP-200 envelope: Hermes's native REST
    // bridge otherwise flattens non-2xx bodies, losing save-conflict snapshots.
    if (result?.error) throw new ApiError(result.error.code, result.error.message, result.error);
    return result;
  }
}

export const query = (values: Record<string, string>) => '?' + new URLSearchParams(values).toString();

