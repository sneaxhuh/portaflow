import type { ApiPromise } from '@polkadot/api';
import type { Signer } from '@polkadot/api/types';
import { base64Encode, decodeAddress, encodeAddress, cryptoWaitReady } from '@polkadot/util-crypto';
import { stringToHex, u8aToHex } from '@polkadot/util';
import { transactionFromCall } from '../shared/calls';
import { validatePlan, type PlanContext } from '../shared/validation';
export { validatePlan } from '../shared/validation';
import { NETWORK, type TransactionPlan } from '../shared/types';
import { request } from './api';
import { rememberReceipt } from './receipts';
import { invoiceMessage, invoiceTermsHash, verifyInvoiceSignature, type Invoice } from '../shared/invoices';
import { matchesRuntimeCode } from '../shared/runtime-code';
export { syncFinalizedReceipts } from './receipts';
export { request } from './api';

export type NativeAccount = { address: string; signingAddress: string; meta: { name?: string; source: string; genesisHash?: string | null } };
export type NativeProvider = { id: string; name: string };
type InjectedAccount = { address: string; name?: string; genesisHash?: string | null };
type NativeExtension = {
  accounts: { get: () => Promise<InjectedAccount[]> };
  signer: Signer;
  metadata?: { get: () => Promise<{ genesisHash: string; specVersion: number }[]>; provide: (definition: unknown) => Promise<boolean> };
};
type WindowProvider = { enable?: (app: string) => Promise<NativeExtension>; connect?: (app: string) => Promise<NativeExtension> };
const injected = () => (window as unknown as { injectedWeb3?: Record<string, WindowProvider> }).injectedWeb3 || {};
const enabled = new Map<string, NativeExtension>();
const registeredMetadata = new Set<string>();
export const providerName = (id: string) => /portaldot/i.test(id) ? 'Portaldot Wallet' : /polkadot/i.test(id) ? 'Polkadot.js' : /talisman/i.test(id) ? 'Talisman' : /subwallet/i.test(id) ? 'SubWallet' : id;

export async function walletProviders(): Promise<NativeProvider[]> {
  if (document.readyState !== 'complete') await new Promise<void>(resolve => addEventListener('load', () => resolve(), { once: true }));
  return Object.entries(injected()).filter(([, provider]) => provider.enable || provider.connect)
    .map(([id]) => ({ id, name: providerName(id) }))
    .sort((a, b) => Number(/portaldot/i.test(b.id)) - Number(/portaldot/i.test(a.id)) || a.name.localeCompare(b.name));
}
async function extensionFromSource(source: string): Promise<NativeExtension> {
  const existing = enabled.get(source);
  if (existing) return existing;
  const provider = injected()[source];
  if (!provider) throw new Error('This wallet is unavailable. Open Connect wallet and choose an installed native wallet.');
  const extension = provider.connect ? await provider.connect('PortaFlow · Portaldot V3 Testnet')
    : provider.enable ? await provider.enable('PortaFlow · Portaldot V3 Testnet') : undefined;
  if (!extension?.accounts || !extension.signer) throw new Error('This wallet did not expose native accounts and signing.');
  enabled.set(source, extension);
  return extension;
}
export const normalize = (address: string) => {
  if (address.startsWith('0x')) throw new Error('Use a native SS58 account address.');
  const key = decodeAddress(address);
  if (key.length !== 32) throw new Error('Use a native account address.');
  return encodeAddress(key, 42);
};
export const same = (a: string, b: string) => u8aToHex(decodeAddress(a)) === u8aToHex(decodeAddress(b));

