import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { zeroAddress, zeroHash, type Hex } from 'viem';
import { NETWORK, type Treasury } from '../shared/types.js';
import { normalizeAddress } from '../shared/accounts.js';
import { invoiceId, invoiceTermsHash, verifyInvoiceSignature, parseAssetAmount, formatAssetAmount, sameAsset, type Invoice, type InvoiceBatch, type InvoiceInput } from '../shared/invoices.js';
import type { DataStore } from './store.js';
import type { Chain } from './chain.js';
import { InvoiceChain } from './invoice-chain.js';
import artifact from '../contracts/artifacts/InvoiceSettlement.json' with { type: 'json' };
import { recoverInvoiceSettlements } from '../shared/invoice-history.js';
import {registerSettlementDeployment} from './settlement-deployment.js';

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const text = (v: unknown, label: string, max = 100) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw fail('Provide ' + label + ' (up to ' + max + ' characters).'); return v.trim(); };
const body = (v: unknown): Record<string, any> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('Provide a JSON object.'); return v as Record<string, any>; };
const digest = (value: string) => createHash('sha256').update(value).digest();

export function registerInvoiceRoutes(app: FastifyInstance, { store, chain, settlement, auth }: {
  store: DataStore; chain: Chain; settlement: InvoiceChain; auth: (request: any) => string;
}) {
  async function treasury(id: string) { const t = await store.treasury(id); if (!t) throw fail('Treasury not found.', 404); return t; }
  const member = (t: Treasury, address: string) => { if (!t.signatories.includes(address)) throw fail('Only treasury signers can manage these payments.', 403); };
  async function invoice(id: string) { const i = await store.invoice(id); if (!i) throw fail('Invoice not found.', 404); return i; }
  async function batch(id: string) { const b = await store.invoiceBatch(id); if (!b) throw fail('Payment batch not found.', 404); return b; }
  async function selected(data: any, address: string) {
    const t = await treasury(text(data.treasuryId, 'treasury')); member(t, address);
    if (!Array.isArray(data.invoiceIds) || !data.invoiceIds.length || data.invoiceIds.length > 25 || new Set(data.invoiceIds).size !== data.invoiceIds.length) throw fail('Select 1–25 different invoices.');
    const invoices = await Promise.all(data.invoiceIds.map((id: string) => invoice(id)));
    if (invoices.some(i => i.treasuryId !== t.id || i.status !== 'submitted')) throw fail('Select submitted invoices from this treasury.');
    const existing = await store.list<InvoiceBatch>('invoice_batches');
    if (existing.some(b => ['draft', 'awaiting_approval'].includes(b.status) && b.invoices.some(i => invoices.some(j => j.id === i.id)))) throw fail('An invoice already belongs to an open payment batch.', 409);
    if (invoices.some(i => !sameAsset(i.asset, invoices[0].asset))) throw fail('Create a separate batch for each payment asset.');
    return { t, invoices };
  }
  async function makeInvoice(input: InvoiceInput, issuer: string, createdAt: string): Promise<Invoice> {
    const t = await treasury(text(input.treasuryId, 'treasury'));
    if (normalizeAddress(input.recipient) !== issuer) throw fail('An invoice must pay the contributor who signs it.');
    if (issuer === t.address) throw fail('A treasury cannot invoice itself.');
    const asset = await settlement.asset(input.assetId), amountRaw = parseAssetAmount(text(input.amount, 'amount', 60), asset.decimals).toString();
    let workUrl = input.workUrl?.trim() || '';
    if (workUrl) { const u = new URL(workUrl); if (u.protocol !== 'https:' || workUrl.length > 500 || u.username || u.password) throw fail('Use a public HTTPS contribution reference.'); workUrl = u.href; }
    if (typeof input.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || !Number.isFinite(Date.parse(input.dueDate)) || new Date(input.dueDate).toISOString().slice(0,10) !== input.dueDate) throw fail('Provide a valid payment due date.');
    if (!Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) > Date.now() + 300_000) throw fail('Invalid invoice creation time.');
    const number = text(input.number, 'invoice number', 40).toUpperCase();
    const result: Invoice = { id: invoiceId(t.address, issuer, number), number, title: text(input.title, 'contribution title'), treasuryId: t.id,
      treasuryAddress: t.address, issuer, recipient: issuer, asset, amountRaw, workUrl, dueDate: input.dueDate,
      createdAt, termsHash: zeroHash, signature: '0x', status: 'submitted' };
    result.termsHash = invoiceTermsHash(result); return result;
  }
  app.get('/api/payment-assets/:assetId', async request => settlement.asset((request.params as any).assetId));
  app.get('/api/settlement', async () => settlement.status());
  app.post('/api/settlement/history',async request=>{
    const address=auth(request),data=body(request.body),t=await treasury(text(data.treasuryId,'treasury'));member(t,address);
    const router=await settlement.verified(),maps=await settlement.mappings([t.address]);
    const fromBlock=data.fromBlock;
    const report=await recoverInvoiceSettlements(chain.requireApi(),{router,payer:maps[0].address,fromBlock,limit:24});
    // Replay only known local proposals; the returned public ledger also works with an empty app store.
    const transactions=[...new Map(report.entries.map(e=>[e.txHash,{txHash:e.txHash,blockHash:e.blockHash}])).values()];
    if(transactions.length)await chain.syncTransactions(transactions);
    return report;
  });
  app.post('/api/settlement/deployment-plan', async request => {
    const signer=auth(request), t=await treasury(text(body(request.body).treasuryId,'treasury')); member(t,signer);
    const status=await settlement.status();
    if (status.configured) throw fail('Settlement is already configured. Refresh the page.');
    if (status.pendingDeployment) throw fail('A finalized deployment is already saved. Recover its registration instead of deploying again.',409);
    await chain.ready(); await chain.refreshHead(); const api=chain.requireApi();
    const simulation:any=await (api.call as any).reviveApi.instantiate(signer,'0',null,null,{Upload:artifact.bytecode},'0x',null);
    if(simulation.result.isErr){const e=simulation.result.asErr;const message=e.isModule?api.registry.findMetaError(e.asModule):undefined;
      throw fail(message?.name==='StorageDepositNotEnoughFunds'?'This wallet needs more tPOT for the contract deployment storage deposit. No transaction was submitted.':message?.name==='AccountUnmapped'?'Enable this signing account for contract payments before deploying.':(message?message.section+'.'+message.name:e.toString()));}
    const required=simulation.weightRequired??simulation.gasRequired,margin=(v:any)=>((BigInt(v.toString())*12n+9n)/10n).toString();
    const weight={refTime:margin(required.refTime),proofSize:margin(required.proofSize)},deposit=simulation.maxStorageDeposit??simulation.storageDeposit;
    const storageDepositRaw=deposit.isCharge?margin(deposit.asCharge):'0';
    const plan=await chain.estimate(api.tx.revive.instantiateWithCode('0',weight,storageDepositRaw,artifact.bytecode,'0x',null),signer,'settlement deployment');
    if(BigInt((await chain.wallet(signer)).spendableRaw)<BigInt(storageDepositRaw)+BigInt(plan.feeRaw))throw fail('This wallet cannot cover the estimated deployment storage deposit and fee.');
    return {...plan,storageDepositRaw};
  });
  app.post('/api/settlement/register', async request => {
    const signer=auth(request),data=body(request.body);
    return registerSettlementDeployment({store,chain,settlement},signer,{treasuryId:text(data.treasuryId,'treasury'),txHash:text(data.txHash,'transaction hash'),blockHash:text(data.blockHash,'block hash')});
  });
  app.get('/api/invoices', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const address = (request as any).walletAddress as string, query = request.query as { treasuryId?: string; personal?: string };
    const ts = await store.list<Treasury>('treasuries'), mine = new Set(ts.filter(t => t.signatories.includes(address)).map(t => t.id));
    const invoices = (await store.list<Invoice>('invoices')).filter(i => (i.issuer === address || mine.has(i.treasuryId))
      && (!query.treasuryId || i.treasuryId === query.treasuryId) && (query.personal !== 'true' || i.issuer === address));
    const batches = (await store.list<InvoiceBatch>('invoice_batches')).filter(b => mine.has(b.treasuryId) && (!query.treasuryId || b.treasuryId === query.treasuryId));
    return { invoices, batches, settlement: await settlement.status() };
  });
  app.get('/api/invoices/export', async (request,reply)=>{
    const address=auth(request),query=request.query as {treasuryId?:string;personal?:string},ts=await store.list<Treasury>('treasuries');
    const mine=new Set(ts.filter(t=>t.signatories.includes(address)).map(t=>t.id));
    const invoices=(await store.list<Invoice>('invoices')).filter(i=>(i.issuer===address||mine.has(i.treasuryId))&&(!query.treasuryId||i.treasuryId===query.treasuryId)&&(query.personal!=='true'||i.issuer===address));
    const batches=await store.list<InvoiceBatch>('invoice_batches');
    const cell=(v:string)=>'"'+(/^[\s]*[=+@-]/.test(v)?"'"+v:v).replaceAll('"','""')+'"';
    const rows=[['Invoice','Contribution','Treasury','Recipient','Asset','Asset ID','Amount','Status','Due','Funding transaction','Terms hash'],
      ...invoices.map(i=>[i.number,i.title,ts.find(t=>t.id===i.treasuryId)?.name||i.treasuryId,i.recipient,i.asset.symbol,i.asset.id||'native',formatAssetAmount(i.amountRaw,i.asset.decimals),i.status,i.dueDate,batches.find(b=>b.id===i.batchId)?.fundingTx||'',i.termsHash])];
    reply.header('Cache-Control','private, no-store').header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="portaflow-invoices.csv"');
    return rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
  });
  app.post('/api/invoices/prepare', async request => {
    const result = await makeInvoice(body(request.body) as InvoiceInput, auth(request), new Date().toISOString());
    if (await store.invoice(result.id)) throw fail('This invoice number already exists for this contributor and treasury. Use its existing request.', 409);
    return result;
  });
  app.post('/api/invoices', async request => {
    const address = auth(request), data = body(request.body);
    const i = await makeInvoice({ ...data, amount: data.amount, assetId: data.assetId } as InvoiceInput, address, text(data.createdAt, 'creation time'));
    i.signature = text(data.signature, 'contributor signature', 200) as Hex;
    if (data.termsHash !== i.termsHash || data.id !== i.id || !verifyInvoiceSignature(i)) throw fail('The signed invoice does not match these payment terms.');
    const owner = randomUUID(), lease = 'invoice:' + i.id;
    if (!await store.acquireLease(lease, owner, 15_000)) throw fail('This invoice is being submitted. Retry shortly.', 409);
    try { if (await store.invoice(i.id)) throw fail('This invoice has already been submitted.', 409); await store.saveInvoice(i); }
    finally { await store.releaseLease(lease, owner); }
    return i;
  });
  app.get('/api/invoices/:id', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const i = await invoice((request.params as any).id), t = await treasury(i.treasuryId), address = (request as any).walletAddress;
    const token = (request.query as { share?: string }).share;
    const stored = token && /^[a-f0-9]{64}$/.test(token) ? await store.getMeta('invoice-share:' + i.id) : undefined;
    const shared = Boolean(stored && timingSafeEqual(Buffer.from(stored, 'hex'), digest(token!)));
    if (address !== i.issuer && !t.signatories.includes(address) && !shared) throw fail('Connect the contributor or a treasury signer to view this invoice.', 403);
    const payment=i.batchId?await store.invoiceBatch(i.batchId):undefined;
    return { invoice: i, treasury: { id: t.id, name: t.name, address: t.address }, shared, signatureVerified: verifyInvoiceSignature(i),
      payment:payment?.status==='paid'?{txHash:payment.fundingTx,blockNumber:payment.fundingBlock,router:payment.router}:undefined };
  });
  app.post('/api/invoices/:id/share', async request => {
    const address = auth(request), i = await invoice((request.params as any).id), t = await treasury(i.treasuryId);
    if (address !== i.issuer && !t.signatories.includes(address)) throw fail('Only the contributor or treasury can share this invoice.', 403);
    const previous=await store.getMeta('invoice-share-token:'+i.id);
    const token = previous && body(request.body).rotate!==true ? previous : randomBytes(32).toString('hex');
    await store.setMeta('invoice-share:' + i.id, digest(token).toString('hex')); await store.setMeta('invoice-share-token:'+i.id,token);
    return { path: '/invoices/' + i.id + '?share=' + token };
  });
  app.post('/api/invoices/:id/decline', async request => {
    const address = auth(request), i = await invoice((request.params as any).id), t = await treasury(i.treasuryId); member(t, address);
    const owner=randomUUID(),lease='invoice-batch:'+t.id;
    if(!await store.acquireLease(lease,owner,90000))throw fail('Another signer is preparing payments. Retry shortly.',409);
    try{const latest=await invoice(i.id);
      const active = (await store.list<InvoiceBatch>('invoice_batches')).some(b => ['draft', 'awaiting_approval', 'paid'].includes(b.status) && b.invoices.some(v => v.id === i.id));
      if (latest.status !== 'submitted' || active) throw fail('Only an unbatched submitted invoice can be declined.');
      const result = { ...latest, status: 'declined' as const, declineReason: text(body(request.body).reason, 'a decline reason', 300) };
      await store.saveInvoice(result); return result;
    }finally{await store.releaseLease(lease,owner);}
  });
  app.post('/api/invoice-batches/mapping-plan', async request => {
    const address = auth(request), { t, invoices } = await selected(body(request.body), address);
    return settlement.mappingPlan([t.address, ...invoices.map(i => i.recipient)], address);
  });
  app.post('/api/invoice-batches', async request => {
    const address = auth(request), data = body(request.body), owner = randomUUID(), lease = 'invoice-batch:' + text(data.treasuryId, 'treasury');
    if (!await store.acquireLease(lease, owner, 90_000)) throw fail('Another signer is preparing invoices. Retry shortly.', 409);
    try {
      const { t, invoices } = await selected(data, address);
      const draft: InvoiceBatch = { id: randomUUID(), title: text(data.title, 'batch title'), treasuryId: t.id, invoices,
        asset: invoices[0].asset, totalRaw: invoices.reduce((n, i) => n + BigInt(i.amountRaw), 0n).toString(), createdAt: new Date().toISOString(), createdBy: address,
        status: 'draft', router: zeroAddress, runtimeCodeHash: zeroHash, payer: zeroAddress, recipients: [], specVersion: 0, callHex: '', callHash: '', weight: { refTime: '0', proofSize: '0' }, storageDepositRaw: '0' };
      const result = await settlement.prepare(draft, t);
      await store.saveInvoiceBatch(result);
      for (const i of invoices) await store.saveInvoice({ ...i, status: 'awaiting_approval', batchId: result.id });
      return result;
    } finally { await store.releaseLease(lease, owner); }
  });
  app.get('/api/invoice-batches/:id', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const b = await batch((request.params as any).id), t = await treasury(b.treasuryId); member(t, auth(request));
    await chain.ready(); await chain.refreshHead();
    const paid = await settlement.paid(b);
    if (paid.every((value, n) => value === b.invoices[n].termsHash) && b.status !== 'paid') {
      b.status = 'paid'; await store.saveInvoiceBatch(b);
      for (const i of b.invoices) await store.saveInvoice({ ...i, status: 'paid', batchId: b.id });
    }
    return { batch: b, treasury: t, pending: await chain.pending(t, b), receipts: await store.receipts(b.id), reviewRequired: b.specVersion !== chain.state.specVersion };
  });
  for (const cancel of [false, true]) app.post('/api/invoice-batches/:id/' + (cancel ? 'cancel-plan' : 'approval-plan'), async request => {
    const b = await batch((request.params as any).id), t = await treasury(b.treasuryId), address = auth(request); member(t, address);
    if (cancel) {
      await chain.ready(); const pending = await chain.pending(t, b);
      if (!pending) {
        if (b.status !== 'draft' || b.createdBy !== address || (await settlement.paid(b)).some(value => value !== zeroHash)) throw fail('Only the author can discard an unsubmitted, unpaid batch.');
        b.status = 'cancelled'; await store.saveInvoiceBatch(b);
        for (const i of b.invoices) if ((await store.invoice(i.id))?.batchId === b.id) await store.saveInvoice({ ...i, status: 'submitted', batchId: undefined });
        return { cancelled: true };
      }
    }
    return { plan: await settlement.approvalPlan(b, t, address, cancel), invoiceBatch: b, treasury: t };
  });
  app.get('/api/invoice-batches/:id/receipt', async (request, reply) => {
    const b = await batch((request.params as any).id), t = await treasury(b.treasuryId); member(t, auth(request));
    reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'attachment; filename="portaflow-invoices-' + b.id + '.json"');
    return { application: 'PortaFlow', version: 3, network: NETWORK, treasury: t, batch: b, transactions: await store.receipts(b.id) };
  });
}
