import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { NETWORK, type Award, type Treasury, type PayoutRound, type Receipt, type TreasuryLedger } from '../shared/types.js';
import { parseAmount, schedule, vestedRemaining } from '../shared/money.js';
import { createChallenge, normalizeAddress, sessionHash, treasuryIdentity, verifyChallenge } from './identity.js';
import { createStore, type DataStore } from './store.js';
import { Chain } from './chain.js';
import { readAwardCsv } from '../shared/import.js';
import { verifyReceipt } from './verify.js';
import { programReport, programReportCsv } from '../shared/report.js';
import { InvoiceChain } from './invoice-chain.js';
import { registerInvoiceRoutes } from './invoice-routes.js';
import type { InvoiceBatch } from '../shared/invoices.js';
import {rpcReadFailureMessage} from '../shared/rpc-errors.js';

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

export async function createApp(options: { store?: DataStore; chain?: Chain; invoiceChain?: InvoiceChain; connect?: boolean; serve?: boolean; serverless?: boolean } = {}) {
  await cryptoWaitReady();
  const store = options.store ?? await createStore();
  const chain = options.chain ?? new Chain(store, undefined, !options.serverless);
  const app = Fastify({ logger: false, bodyLimit: 65_536, requestTimeout: 30_000,
    trustProxy: process.env.RENDER === 'true' || process.env.VERCEL === '1' ? (_address, hop) => hop === 0 : false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.decorateRequest('walletAddress', '');
  const configuredOrigin = process.env.PORTAFLOW_ORIGIN || process.env.RENDER_EXTERNAL_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : undefined);
  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const ownOrigin = configuredOrigin || request.protocol + '://' + request.headers.host;
      const previewOrigin = process.env.VERCEL_URL && 'https://' + process.env.VERCEL_URL;
      const devOrigin = !configuredOrigin && (origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173');
      if (origin && origin !== ownOrigin && origin !== previewOrigin && !devOrigin) return reply.code(403).send({ error: 'This request came from a different origin.' });
    }
    const token = request.cookies.portaflow_session;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const session = await store.session(sessionHash(token));
      (request as any).walletAddress = session?.address ?? '';
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as Error & { statusCode?: number };
    const rpcMessage=rpcReadFailureMessage(failure);
    if(rpcMessage)return reply.code(503).send({error:rpcMessage});
    if (/^Mongo/.test(failure.name)) {
      const duplicate = (failure as Error & { code?: number }).code === 11000;
      return reply.code(duplicate ? 409 : 503).send({ error: duplicate ? 'This record already exists. Refresh before retrying.' : 'The database is temporarily unavailable. Please try again shortly.' });
    }
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 600 ? failure.statusCode : 400;
    void reply.code(status).send({ error: failure.message || 'The request could not be completed.' });
  });
  function auth(request: any) {
    if (!request.walletAddress) throw Object.assign(new Error('Connect and sign in with your native wallet first.'), { statusCode: 401 });
    return request.walletAddress as string;
  }
  async function getTreasury(id: string) {
    const treasury = await store.treasury(id);
    if (!treasury) throw Object.assign(new Error('Treasury not found.'), { statusCode: 404 });
    return treasury;
  }
  registerInvoiceRoutes(app, { store, chain, auth, settlement: options.invoiceChain ?? new InvoiceChain(chain) });
  async function getAward(id: string) {
    const award = await store.award(id);
    if (!award) throw Object.assign(new Error('Award not found.'), { statusCode: 404 });
    return award;
  }
  const id = (request: any) => request.params.id as string;
  app.get('/api/health', async () => ({ ok: true, name: 'PortaFlow', network: chain.state }));
  app.get('/api/overview', async (request,reply) => {
    reply.header('Cache-Control','private, no-store');
    const [treasuries,awards,rounds,batches]=await Promise.all([store.list<Treasury>('treasuries'),store.list<Award>('awards'),store.list<PayoutRound>('rounds'),store.list<InvoiceBatch>('invoice_batches')]);
    const address=(request as any).walletAddress;
    return {network:chain.state,treasuries,awards,rounds,invoiceBatches:batches.filter(b=>treasuries.find(t=>t.id===b.treasuryId)?.signatories.includes(address)),session:address?{address}:null};
  });
  app.post('/api/auth/challenge', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const data = body(request.body);
    const address = normalizeAddress(data.address);
    return createChallenge(store, address, request.headers.origin || configuredOrigin || request.protocol + '://' + request.headers.host);
  });
  app.post('/api/auth/verify', async (request, reply) => {
    const data = body(request.body);
    const result = await verifyChallenge(store, text(data.id, 'Challenge ID'), text(data.signature, 'Signature', 200));
    reply.setCookie('portaflow_session', result.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: Boolean(process.env.VERCEL || configuredOrigin?.startsWith('https:')), maxAge: 43_200 });
    return { address: result.address };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.cookies.portaflow_session) await store.deleteSession(sessionHash(request.cookies.portaflow_session));
    reply.clearCookie('portaflow_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/wallet/:address', async request => chain.wallet(normalizeAddress((request.params as any).address)));
  app.get('/api/programs/:id/report', async (request, reply) => {
    const treasury = await getTreasury(id(request));
    await chain.refreshHead();
    const [awards, rounds, cursor] = await Promise.all([store.list<Award>('awards'), store.list<PayoutRound>('rounds'), store.getMeta('cursor:' + NETWORK.genesis)]);
    const report = programReport(treasury, awards, rounds, chain.state.finalizedBlock, Number(cursor ?? chain.state.lastSyncedBlock));
    reply.header('Cache-Control', 'private, no-store');
    const format = (request.query as { format?: string }).format;
    if (format === 'csv') return reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="portaflow-' + treasury.id + '-report.csv"').send(programReportCsv(report));
    if (format && format !== 'json') throw new Error('Choose JSON or CSV report format.');
    return report;
  });
  app.post('/api/treasuries', async request => {
    const creator = auth(request);
    const data = body(request.body);
    if (!Array.isArray(data.signatories) || data.signatories.length > 5) throw new Error('Provide the treasury signers.');
    const identity = treasuryIdentity(data.signatories, integer(data.threshold, 'Threshold', 2, 5));
    if (!identity.signatories.includes(creator)) throw new Error('Your connected wallet must be a treasury signer.');
    if ((await store.list<Treasury>('treasuries')).some(t => t.address === identity.address)) throw new Error('This signer configuration already has a treasury in PortaFlow.');
    const treasury: Treasury = { id: randomUUID(), name: text(data.name, 'Treasury name', 60), creator,
      threshold: data.threshold, ...identity, createdAt: new Date().toISOString(), createdBlock: chain.state.finalizedBlock || undefined };
    await store.saveTreasury(treasury);
    return treasury;
  });
  app.post('/api/treasuries/:id/funding-plan', async request => {
    const signer = auth(request);
    return chain.fundingPlan(await getTreasury(id(request)), signer, parseAmount(text(body(request.body).amount, 'Amount', 45)));
  });
  async function makeAward(data: Record<string, any>, creator: string): Promise<Award> {
    const treasury = await getTreasury(text(data.treasuryId, 'Treasury'));
    if (!treasury.signatories.includes(creator)) throw new Error('Only treasury members can create awards.');
    if (data.acceptedCommitment !== true) throw new Error('Confirm that a funded native vesting schedule cannot be cancelled by its sender.');
    chain.requireApi();
    const total = parseAmount(text(data.amount, 'Award amount', 45));
    const upfront = data.upfront === '0' ? 0n : parseAmount(text(data.upfront, 'Upfront amount', 45));
    const locked = total - upfront;
    if (locked < 0n) throw new Error('Immediate payment cannot exceed the total award.');
    if (locked > 0n && locked < BigInt(chain.state.minVestedRaw)) throw new Error('The vested portion must be at least ' + (BigInt(chain.state.minVestedRaw) / 100_000_000_000_000n) + ' tPOT. Use 100% immediate for smaller payments.');
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
      startBlock: locked > 0n ? startBlock : 0,
      ...(locked > 0n ? schedule(locked, duration, startBlock) : { perBlockRaw: '0', durationBlocks: 0, endBlock: 0 }), createdAt: new Date().toISOString(), createdBy: creator,
      createdBlock: chain.state.finalizedBlock, status: 'draft' };
    return award;
  }
  app.post('/api/awards', async request => {
    const creator = auth(request);
    // Drafts need a fresh block for scheduling, not historical receipt replay.
    await chain.refreshHead();
    const award = await makeAward(body(request.body), creator);
    await store.saveAward(award);
    return award;
  });
  app.post('/api/awards/import', async request => {
    const creator = auth(request), data = body(request.body);
    const csv = text(data.csv, 'CSV', 40_000);
    await chain.refreshHead();
    const awards = await Promise.all(readAwardCsv(csv).map(async (row, i) => {
      try {
        return await makeAward({ ...row, treasuryId: data.treasuryId, acceptedCommitment: data.acceptedCommitment,
          startDelayBlocks: Math.round(86400 / chain.state.blockSeconds),
          durationBlocks: Math.round(row.durationDays * 86400 / chain.state.blockSeconds) }, creator);
      } catch (error) { throw new Error('Row ' + (i + 2) + ': ' + (error instanceof Error ? error.message : 'Invalid award.')); }
    }));
    await store.saveAwards(awards);
    return { awards };
  });
  app.get('/api/awards/:id', async request => {
    const award = await getAward(id(request));
    const treasury = await getTreasury(award.treasuryId);
    let wallet = null, pending = null;
    if (chain.state.connected && chain.state.verified) {
      [wallet, pending] = await Promise.all([chain.wallet(award.recipient), chain.pending(treasury, award)]);
    }
    const remaining = award.status === 'funded'
      ? vestedRemaining(BigInt(award.lockedRaw), BigInt(award.perBlockRaw), award.startBlock, chain.state.finalizedBlock) : BigInt(award.lockedRaw);
    return { award, treasury, pending, wallet, remainingRaw: remaining.toString(),
      vestedRaw: (BigInt(award.lockedRaw) - remaining).toString(), receipts: await store.receipts(award.id),
      reviewRequired: Boolean(award.callHex && award.specVersion !== chain.state.specVersion) || BigInt(award.lockedRaw) > 0n && chain.state.bestBlock >= award.startBlock && award.status !== 'funded' };
  });
  app.post('/api/awards/:id/approval-plan', async request => {
    const signer = auth(request);
    const award = await getAward(id(request));
    return chain.approvalPlan(award, await getTreasury(award.treasuryId), signer);
  });
  app.post('/api/awards/:id/cancel-plan', async request => {
    const signer = auth(request), award = await getAward(id(request));
    if (award.status === 'draft') {
      if (award.createdBy !== signer) throw new Error('Only the author can discard this draft.');
      if (award.callHex) {
        await chain.synchronizeForApproval();
      }
      const latest = await getAward(award.id);
      const pending = award.callHex ? await chain.pending(await getTreasury(award.treasuryId), latest) : null;
      if (latest.status === 'draft' && !pending) {
        await store.saveAward({ ...latest, status: 'cancelled' });
        return { cancelled: true };
      }
    }
    return chain.approvalPlan(award, await getTreasury(award.treasuryId), signer, true);
  });
  app.post('/api/awards/:id/unlock-plan', async request => {
    const signer = auth(request), award = await getAward(id(request));
    if (award.status !== 'funded') throw new Error('This award has not been funded.');
    return chain.unlockPlan(award.recipient, signer);
  });
  app.get('/api/awards/:id/receipt', async (request, reply) => {
    const award = await getAward(id(request));
    reply.header('Content-Disposition', 'attachment; filename="portaflow-' + award.id + '.json"');
    return { application: 'PortaFlow', version: 1, network: NETWORK, award, treasury: await getTreasury(award.treasuryId), transactions: await store.receipts(award.id) };
  });
  app.post('/api/sync', async request => {
    auth(request);
    const transactions = body(request.body).transactions;
    if (transactions !== undefined) {
      if (!Array.isArray(transactions) || transactions.length > 5 || transactions.some(tx => !/^0x[0-9a-f]{64}$/i.test(tx?.txHash) || !/^0x[0-9a-f]{64}$/i.test(tx?.blockHash))) throw new Error('Provide up to 5 finalized transaction and block hashes.');
      const accepted = await chain.syncTransactions(transactions);
      return { network: chain.state, accepted };
    }
    await chain.refresh();
    return chain.state;
  });
  async function getRound(roundId: string) {
    const round = await store.round(roundId);
    if (!round) throw Object.assign(new Error('Payout round not found.'), { statusCode: 404 });
    return round;
  }
  app.post('/api/rounds', async request => {
    const creator = auth(request), data = body(request.body);
    await chain.refreshHead();
    const treasury = await getTreasury(text(data.treasuryId, 'Treasury'));
    if (!treasury.signatories.includes(creator)) throw new Error('Only treasury signers can create payout rounds.');
    const delay = integer(data.startDelayBlocks ?? Math.round(3600 / chain.state.blockSeconds), 'Start delay', 10, 5_000_000);
    const rows = typeof data.csv === 'string' ? readAwardCsv(data.csv).map(row => ({ ...row,
      durationBlocks: Math.round(row.durationDays * 86400 / chain.state.blockSeconds) })) : data.payments;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 25) throw new Error('A round needs between 1 and 25 payments.');
    const awards: Award[] = [];
    for (let i = 0; i < rows.length; i++) {
      try { awards.push(await makeAward({ ...body(rows[i]), treasuryId: treasury.id, startDelayBlocks: delay,
        acceptedCommitment: data.acceptedCommitment }, creator)); }
      catch (error) { throw new Error('Payment ' + (i + 1) + ': ' + (error instanceof Error ? error.message : 'Invalid payment.')); }
    }
    const round: PayoutRound = { id: randomUUID(), treasuryId: treasury.id, title: text(data.title, 'Round title', 100),
      awards, totalRaw: awards.reduce((s, a) => s + BigInt(a.totalRaw), 0n).toString(),
      upfrontRaw: awards.reduce((s, a) => s + BigInt(a.upfrontRaw), 0n).toString(),
      lockedRaw: awards.reduce((s, a) => s + BigInt(a.lockedRaw), 0n).toString(),
      createdAt: new Date().toISOString(), createdBy: creator, createdBlock: chain.state.finalizedBlock, startDelayBlocks: delay, status: 'draft' };
    await store.saveRound(round);
    return round;
  });
  app.get('/api/rounds/:id', async request => {
    const round = await getRound(id(request));
    const treasury = await getTreasury(round.treasuryId);
    return { round, treasury, pending: chain.state.connected ? await chain.pending(treasury, round) : null,
      receipts: await store.receipts(round.id), reviewRequired: Boolean(round.callHex && (round.specVersion !== chain.state.specVersion
        || round.awards.some(a => BigInt(a.lockedRaw) > 0n && chain.state.bestBlock >= a.startBlock))) && round.status !== 'funded' };
  });
  app.post('/api/rounds/:id/approval-plan', async request => {
    const round = await getRound(id(request));
    const plan = await chain.roundApprovalPlan(round, await getTreasury(round.treasuryId), auth(request));
    return { ...plan, round: await getRound(round.id) };
  });
  app.post('/api/rounds/:id/cancel-plan', async request => {
    const signer = auth(request);
    await chain.synchronizeForApproval();
    const round = await getRound(id(request));
    const treasury = await getTreasury(round.treasuryId);
    if (!treasury.signatories.includes(signer)) throw new Error('Only treasury signers can cancel this round.');
    const owner = randomUUID(), key = 'prepare-round:' + round.id;
    if (!await store.acquireLease(key, owner, 30_000)) throw new Error('Another signer is preparing this round. Try again shortly.');
    try {
      const latest = await getRound(round.id);
      if (latest.status === 'draft' && !await chain.pending(treasury, latest)) {
        if (signer !== latest.createdBy) throw new Error('Only the author can discard this draft.');
        await store.saveRound({ ...latest, status: 'cancelled' });
        return { cancelled: true };
      }
    } finally { await store.releaseLease(key, owner); }
    return chain.roundApprovalPlan(round, treasury, signer, true);
  });
  app.get('/api/rounds/:id/receipt', async (request, reply) => {
    const round = await getRound(id(request));
    reply.header('Content-Disposition', 'attachment; filename="portaflow-round-' + round.id + '.json"');
    return { application: 'PortaFlow', version: 2, network: NETWORK, round,
      treasury: await getTreasury(round.treasuryId), transactions: await store.receipts(round.id) };
  });
  app.post('/api/verify', { bodyLimit: 262_144, config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async request => {
    await chain.ready();
    return verifyReceipt(chain.requireApi(), request.body);
  });
  app.get('/api/treasuries/:id/ledger', async request => {
    const treasury = await getTreasury(id(request));
    const proposals = [...(await store.list<Award>('awards')).filter(a => a.treasuryId === treasury.id),
      ...(await store.list<PayoutRound>('rounds')).filter(r => r.treasuryId === treasury.id)];
    const receipts = (await Promise.all(proposals.map(p => store.receipts(p.id)))).flat();
    const fees = [...new Map(receipts.map(r => [r.txHash, r])).values()].reduce((sum, r) => sum + BigInt(r.feeRaw), 0n);
    const pendingDeposits: TreasuryLedger['pendingDeposits'] = [];
    for (const proposal of proposals.filter(p => p.callHash && ['draft', 'awaiting_approval'].includes(p.status))) {
      const pending = await chain.pending(treasury, proposal);
      if (pending) pendingDeposits.push({ proposalId: proposal.id, title: proposal.title,
        depositor: pending.depositor, amountRaw: pending.depositRaw });
    }
    return { wallet: await chain.wallet(treasury.address), entries: await store.ledger(treasury.id),
      coverageFromBlock: Number(await store.getMeta('ledger:from') || chain.state.finalizedBlock), syncedToBlock: chain.state.lastSyncedBlock,
      pendingRaw: proposals.filter(p => p.status === 'awaiting_approval').reduce((s, p) => s + BigInt(p.totalRaw), 0n).toString(),
      draftsRaw: proposals.filter(p => p.status === 'draft').reduce((s, p) => s + BigInt(p.totalRaw), 0n).toString(),
      fundedRaw: proposals.filter(p => p.status === 'funded').reduce((s, p) => s + BigInt(p.totalRaw), 0n).toString(),
      signerFeesRaw: fees.toString(), pendingDeposits, historyAvailable: chain.state.lastSyncedBlock >= chain.state.finalizedBlock,historyError:chain.state.historyError } satisfies TreasuryLedger;
  });
  app.get('/api/recipient/:address', async request => {
    const recipient = normalizeAddress((request.params as any).address);
    const treasuries = await store.list<Treasury>('treasuries');
    const awards: (Award & { roundId?: string; treasuryName: string })[] = [
      ...(await store.list<Award>('awards')).filter(a => a.recipient === recipient && a.status === 'funded')
        .map(a => ({ ...a, treasuryName: treasuries.find(t => t.id === a.treasuryId)?.name || 'Treasury' })),
      ...(await store.list<PayoutRound>('rounds')).filter(r => r.status === 'funded').flatMap(r => r.awards.filter(a => a.recipient === recipient)
        .map(a => ({ ...a, status: r.status, fundingTx: r.fundingTx, fundingBlock: r.fundingBlock, roundId: r.id,
          treasuryName: treasuries.find(t => t.id === r.treasuryId)?.name || 'Treasury' }))),
    ];
    return { address: recipient, wallet: await chain.wallet(recipient), awards,
      totalFundedRaw: awards.reduce((s, a) => s + BigInt(a.totalRaw), 0n).toString(),
      totalImmediateRaw: awards.reduce((s, a) => s + BigInt(a.upfrontRaw), 0n).toString(),
      totalVestedRaw: awards.reduce((s, a) => s + BigInt(a.lockedRaw), 0n).toString() };
  });
  app.post('/api/recipient/:address/unlock-plan', async request => chain.unlockPlan(normalizeAddress((request.params as any).address), auth(request)));
  if (options.serverless && options.connect !== false) {
    app.addHook('preHandler', async request => {
      const path = request.url.split('?')[0];
      if (path === '/api/health' || path.startsWith('/api/auth/') || path === '/api/treasuries' || path.endsWith('/receipt')) return;
      try {
        await chain.ready();
        if (path === '/api/overview') await chain.refresh();
      } catch (error) {
        chain.state.connected = Boolean(chain.api?.isConnected);
        chain.state.error = 'Portaldot synchronization is temporarily unavailable. Please retry.';
        if (path !== '/api/overview') throw error;
      }
    });
  }
  if (options.serve !== false && existsSync(resolve('dist/index.html'))) {
    const { default: staticFiles } = await import('@fastify/static');
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
  if (options.connect !== false && !options.serverless) void connect();
  app.addHook('onClose', async () => { closing = true; if (reconnect) clearTimeout(reconnect); await chain.close(); await store.close(); });
  return { app, store, chain };
}