export async function accounts(source?: string): Promise<NativeAccount[]> {
  source = source || localStorage.getItem('portaflow-wallet-source') || '';
  if (!source) throw new Error('Choose a wallet in Connect wallet first.');
  const extension = await extensionFromSource(source);
  const shared = await extension.accounts.get();
  if (!Array.isArray(shared)) throw new Error('The wallet returned an unexpected account list. Reload PortaFlow and reconnect your wallet.');
  if (!shared.length) throw new Error('The wallet shared zero accounts. In Portaldot Wallet → Manage Website Access, open this exact local site, select your funded account, and save with “Connect account(s)”. Then choose the wallet again here.');
  const native: NativeAccount[] = [];
  for (const account of shared) {
    try {
      // A wallet's network label is account metadata, not the identity of the connected RPC.
      // Preserve the original spelling for the wallet's signer while displaying SS58 on Portaldot.
      const key = decodeAddress(account.address);
      if (key.length !== 32) continue;
      if (account.address.startsWith('0x') && !/^0x[0-9a-fA-F]{64}$/.test(account.address)) continue;
      native.push({ address: encodeAddress(key, NETWORK.ss58), signingAddress: account.address,
        meta: { name: account.name, source, genesisHash: account.genesisHash } });
    } catch { /* A 20-byte EVM address or malformed entry is not a native account. */ }
  }
  if (!native.length) throw new Error('The wallet shared accounts, but none contain a valid 32-byte native address. Select your funded native SS58 account in the wallet’s website access settings.');
  return native;
}
export async function login(account: NativeAccount) {
  const extension = await extensionFromSource(account.meta.source);
  if (!extension.signer.signRaw) throw new Error('This wallet does not support message sign-in. Use a native software wallet.');
  const challenge = await request<{ id: string; message: string }>('/auth/challenge', { address: account.address });
  const { signature } = await extension.signer.signRaw({ address: account.signingAddress, data: stringToHex(challenge.message), type: 'bytes' });
  const result = await request<{ address: string }>('/auth/verify', { id: challenge.id, signature });
  localStorage.setItem('portaflow-wallet-source', account.meta.source);
  return result;
}
export async function signInvoice(invoice: Invoice): Promise<string> {
  await cryptoWaitReady();
  if(invoice.termsHash!==invoiceTermsHash(invoice))throw new Error('The invoice terms hash is invalid.');
  const account = (await accounts()).find(a=>same(a.address,invoice.issuer));
  if (!account) throw new Error('Connect the contributor wallet for this invoice.');
  const extension = await extensionFromSource(account.meta.source);
  if (!extension.signer.signRaw) throw new Error('This wallet cannot sign a payment request.');
  const { signature } = await extension.signer.signRaw({address:account.signingAddress,data:stringToHex(invoiceMessage(invoice)),type:'bytes'});
  if (!verifyInvoiceSignature({...invoice,signature:signature as `0x${string}`})) throw new Error('The wallet did not return a valid invoice signature.');
  return signature;
}
let apiPromise: Promise<ApiPromise> | undefined;
async function chainApi() {
  if (!apiPromise) apiPromise = import('@polkadot/api').then(({ ApiPromise, WsProvider }) =>
    ApiPromise.create({ provider: new WsProvider(NETWORK.rpc), noInitWarn: true })).catch(error => { apiPromise = undefined; throw error; });
  return apiPromise;
}
export async function signTransaction(plan: TransactionPlan, context: PlanContext, onProgress: (status: string) => void) {
  await cryptoWaitReady();
  const api = await chainApi();
  const available = await accounts();
  const account = available.find(a => same(a.address, plan.signer));
  if (!account) throw new Error('Select the same signing wallet used to prepare this transaction.');
  validatePlan(api, plan, context);
  if (context.invoiceBatch && plan.kind !== 'cancellation') {
    const snapshot = await api.at(await api.rpc.chain.getFinalizedHead());
    const code: any = await (snapshot.call as any).reviveApi.code(context.invoiceBatch.router);
    if (!matchesRuntimeCode(code.toHex(),context.invoiceBatch.runtimeCodeHash)) throw new Error('Settlement contract bytecode changed. No payment was signed.');
    for (const [native,evm] of [[context.treasury!.address,context.invoiceBatch.payer],...context.invoiceBatch.invoices.map((i,n)=>[i.recipient,context.invoiceBatch!.recipients[n]])]) {
      if (!same((await (snapshot.call as any).reviveApi.accountId(evm)).toString(),native)) throw new Error('Payment account mapping changed. Review this batch again.');
    }
  }
  const extension = await extensionFromSource(account.meta.source);
  if (extension.metadata) {
    const metadataKey = `${account.meta.source}:${NETWORK.genesis}:${plan.specVersion}`;
    // Re-provide once per page session to replace metadata registered by older builds.
    if (!registeredMetadata.has(metadataKey)) {
      onProgress('Approve Portaldot network details in your wallet');
      const accepted = await extension.metadata.provide({ chain: NETWORK.name, genesisHash: NETWORK.genesis,
        icon: 'substrate', ss58Format: NETWORK.ss58, specVersion: plan.specVersion,
        tokenDecimals: NETWORK.decimals, tokenSymbol: NETWORK.symbol, types: {},
        metaCalls: base64Encode(api.runtimeMetadata.asCallsOnly.toU8a()), rawMetadata: api.runtimeMetadata.toHex() });
      if (!accepted) throw new Error('Portaldot network metadata was declined. No payment was submitted.');
      registeredMetadata.add(metadataKey);
    }
  }
  onProgress('Confirm in your wallet');
  return new Promise<string>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const finish = (error?: Error, hash?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); unsubscribe?.();
      if (error) reject(error); else resolve(hash!);
    };
    const timeout = setTimeout(() => finish(new Error('Confirmation is taking longer than expected. Refresh the award before retrying; the transaction may still finalize.')), 120_000);
    void transactionFromCall(api, plan.callHex).signAndSend(account.signingAddress, { signer: extension.signer }, result => {
      onProgress(result.status.isFinalized ? 'Finalized' : result.status.isInBlock ? 'Included · waiting for finality' : 'Submitted to Portaldot');
      if (result.status.isDropped || result.status.isInvalid || result.status.isUsurped) return finish(new Error('The transaction was dropped or replaced. Refresh the award status.'));
      if (!result.status.isFinalized) return;
      rememberReceipt({ txHash: result.txHash.toHex(), blockHash: result.status.asFinalized.toHex() });
      if (result.dispatchError) {
        let message = result.dispatchError.toString();
        if (result.dispatchError.isModule) {
          const meta = api.registry.findMetaError(result.dispatchError.asModule);
          message = meta.section + '.' + meta.name + ': ' + meta.docs.join(' ');
        }
        return finish(new Error(message));
      }
      const executed: any = result.events.find(record => record.event.section === 'multisig' && record.event.method === 'MultisigExecuted')?.event;
      if (executed && executed.data[4].isErr) return finish(new Error('The approval finalized, but the inner payment failed. Open the receipt before retrying.'));
      const has = (section: string, methods: string[]) => result.events.some(({ event }) => event.section === section && methods.includes(event.method));
      const confirmed = plan.kind === 'funding' ? Boolean(executed?.data[4].isOk) && has('utility', ['BatchCompleted'])
        : plan.kind === 'approval' ? has('multisig', ['NewMultisig', 'MultisigApproval'])
        : plan.kind === 'cancellation' ? has('multisig', ['MultisigCancelled'])
        : plan.kind === 'treasury funding' ? has('balances', ['Transfer'])
        : plan.kind === 'invoice mapping' ? has('system', ['ExtrinsicSuccess'])
        : plan.kind === 'settlement deployment' ? has('revive', ['Instantiated'])
        : has('vesting', ['VestingUpdated', 'VestingCompleted']);
      if (!confirmed) return finish(new Error('The transaction finalized without the expected action event. Refresh its on-chain state before submitting another transaction.'));
      finish(undefined, result.txHash.toHex());
    }).then(fn => { unsubscribe = fn; if (settled) fn(); }).catch(error => finish(error));
  });
}
