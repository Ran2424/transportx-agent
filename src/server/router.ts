import type { IncomingMessage, ServerResponse } from 'node:http';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'DELETE' | 'OPTIONS';

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

  constructor(private readonly deps: Deps) {}

  add(method: HttpMethod, path: string | RegExp, handler: RouteHandler<Deps>) {
    this.routes.push({ method, path, handler });
    return this;
  }

  get(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('GET', path, handler); }
  head(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('HEAD', path, handler); }
  post(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('POST', path, handler); }
  delete(path: string | RegExp, handler: RouteHandler<Deps>) { return this.add('DELETE', path, handler); }

  dispatch(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method as HttpMethod | undefined;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = typeof route.path === 'string'
        ? (route.path === url.pathname ? [] : null)
        : url.pathname.match(route.path)?.slice(1) || null;
      if (!match) continue;
      void Promise.resolve(route.handler({ req, res, url, params: match, deps: this.deps }));
      return true;
    }
    return false;
  }
}
