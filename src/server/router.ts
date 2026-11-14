import type { IncomingMessage, ServerResponse } from 'node:http';
import { failRequest } from './http/response.js';
import { performance } from 'node:perf_hooks';
import { logHostEvent } from './diagnostic-log.js';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type RouteContext<Deps> = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  deps: Deps;
};

export type RouteHandler<Deps> = (context: RouteContext<Deps>) => void | Promise<void>;

type Route<Deps> = {
  method: HttpMethod;
  path: string | RegExp;
  handler: RouteHandler<Deps>;
};

export class ServerRouter<Deps> {
  private readonly routes: Route<Deps>[] = [];

  constructor(private readonly deps: Deps, private readonly beginOperation?: (url: URL) => () => void) {}

  add(method: HttpMethod, path: string | RegExp, handler: RouteHandler<Deps>) {
    this.routes.push({ method, path, handler });
    return this;
  }

  get(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('GET', path, handler); }
  head(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('HEAD', path, handler); }
  post(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('POST', path, handler); }
  patch(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('PATCH', path, handler); }
  delete(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('DELETE', path, handler); }

  dispatch(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method as HttpMethod | undefined;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = typeof route.path === 'string'
        ? (route.path === url.pathname ? [] : null)
        : url.pathname.match(route.path)?.slice(1) || null;
      if (!match) continue;
      void this.execute(route, { req, res, url, params: match, deps: this.deps });
      return true;
    }
    return false;
  }

  private async execute(route: Route<Deps>, context: RouteContext<Deps>) {
    let complete: (() => void) | undefined;
    const started = performance.now();
    try {
      complete = this.beginOperation?.(context.url) ?? (() => {});
      try { await route.handler(context); }
      finally { complete(); }
    } catch (error) {
      failRequest(context.res, error, !complete && (error as { status?: number } | null)?.status === 503 ? 503 : 500);
    } finally {
      const durationMs = Math.round(performance.now() - started);
      if (durationMs >= 250 || context.res.statusCode >= 500) {
        logHostEvent('debug', 'http_operation', { operation: route.method + ' ' + String(route.path), status: context.res.statusCode, durationMs });
      }
    }
  }
}
