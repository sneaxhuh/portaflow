import type { ApiPromise } from '@polkadot/api';
import { fundingCall, roundFundingCall, transactionFromCall } from './calls.js';
import { normalizeAddress as normalize, sameAddress as same, treasuryIdentity } from './accounts.js';
import { NETWORK, type Award, type PayoutRound, type Treasury, type TransactionPlan } from './types.js';
import { invoiceBatchCalls, type InvoiceBatch } from './invoices.js';
import code from './settlement-code.json' with { type: 'json' };
import { keccak256 } from 'viem';

export type PlanContext = { award?: Award; round?: PayoutRound; treasury?: Treasury; recipient?: string; amountRaw?: string; invoiceBatch?: InvoiceBatch; mappingAddresses?: string[]; settlementDeployment?: boolean };

export function validatePlan(api: ApiPromise, plan: TransactionPlan, context: PlanContext) {
  if (api.genesisHash.toHex() !== NETWORK.genesis || plan.genesis !== NETWORK.genesis) throw new Error('Network verification failed.');
  if (api.runtimeVersion.specVersion.toNumber() !== plan.specVersion) throw new Error('The runtime changed. Refresh this transaction before signing.');
  const decoded: any = transactionFromCall(api, plan.callHex).method;
  const address = (codec: any) => normalize(codec.isId ? codec.asId.toString() : codec.toString());
  if ((context.award || context.round || context.invoiceBatch) && context.treasury && ['approval', 'funding', 'cancellation'].includes(plan.kind)) {
    const treasury = context.treasury;
    if (!treasury.signatories.some(a => same(a, plan.signer))) throw new Error('The selected wallet is not a signer of this treasury.');
    const identity = treasuryIdentity(treasury.signatories, treasury.threshold);
    if (!same(identity.address, treasury.address) || identity.signatories.some((s, i) => s !== treasury.signatories[i])) throw new Error('The treasury signer configuration does not match its address.');
    const expectedMethod = plan.kind === 'approval' ? 'approveAsMulti' : plan.kind === 'funding' ? 'asMulti' : 'cancelAsMulti';
    if (decoded.section !== 'multisig' || decoded.method !== expectedMethod || Number(decoded.args[0].toString()) !== treasury.threshold) throw new Error('Unexpected treasury transaction.');
    const others: string[] = decoded.args[1].map((a: any) => normalize(a.toString()));
    const expected = treasury.signatories.filter(a => !same(a, plan.signer));
    if (others.length !== expected.length || others.some((a, i) => !same(a, expected[i]))) throw new Error('The other signers do not match this treasury.');
    // Cancellation must remain possible after a runtime upgrade changes encoding.
    if (context.invoiceBatch && plan.kind !== 'cancellation' && context.invoiceBatch.runtimeCodeHash !== code.runtimeCodeHash) throw new Error('Unexpected invoice settlement implementation.');
    const batch = plan.kind === 'cancellation' ? undefined : context.invoiceBatch ? invoiceBatchCalls(api,context.invoiceBatch,treasury) : context.round ? roundFundingCall(api, context.round, treasury) : fundingCall(api, context.award!, treasury);
    const expectedCall = plan.kind === 'cancellation' ? (context.invoiceBatch ?? context.round ?? context.award)!.callHash
      : plan.kind === 'funding' ? batch!.method.toHex() : batch!.method.hash.toHex();
    if (!expectedCall || decoded.args[3].toHex() !== expectedCall) throw new Error('The encoded payment does not match the terms displayed.');
  } else if (plan.kind === 'settlement deployment' && context.settlementDeployment) {
    if (decoded.section !== 'revive' || decoded.method !== 'instantiateWithCode' || decoded.args[0].toString() !== '0'
      || keccak256(decoded.args[3].toHex()) !== code.creationCodeHash || decoded.args[4].toHex() !== '0x' || !decoded.args[5].isNone
      || decoded.args[2].toString() !== plan.storageDepositRaw) throw new Error('Unexpected settlement deployment transaction.');
  } else if (plan.kind === 'invoice mapping' && context.mappingAddresses?.length) {
    if (decoded.section !== 'revive' || decoded.method !== 'batchMapAccounts' || JSON.stringify(decoded.args[0].map((a: any)=>normalize(a.toString()))) !== JSON.stringify(context.mappingAddresses)) throw new Error('The account mapping does not match the reviewed accounts.');
  } else if (plan.kind === 'treasury funding' && context.treasury) {
    if (decoded.section !== 'balances' || decoded.method !== 'transferKeepAlive' || !same(address(decoded.args[0]), context.treasury.address) || decoded.args[1].toString() !== context.amountRaw) throw new Error('The treasury funding transfer does not match the requested payment.');
  } else if (plan.kind === 'unlock' && context.recipient) {
    if (decoded.section !== 'vesting' || decoded.method !== 'vestOther' || !same(address(decoded.args[0]), context.recipient)) throw new Error('Unexpected unlock transaction.');
  } else throw new Error('Unsupported transaction plan.');
}
