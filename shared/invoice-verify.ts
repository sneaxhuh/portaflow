import type { ApiPromise } from '@polkadot/api';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { type Hex } from 'viem';
import { treasuryIdentity, normalizeAddress } from './accounts.js';
import { NETWORK, type Verification } from './types.js';
import { NATIVE_ASSET, batchPayments, invoiceBatchCalls, sameAsset, type InvoiceReceipt } from './invoices.js';
import { hasInvoiceSettlement } from './invoice-events.js';
import code from './settlement-code.json' with { type: 'json' };
import { matchesRuntimeCode } from './runtime-code.js';

class Invalid extends Error {}
export async function verifyInvoiceReceipt(api: ApiPromise, value: unknown): Promise<Verification> {
  const result: Verification = { status: 'invalid', subject: 'Invoice payment batch', checks: [] };
  const check = (label: string, passed: boolean, detail: string) => { result.checks.push({ label, passed, detail }); if (!passed) throw new Invalid(detail); };
  try {
    const document = value as InvoiceReceipt;
    check('Invoice receipt format', Boolean(document && document.application === 'PortaFlow' && document.version === 3 && document.batch && document.treasury
      && Array.isArray(document.transactions) && document.transactions.length <= 100), 'A version 3 invoice receipt is required.');
    const batch = document.batch, treasury = document.treasury;
    result.subject = String(batch.title).slice(0,100);
    check('Portaldot network', document.network?.genesis === NETWORK.genesis && api.genesisHash.toHex() === NETWORK.genesis, 'Receipt and RPC must match the pinned Portaldot testnet.');
    const identity = treasuryIdentity(treasury.signatories, treasury.threshold);
    check('Treasury ownership', identity.address === treasury.address && identity.signatories.every((s,i)=>s === treasury.signatories[i]), 'Signer policy must derive the stated treasury.');
    let payments: ReturnType<typeof batchPayments> = [];
    try { payments=batchPayments(batch); } catch { check('Contributor signatures and exact totals',false,'The invoice manifest, contributor signatures, or totals are invalid.'); }
    check('Contributor signatures and exact totals', payments.length > 0 && batch.invoices.every(i=>i.treasuryAddress === treasury.address)
      && (batch.asset.kind === 'asset' || sameAsset(batch.asset, NATIVE_ASSET)), 'Every invoice must have an authentic contributor signature and internally consistent asset amounts.');
    check('Reviewed settlement code', batch.runtimeCodeHash === code.runtimeCodeHash, 'The receipt must use this verifier’s reviewed settlement implementation.');
    const references = document.transactions.filter(r=>r.kind === 'funding');
    check('Funding reference', references.length === 1 && references[0].txHash === batch.fundingTx && references[0].blockNumber === batch.fundingBlock
      && /^0x[0-9a-f]{64}$/i.test(references[0].blockHash) && /^0x[0-9a-f]{64}$/i.test(references[0].txHash), 'Exactly one matching funding transaction is required.');
    const receipt = references[0]; result.txHash = receipt.txHash; result.blockNumber = receipt.blockNumber;
    const [hash, headHash] = await Promise.all([api.rpc.chain.getBlockHash(receipt.blockNumber),api.rpc.chain.getFinalizedHead()]);
    const head = await api.rpc.chain.getHeader(headHash);
    check('Canonical finality', hash.toHex() === receipt.blockHash && head.number.toNumber() >= receipt.blockNumber, 'Funding must belong to the canonical finalized native chain.');
    const at = await api.at(hash), block = await api.rpc.chain.getBlock(hash), metadata = await api.rpc.state.getMetadata(hash);
    const runtimeCode: any = await (at.call as any).reviveApi.code(batch.router);
    check('Deployed bytecode', matchesRuntimeCode(runtimeCode.toHex() as Hex,code.runtimeCodeHash as Hex), 'Contract code at the funding block must match the compiled settlement bytecode.');
    const mappedPayer = (await (at.call as any).reviveApi.address(treasury.address)).toString();
    check('Treasury account mapping', mappedPayer.toLowerCase() === batch.payer.toLowerCase()
      && normalizeAddress((await (at.call as any).reviveApi.accountId(batch.payer)).toString()) === treasury.address, 'The contract payer must resolve to this native multisig treasury.');
    for (let i=0;i<batch.invoices.length;i++) check('Recipient mapping ' + (i+1), normalizeAddress((await (at.call as any).reviveApi.accountId(batch.recipients[i])).toString()) === batch.invoices[i].recipient, 'The EVM recipient must resolve to the invoice’s native recipient.');
    if (batch.asset.kind === 'asset') {
      const id = batch.asset.id;
      check('Native asset identity', typeof id === 'string' && /^(0|[1-9]\d{0,9})$/.test(id) && BigInt(id) <= 0xffff_ffffn
        && batch.asset.token.toLowerCase() === '0x' + Number(id).toString(16).padStart(8,'0') + '00000000000000000000000000010000', 'Asset token must be the corresponding Portaldot native-asset precompile.');
      const m: any = await at.query.assets.metadata(id!);
      check('Asset precision', Number(m.decimals.toString()) === batch.asset.decimals, 'Receipt precision must match historical native asset metadata.');
    }
    const index = block.block.extrinsics.findIndex(tx=>tx.hash.toHex() === receipt.txHash);
    check('Transaction inclusion', index >= 0, 'The funding transaction must exist in the referenced block.');
    const tx = at.registry.createType('Extrinsic',block.block.extrinsics[index].toHex()), method: any = tx.method;
    const factories = decorateExtrinsics(at.registry,at.registry.metadata,metadata.version);
    const historical = { tx: Object.fromEntries(Object.entries(factories).map(([section,methods])=>[section,Object.fromEntries(Object.entries(methods).map(([name,factory])=>[name,(...args: unknown[])=>at.tx(factory(...args))]))])) } as unknown as ApiPromise;
    const expected = invoiceBatchCalls(historical,batch,treasury);
    check('Exact multisig payment', method.section === 'multisig' && method.method === 'asMulti' && Number(method.args[0].toString()) === treasury.threshold
      && method.args[3].toHex() === expected.method.toHex() && expected.method.toHex() === batch.callHex && expected.method.hash.toHex() === batch.callHash,
      'The approved call must contain exactly these invoice payments, bounded allowances, and contract limits.');
    const signer = normalizeAddress(tx.signer.toString()), others: string[] = method.args[1].map((a: any)=>normalizeAddress(a.toString()));
    check('Executing signers', treasury.signatories.includes(signer) && JSON.stringify(others) === JSON.stringify(treasury.signatories.filter(s=>s!==signer)), 'The executing account and other signatories must match the treasury policy.');
    const records: any = await at.query.system.events();
    const events: any[] = records.filter((r: any)=>r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index).map((r: any)=>r.event);
    const execution = events.find(e=>e.section==='multisig' && e.method==='MultisigExecuted' && e.data[3].toHex()===batch.callHash && normalizeAddress(e.data[2].toString())===treasury.address);
    check('Successful atomic execution', Boolean(execution?.data[4].isOk) && events.some(e=>e.section==='utility' && e.method==='BatchCompleted')
      && events.some(e=>e.section==='system' && e.method==='ExtrinsicSuccess') && !events.some(e=>e.method==='ExtrinsicFailed'||e.method==='BatchInterrupted'), 'Both native multisig dispatch and the entire batch must succeed.');
    check('Contract settlement evidence', hasInvoiceSettlement(events,batch), 'The reviewed contract must emit one exact settlement for every signed invoice and the complete batch.');
    const routerNative = normalizeAddress((await (at.call as any).reviveApi.accountId(batch.router)).toString());
    const targets = [...new Set(batch.invoices.map(i=>i.recipient))];
    for (const target of targets) {
      const expectedRaw = batch.invoices.filter(i=>i.recipient===target).reduce((n,i)=>n+BigInt(i.amountRaw),0n);
      const transferred = events.reduce((sum,e)=> {
        if (batch.asset.kind==='native' && e.section==='balances' && e.method==='Transfer'
          && normalizeAddress(e.data[0].toString())===routerNative && normalizeAddress(e.data[1].toString())===target) return sum+BigInt(e.data[2].toString());
        if (batch.asset.kind==='asset' && e.section==='assets' && e.method==='Transferred' && e.data[0].toString()===batch.asset.id
          && normalizeAddress(e.data[1].toString())===treasury.address && normalizeAddress(e.data[2].toString())===target) return sum+BigInt(e.data[3].toString());
        return sum;
      },0n);
      check('Recipient transfer ' + target.slice(0,8), transferred===expectedRaw, 'Native ledger transfer totals must match the signed invoices exactly.');
    }
    result.status='verified';
  } catch(error) {
    if (!(error instanceof Invalid)) { result.status='unavailable'; result.checks.push({label:'Verification availability',passed:false,detail:'Required chain data is unavailable or the invoice receipt is malformed. No payment has been certified.'}); }
  }
  return result;
}
