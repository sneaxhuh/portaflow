import { createApp } from './app.js';

process.umask(0o077);
const { app } = await createApp();
await app.listen({ host: process.env.PORTAFLOW_HOST || '127.0.0.1', port: Number(process.env.PORT || 8787) });
console.log('PortaFlow → http://127.0.0.1:' + (process.env.PORT || '8787'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
