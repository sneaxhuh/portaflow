import { createApp } from '../server/app.js';

let runtime: ReturnType<typeof createApp> | undefined;
function logStartupFailure(error: unknown) {
  const failure = error as { name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown }; reason?: { servers?: Map<unknown, { error?: { code?: unknown; cause?: { code?: unknown } } }> } };
  const token = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : undefined;
  const message = typeof failure?.message === 'string' ? failure.message : '';
  const category = /bad auth|authentication failed|auth failed/i.test(message) ? 'authentication'
    : /not authorized|not allowed|unauthorized/i.test(message) ? 'authorization' : undefined;
  const serverCodes = failure?.reason?.servers instanceof Map
    ? [...failure.reason.servers.values()].flatMap(server => [token(server.error?.code), token(server.error?.cause?.code)]).filter(value => value !== undefined)
    : [];
  console.error(JSON.stringify({ event: 'portaflow_startup_failed', type: token(failure?.name), code: token(failure?.code), category,
    causeCode: token(failure?.cause?.code), serverCodes: [...new Set(serverCodes)] }));
}
function getRuntime() {
  if (!runtime) runtime = createApp({ serverless: true, serve: false }).catch(error => { runtime = undefined; logStartupFailure(error); throw error; });
  return runtime;
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const { app } = await getRuntime();
      const url = new URL(request.url);
      const route = url.searchParams.get('__route');
      url.searchParams.delete('__route');
      const path = route === null ? url.pathname : '/api/' + route;
      const payload = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
      if (payload && Buffer.byteLength(payload) > 65_536) return Response.json({ error: 'Request body is too large.' }, { status: 413 });
      const result = await app.inject({ method: request.method as 'GET' | 'POST', url: path + url.search,
        headers: Object.fromEntries(request.headers), payload });
      const headers = new Headers();
      for (const [name, value] of Object.entries(result.headers)) {
        if (value === undefined || ['content-length', 'transfer-encoding', 'connection'].includes(name)) continue;
        if (Array.isArray(value)) value.forEach(item => headers.append(name, String(item)));
        else headers.set(name, String(value));
      }
      headers.set('Cache-Control', 'private, no-store');
      return new Response(request.method === 'HEAD' ? null : result.rawPayload, { status: result.statusCode, headers });
    } catch {
      return Response.json({ error: 'PortaFlow could not connect to its database. Check the server configuration and try again.' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    }
  },
};
