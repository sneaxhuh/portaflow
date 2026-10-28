import { createPublicClient, http, keccak256, encodeFunctionData, zeroHash, type Address, type Hex } from 'viem';
import { hexToString } from '@polkadot/util';
import { NETWORK, type Treasury, type TransactionPlan } from '../shared/types.js';
import { NATIVE_ASSET, batchPayments, invoiceBatchCalls, invoiceStorageLimit, formatAssetAmount, sameAsset, type Invoice, type InvoiceBatch, type PaymentAsset, type SettlementStatus } from '../shared/invoices.js';
import { settlementAbi, invoiceTokenAbi } from '../shared/settlement-abi.js';
import code from '../shared/settlement-code.json' with { type: 'json' };
import type { Chain } from './chain.js';
import {pendingSettlementDeployment} from './settlement-deployment.js';

const asAddress = (value: string) => {
  if (!/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new Error('Configure a valid settlement contract address.');
  return value.toLowerCase() as Address;
};
const bump = (n: string) => ((BigInt(n) * 12n + 9n) / 10n).toString();
// Runtime versions expose ReturnFlags either as a number codec or a struct containing bits.
export const reviveCallReverted = (flags: {bits?: {toString(): string};toString(): string}) =>
  (BigInt((flags.bits ?? flags).toString()) & 1n) !== 0n;

export class InvoiceChain {
  client = createPublicClient({ transport: http(process.env.PORTAFLOW_EVM_RPC || 'https://test-evm-rpc-v3.portaldot.dev', { timeout: 10_000, retryCount: 0 }) });
  constructor(public chain: Chain, public address = process.env.PORTAFLOW_SETTLEMENT_ADDRESS || '') {}
  async snapshot() {
    await this.chain.ready(); await this.chain.refreshHead();
    const api = this.chain.requireApi(), hash = await api.rpc.chain.getBlockHash(this.chain.state.finalizedBlock);
    if(api.consts.revive.nativeToEthRatio.toString()!=='10000')throw new Error('The native/EVM unit conversion changed. Settlement must be reviewed before continuing.');
    return { api, at: await api.at(hash), block: BigInt(this.chain.state.finalizedBlock) };
  }
  async status(): Promise<SettlementStatus> {
    if (!this.address) this.address = await this.chain.store.getMeta('invoice:settlement:address') || '';
    const base = { configured: Boolean(this.address), verified: false, runtimeCodeHash: code.runtimeCodeHash as Hex };
    if (!this.address) {
      const pendingDeployment=await pendingSettlementDeployment(this.chain.store);
      return { ...base,pendingDeployment,error:pendingDeployment?'A contract was deployed and awaits registration. Recover that deployment; no new wallet transaction is needed.':'Invoice payments have not been enabled on this installation. Requests can still be submitted.' };
    }
    try {
      const address = asAddress(this.address), { block } = await this.snapshot();
      if (await this.client.getChainId() !== 420420777) throw new Error('EVM RPC is on a different chain.');
      const bytecode = await this.client.getCode({ address, blockNumber: block });
      if (!bytecode || keccak256(bytecode) !== code.runtimeCodeHash) throw new Error('Settlement contract does not match the reviewed PortaFlow code.');
      return { ...base, address, verified: true };
    } catch (error) { return { ...base, error: error instanceof Error ? error.message : 'Settlement verification is unavailable.' }; }
  }
  async verified() {
    const status = await this.status();
    if (!status.verified || !status.address) throw Object.assign(new Error(status.error || 'Settlement contract is unavailable.'), { statusCode: 503 });
    return status.address;
  }
  async asset(id?: string): Promise<PaymentAsset> {
    if (id === undefined || id === '' || id === 'native') return { ...NATIVE_ASSET };
    if (!/^(0|[1-9]\d{0,9})$/.test(id) || BigInt(id) > 0xffff_ffffn) throw new Error('Use a native asset ID between 0 and 4294967295.');
    const { at } = await this.snapshot();
    const info: any = await at.query.assets.asset(id);
    if (info.isNone || info.unwrap().status.toString() !== 'Live') throw new Error('This native asset is not available for payments.');
    const metadata: any = await at.query.assets.metadata(id);
    const symbol = hexToString(metadata.symbol.toHex());
    const decimals = Number(metadata.decimals.toString());
    if (!symbol || symbol.length > 20 || decimals > 18) throw new Error('This asset does not have supported payment metadata.');
    const token = ('0x' + Number(id).toString(16).padStart(8, '0') + '00000000000000000000000000010000') as Address;
    return { kind: 'asset', id, symbol, decimals, token };
  }
  async mappings(addresses: string[]) {
    const { at } = await this.snapshot();
    return Promise.all([...new Set(addresses)].map(async native => {
      const address = (await (at.call as any).reviveApi.address(native)).toString() as Address;
      const reverse = (await (at.call as any).reviveApi.accountId(address)).toString();
      return { native, address, mapped: reverse === native };
    }));
  }
  async mappingPlan(addresses: string[], signer: string) {
    const missing = (await this.mappings(addresses)).filter(a => !a.mapped).map(a => a.native);
    if (!missing.length) return { mapped: true as const };
    const api = this.chain.requireApi();
    if (!api.tx.revive?.batchMapAccounts) throw new Error('Batch account mapping is unavailable on this runtime.');
    return { mapped: false as const, addresses: missing, plan: await this.chain.estimate(api.tx.revive.batchMapAccounts(missing), signer, 'invoice mapping') };
  }
  async paid(batch: InvoiceBatch) {
    await this.verified();
    if (batch.router.toLowerCase() !== this.address.toLowerCase() || batch.runtimeCodeHash !== code.runtimeCodeHash) throw new Error('This batch targets a different settlement installation.');
    const { block } = await this.snapshot();
    return Promise.all(batch.invoices.map(invoice => this.client.readContract({ address: batch.router, abi: settlementAbi,
      functionName: 'settled', args: [batch.payer, invoice.id], blockNumber: block })));
  }
  async prepare(batch: InvoiceBatch, treasury: Treasury): Promise<InvoiceBatch> {
    const router = await this.verified(), { api, at, block } = await this.snapshot();
    const asset = await this.asset(batch.asset.id);
    if (!sameAsset(asset, batch.asset)) throw new Error('Asset metadata changed. Submit a new invoice before requesting signatures.');
    const mappings = await this.mappings([treasury.address, ...batch.invoices.map(i => i.recipient)]);
    if (mappings.some(m => !m.mapped)) throw new Error('Enable contract payments for the selected accounts before preparing this batch.');
    batch = { ...batch, router, runtimeCodeHash: code.runtimeCodeHash as Hex, payer: mappings.find(m => m.native === treasury.address)!.address,
      recipients: batch.invoices.map(i => mappings.find(m => m.native === i.recipient)!.address), specVersion: this.chain.state.specVersion };
    const settled = await this.paid(batch);
    if (settled.some(s => s !== zeroHash)) throw new Error('An invoice in this batch is already settled on-chain. Remove it before preparing payment.');
    const wallet = await this.chain.wallet(treasury.address);
    if(asset.kind==='native'&&BigInt(wallet.spendableRaw)<BigInt(batch.totalRaw))throw new Error(
      'Fund the treasury first: it has '+formatAssetAmount(wallet.spendableRaw,NETWORK.decimals)+' '+NETWORK.symbol+' spendable, but these invoices need '+formatAssetAmount(batch.totalRaw,NETWORK.decimals)+' '+NETWORK.symbol+' plus contract storage deposits. The account minimum is excluded from spendable funds. No payment was submitted.');
    const max: any = (api.consts.system.blockWeights as any).maxBlock;
    // Three calls for an asset batch must fit in a single block, with a 25% reserve.
    batch.weight = { refTime: (BigInt(max.refTime.toString()) / 6n).toString(), proofSize: (BigInt(max.proofSize.toString()) / 6n).toString() };
    batch.storageDepositRaw = (BigInt(api.consts.revive.depositPerChildTrieItem.toString()) * BigInt(batch.invoices.length + 2)
      + BigInt(api.consts.revive.depositPerByte.toString()) * BigInt((batch.invoices.length + 2) * 64)).toString();
    if (asset.kind === 'native') {
      const data = encodeFunctionData({ abi: settlementAbi, functionName: 'settle', args: [asset.token, batchPayments(batch)] });
      const result: any = await (at.call as any).reviveApi.call(treasury.address, router, batch.totalRaw, null, null, data);
      if(result.result.isErr){
        const error=result.result.asErr,reason=error.isModule?api.registry.findMetaError(error.asModule):undefined;
        throw new Error('Native settlement simulation failed ('+(reason?reason.section+'.'+reason.name:error.toString())+'). Check treasury funds and contract storage deposits. No payment was submitted.');
      }
      if(reviveCallReverted(result.result.asOk.flags))throw new Error('The settlement contract rejected this payment during simulation. No payment was submitted.');
      const required = result.weightRequired ?? result.gasRequired;
      batch.weight = { refTime: bump(required.refTime.toString()), proofSize: bump(required.proofSize.toString()) };
      const deposit = result.storageDeposit;
      batch.storageDepositRaw = deposit.isCharge ? bump(deposit.asCharge.toString()) : '0';
    } else {
      const balance = await this.client.readContract({ address: asset.token, abi: invoiceTokenAbi, functionName: 'balanceOf', args: [batch.payer], blockNumber: block });
      if (balance < BigInt(batch.totalRaw)) throw new Error('The treasury does not hold enough of this payment asset.');
      let approvalStorage=0n;
      for(const amount of [0n,BigInt(batch.totalRaw)]){
        const input=encodeFunctionData({abi:invoiceTokenAbi,functionName:'approve',args:[router,amount]});
        const simulation:any=await (at.call as any).reviveApi.call(treasury.address,asset.token,'0',null,null,input);
        if(simulation.result.isErr||reviveCallReverted(simulation.result.asOk.flags))throw new Error('Asset approval simulation failed. This asset cannot be paid through this installation.');
        const deposit=simulation.maxStorageDeposit??simulation.storageDeposit;
        if(deposit.isCharge&&BigInt(deposit.asCharge.toString())>approvalStorage)approvalStorage=BigInt(deposit.asCharge.toString());
      }
      batch.approvalStorageDepositRaw=bump(approvalStorage.toString());
      // The exact approvals execute before settlement in the atomic native batch.
      // A standalone settle simulation cannot see those not-yet-created allowances.
    }
    const nativeNeeded = (asset.kind === 'native' ? BigInt(batch.totalRaw) : 0n) + BigInt(invoiceStorageLimit(batch));
    if (BigInt(wallet.spendableRaw) < nativeNeeded) throw new Error('Fund the treasury: this batch needs '+formatAssetAmount(nativeNeeded.toString(),NETWORK.decimals)+' '+NETWORK.symbol+' spendable for payment and contract storage; the treasury has '+formatAssetAmount(wallet.spendableRaw,NETWORK.decimals)+' '+NETWORK.symbol+'. No payment was submitted.');
    const inner = invoiceBatchCalls(api, batch, treasury);
    if (inner.method.encodedLength > 48_000) throw new Error('Split this batch into smaller payments.');
    return { ...batch, callHex: inner.method.toHex(), callHash: inner.method.hash.toHex() };
  }
  async approvalPlan(batch: InvoiceBatch, treasury: Treasury, signer: string, cancel = false): Promise<TransactionPlan> {
    await this.chain.ready(); await this.chain.refreshHead();
    if (!treasury.signatories.includes(signer)) throw new Error('Only a treasury signer can approve this batch.');
    const api = this.chain.requireApi(), pending = await this.chain.pending(treasury, batch);
    const others = treasury.signatories.filter(s => s !== signer);
    if (cancel) {
      if (!pending || pending.depositor !== signer) throw new Error('Only the initiating signer can cancel this proposal.');
      return this.chain.estimate(api.tx.multisig.cancelAsMulti(treasury.threshold, others, pending.timepoint, batch.callHash), signer, 'cancellation');
    }
    if (!['draft', 'awaiting_approval'].includes(batch.status)) throw new Error('This payment batch is no longer open.');
    if (batch.specVersion !== this.chain.state.specVersion) throw new Error('The runtime changed. Cancel this proposal and create a new batch.');
    if (pending?.approvals.includes(signer)) throw new Error('Your wallet has already approved this batch.');
    const paid = await this.paid(batch);
    if (paid.some(value => value !== zeroHash)) throw new Error('A selected invoice is already settled. Refresh the payment state.');
    const maps = await this.mappings([treasury.address, ...batch.invoices.map(i => i.recipient)]);
    if (maps.some(m => !m.mapped) || maps.find(m => m.native === treasury.address)?.address !== batch.payer
      || batch.invoices.some((i, n) => maps.find(m => m.native === i.recipient)?.address !== batch.recipients[n])) throw new Error('Account mappings changed. Cancel and recreate the batch.');
    if (!sameAsset(await this.asset(batch.asset.id),batch.asset)) throw new Error('The payment asset changed. Cancel this proposal before creating a replacement.');
    const wallet=await this.chain.wallet(treasury.address);
    const requiredNative=(batch.asset.kind==='native'?BigInt(batch.totalRaw):0n)+BigInt(invoiceStorageLimit(batch));
    if(BigInt(wallet.spendableRaw)<requiredNative) throw new Error('The treasury needs more tPOT for these payments and contract storage.');
    if(batch.asset.kind==='asset' && await this.client.readContract({address:batch.asset.token,abi:invoiceTokenAbi,functionName:'balanceOf',args:[batch.payer],blockNumber:BigInt(this.chain.state.finalizedBlock)})<BigInt(batch.totalRaw)) throw new Error('The treasury no longer holds enough of this payment asset.');
    const inner = invoiceBatchCalls(api, batch, treasury);
    if (inner.method.toHex() !== batch.callHex || inner.method.hash.toHex() !== batch.callHash) throw new Error('The batch no longer matches its frozen invoice terms.');
    const info = await inner.paymentInfo(treasury.address);
    const weight = { refTime: bump(info.weight.refTime.toString()), proofSize: bump(info.weight.proofSize.toString()) };
    const max:any=(api.consts.system.blockWeights as any).maxBlock;
    if(BigInt(weight.refTime)>BigInt(max.refTime.toString())*3n/4n||BigInt(weight.proofSize)>BigInt(max.proofSize.toString())*3n/4n) throw new Error('This batch exceeds the safe block weight. Split it before requesting signatures.');
    const final = Boolean(pending && pending.approvals.length + 1 >= treasury.threshold);
    const call = final ? api.tx.multisig.asMulti(treasury.threshold, others, pending!.timepoint, inner.method, weight)
      : api.tx.multisig.approveAsMulti(treasury.threshold, others, pending?.timepoint ?? null, batch.callHash, weight);
    const deposit = pending ? 0n : BigInt(this.chain.state.depositBaseRaw) + BigInt(treasury.threshold) * BigInt(this.chain.state.depositFactorRaw);
    return this.chain.estimate(call, signer, final ? 'funding' : 'approval', deposit);
  }
}
