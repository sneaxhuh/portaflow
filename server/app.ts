import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { NETWORK, type Award, type Treasury } from '../shared/types.js';
import { parseAmount, schedule, vestedRemaining } from '../shared/money.js';
import { createChallenge, normalizeAddress, sessionHash, treasuryIdentity, verifyChallenge } from './identity.js';
import { Store } from './store.js';
import { Chain } from './chain.js';
import { readAwardCsv } from '../shared/import.js';

function body(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, any>;
}
function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(label + ' is required (maximum ' + max + ' characters).');
  return value.trim();
}
function integer(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' is outside the allowed range.');
  return value;
}

export async function createApp(options: { store?: Store; chain?: Chain; connect?: boolean; serve?: boolean } = {}) {
  await cryptoWaitReady();
  const store = options.store ?? new Store(process.env.PORTAFLOW_DB || resolve('.portaflow/portaflow.sqlite'));
  const chain = options.chain ?? new Chain(store);
  const app = Fastify({ logger: false, bodyLimit: 65_536, requestTimeout: 30_000,
    trustProxy: process.env.RENDER === 'true' ? (_address, hop) => hop === 0 : false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.decorateRequest('walletAddress', '');
  const configuredOrigin = process.env.PORTAFLOW_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const ownOrigin = configuredOrigin || request.protocol + '://' + request.headers.host;
      const devOrigin = !configuredOrigin && (origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173');
      if (origin && origin !== ownOrigin && !devOrigin) return reply.code(403).send({ error: 'This request came from a different origin.' });
    }
    const token = request.cookies.portaflow_session;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const session = store.db.prepare('SELECT address FROM sessions WHERE hash = ? AND expires > ?').get(sessionHash(token), Date.now()) as { address: string } | undefined;
      (request as any).walletAddress = session?.address ?? '';
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as Error & { statusCode?: number };
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500 ? failure.statusCode : 400;
    void reply.code(status).send({ error: failure.message || 'The request could not be completed.' });
  });
  function auth(request: any) {
    if (!request.walletAddress) throw Object.assign(new Error('Connect and sign in with your native wallet first.'), { statusCode: 401 });
    return request.walletAddress as string;
  }
  function getTreasury(id: string) {
    const treasury = store.treasury(id);
    if (!treasury) throw Object.assign(new Error('Treasury not found.'), { statusCode: 404 });
    return treasury;
  }
  function getAward(id: string) {
    const award = store.award(id);
    if (!award) throw Object.assign(new Error('Award not found.'), { statusCode: 404 });
    return award;
  }
  const id = (request: any) => request.params.id as string;
  app.get('/api/health', async () => ({ ok: true, name: 'PortaFlow', network: chain.state }));
  app.get('/api/overview', async request => ({
    network: chain.state, treasuries: store.list<Treasury>('treasuries'), awards: store.list<Award>('awards'),
    session: (request as any).walletAddress ? { address: (request as any).walletAddress } : null,
  }));
  app.post('/api/auth/challenge', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const data = body(request.body);
    const address = normalizeAddress(data.address);
    return createChallenge(store, address, configuredOrigin || request.headers.origin || request.protocol + '://' + request.headers.host);
  });
  app.post('/api/auth/verify', async (request, reply) => {
    const data = body(request.body);
    const result = verifyChallenge(store, text(data.id, 'Challenge ID'), text(data.signature, 'Signature', 200));
    reply.setCookie('portaflow_session', result.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: Boolean(configuredOrigin?.startsWith('https:')), maxAge: 43_200 });
    return { address: result.address };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.cookies.portaflow_session) store.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sessionHash(request.cookies.portaflow_session));
    reply.clearCookie('portaflow_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/wallet/:address', async request => chain.wallet(normalizeAddress((request.params as any).address)));
  app.post('/api/treasuries', async request => {
    const creator = auth(request);
    const data = body(request.body);
    if (!Array.isArray(data.signatories) || data.signatories.length > 5) throw new Error('Provide the treasury signers.');
    const identity = treasuryIdentity(data.signatories, integer(data.threshold, 'Threshold', 2, 5));
    if (!identity.signatories.includes(creator)) throw new Error('Your connected wallet must be a treasury signer.');
    if (store.list<Treasury>('treasuries').some(t => t.address === identity.address)) throw new Error('This signer configuration already has a treasury in PortaFlow.');
    const treasury: Treasury = { id: randomUUID(), name: text(data.name, 'Treasury name', 60), creator,
      threshold: data.threshold, ...identity, createdAt: new Date().toISOString() };
    store.saveTreasury(treasury);
    return treasury;
  });
  app.post('/api/treasuries/:id/funding-plan', async request => {
    const signer = auth(request);
    return chain.fundingPlan(getTreasury(id(request)), signer, parseAmount(text(body(request.body).amount, 'Amount', 45)));
  });
  function makeAward(data: Record<string, any>, creator: string): Award {
    const treasury = getTreasury(text(data.treasuryId, 'Treasury'));
    if (!treasury.signatories.includes(creator)) throw new Error('Only treasury members can create awards.');
    if (data.acceptedCommitment !== true) throw new Error('Confirm that a funded native vesting schedule cannot be cancelled by its sender.');
    chain.requireApi();
    const total = parseAmount(text(data.amount, 'Award amount', 45));
    const upfront = data.upfront === '0' ? 0n : parseAmount(text(data.upfront, 'Upfront amount', 45));
    const locked = total - upfront;
    if (locked < BigInt(chain.state.minVestedRaw)) throw new Error('The vested portion must be at least ' + (BigInt(chain.state.minVestedRaw) / 100_000_000_000_000n) + ' tPOT.');
    const recipient = normalizeAddress(data.recipient);
    if (recipient === treasury.address) throw new Error('A treasury cannot award a grant to itself.');
    const delay = integer(data.startDelayBlocks, 'Start delay', 5, 5_000_000);
    const startBlock = chain.state.bestBlock + delay;
    const duration = integer(data.durationBlocks, 'Vesting duration', 1, 10_000_000);
    let workUrl = typeof data.workUrl === 'string' ? data.workUrl.trim() : '';
    if (workUrl) {
      if (workUrl.length > 500 || !/^https:\/\//.test(workUrl)) throw new Error('Use an HTTPS work reference URL.');
      workUrl = new URL(workUrl).href;
    }
    const award: Award = { id: randomUUID(), treasuryId: treasury.id, title: text(data.title, 'Award title', 100),
      recipient, workUrl, totalRaw: total.toString(), upfrontRaw: upfront.toString(), lockedRaw: locked.toString(),
      startBlock, ...schedule(locked, duration, startBlock), createdAt: new Date().toISOString(), createdBy: creator,
      createdBlock: chain.state.finalizedBlock, status: 'draft' };
    return award;
  }
  app.post('/api/awards', async request => {
    const creator = auth(request);
    // Drafts need a fresh block for scheduling, not historical receipt replay.
    await chain.refreshHead();
    const award = makeAward(body(request.body), creator);
    store.saveAward(award);
    return award;
  });
  app.post('/api/awards/import', async request => {
    const creator = auth(request), data = body(request.body);
    const csv = text(data.csv, 'CSV', 40_000);
    await chain.refreshHead();
    const awards = readAwardCsv(csv).map((row, i) => {
      try {
        return makeAward({ ...row, treasuryId: data.treasuryId, acceptedCommitment: data.acceptedCommitment,
          startDelayBlocks: Math.round(86400 / chain.state.blockSeconds),
          durationBlocks: Math.round(row.durationDays * 86400 / chain.state.blockSeconds) }, creator);
      } catch (error) { throw new Error('Row ' + (i + 2) + ': ' + (error instanceof Error ? error.message : 'Invalid award.')); }
    });
    store.db.exec('BEGIN');
    try { for (const award of awards) store.saveAward(award); store.db.exec('COMMIT'); }
    catch (error) { store.db.exec('ROLLBACK'); throw error; }
    return { awards };
  });
  app.get('/api/awards/:id', async request => {
    const award = getAward(id(request));
    const treasury = getTreasury(award.treasuryId);
    let wallet = null, pending = null;
    if (chain.state.connected && chain.state.verified) {
      [wallet, pending] = await Promise.all([chain.wallet(award.recipient), chain.pending(treasury, award)]);
    }
    const remaining = award.status === 'funded'
      ? vestedRemaining(BigInt(award.lockedRaw), BigInt(award.perBlockRaw), award.startBlock, chain.state.finalizedBlock) : BigInt(award.lockedRaw);
    return { award, treasury, pending, wallet, remainingRaw: remaining.toString(),
      vestedRaw: (BigInt(award.lockedRaw) - remaining).toString(), receipts: store.receipts(award.id),
      reviewRequired: Boolean(award.callHex && award.specVersion !== chain.state.specVersion) || chain.state.bestBlock >= award.startBlock && award.status !== 'funded' };
  });
  app.post('/api/awards/:id/approval-plan', async request => {
    const signer = auth(request);
    const award = getAward(id(request));
    return chain.approvalPlan(award, getTreasury(award.treasuryId), signer);
  });
  app.post('/api/awards/:id/cancel-plan', async request => {
    const signer = auth(request), award = getAward(id(request));
    if (award.status === 'draft') {
      if (award.createdBy !== signer) throw new Error('Only the author can discard this draft.');
      if (award.callHex) {
        await chain.refresh();
        if (chain.state.lastSyncedBlock < chain.state.finalizedBlock) throw new Error('Catching up with finalized blocks. Try again shortly.');
      }
      const latest = getAward(award.id);
      const pending = award.callHex ? await chain.pending(getTreasury(award.treasuryId), latest) : null;
      if (latest.status === 'draft' && !pending) {
        store.saveAward({ ...latest, status: 'cancelled' });
        return { cancelled: true };
      }
    }
    return chain.approvalPlan(award, getTreasury(award.treasuryId), signer, true);
  });
  app.post('/api/awards/:id/unlock-plan', async request => {
    const signer = auth(request), award = getAward(id(request));
    if (award.status !== 'funded') throw new Error('This award has not been funded.');
    return chain.unlockPlan(award.recipient, signer);
  });
  app.get('/api/awards/:id/receipt', async (request, reply) => {
    const award = getAward(id(request));
    reply.header('Content-Disposition', 'attachment; filename="portaflow-' + award.id + '.json"');
    return { application: 'PortaFlow', version: 1, network: NETWORK, award, treasury: getTreasury(award.treasuryId), transactions: store.receipts(award.id) };
  });
  app.post('/api/sync', async request => { auth(request); await chain.refresh(); return chain.state; });
  if (options.serve !== false && existsSync(resolve('dist/index.html'))) {
    await app.register(staticFiles, { root: resolve('dist') });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'Endpoint not found.' }) : reply.sendFile('index.html'));
  }
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const connect = async () => {
    try { await chain.connect(); }
    catch (error) {
      chain.state.connected = false;
      chain.state.verified = false;
      chain.state.error = error instanceof Error ? error.message : 'Could not verify the Portaldot RPC.';
      if (!closing) reconnect = setTimeout(() => { void connect(); }, 15_000);
    }
  };
  if (options.connect !== false) void connect();
  app.addHook('onClose', async () => { closing = true; if (reconnect) clearTimeout(reconnect); await chain.close(); store.close(); });
  return { app, store, chain };
}
