import { createApp } from '../server/app.js';

let runtime: ReturnType<typeof createApp> | undefined;
function getRuntime() {
  if (!runtime) runtime = createApp({ serverless: true, serve: false }).catch(error => { runtime = undefined; throw error; });
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
      return Response.json({ error: 'PortaFlow could not connect to its database. Check the server configuration and try again.' }, { status: 503 });
    }
  },
};
