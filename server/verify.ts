import type { ApiPromise } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { NETWORK, type ReceiptBundle, type Verification, type Award } from '../shared/types.js';
import { awardTermsHash, fundingCall, roundFundingCall, roundTermsHash } from '../shared/calls.js';
import { treasuryIdentity, normalizeAddress, sameAddress } from './identity.js';

class InvalidReceipt extends Error {}
const hash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);

/** Verifies uploaded evidence using only its contents and the pinned chain, never the app database. */
export async function verifyReceipt(api: ApiPromise, value: unknown): Promise<Verification> {
  const result: Verification = { status: 'invalid', subject: 'Uploaded receipt', checks: [] };
  const check = (label: string, passed: boolean, detail: string) => {
    result.checks.push({ label, passed, detail });
    if (!passed) throw new InvalidReceipt(detail);
  };
  try {
    const bundle = value as ReceiptBundle;
    check('Receipt format', Boolean(bundle && bundle.application === 'PortaFlow' && [1, 2].includes(bundle.version)
      && bundle.treasury && Array.isArray(bundle.transactions) && bundle.transactions.length <= 100
      && Boolean(bundle.award) !== Boolean(bundle.round)), 'A versioned PortaFlow receipt with exactly one award or round is required.');
    const subject = bundle.round ?? bundle.award!;
    result.subject = typeof subject.title === 'string' ? subject.title.slice(0, 100) : 'Uploaded receipt';
    check('Portaldot network', bundle.network?.genesis === NETWORK.genesis && api.genesisHash.toHex() === NETWORK.genesis,
      'Receipt and RPC must use the pinned Portaldot V3 genesis.');
    const identity = treasuryIdentity(bundle.treasury.signatories, bundle.treasury.threshold);
    check('Treasury ownership', sameAddress(identity.address, bundle.treasury.address)
      && identity.signatories.every((a, i) => a === bundle.treasury.signatories[i]), 'Signer set and threshold must derive the stated treasury.');
    const awards = bundle.round ? bundle.round.awards : [bundle.award!];
    check('Payment manifest', Array.isArray(awards) && awards.length >= 1 && awards.length <= 25
      && awards.every(validPayment) && (!bundle.round || ['totalRaw', 'upfrontRaw', 'lockedRaw'].every(key => {
        const field = key as 'totalRaw' | 'upfrontRaw' | 'lockedRaw';
        return awards.reduce((sum, a) => sum + BigInt(a[field]), 0n).toString() === bundle.round![field];
      })), 'All amounts, recipients, totals and block schedules must be internally consistent.');
    const termsHash = bundle.round ? roundTermsHash(bundle.round, bundle.treasury) : awardTermsHash(bundle.award!, bundle.treasury);
    check('Manifest commitment', subject.termsHash === termsHash, 'The document must match its canonical terms hash.');
    const funding = bundle.transactions.filter(tx => tx.kind === 'funding');
    check('Funding reference', funding.length === 1 && hash(funding[0].txHash) && hash(funding[0].blockHash)
      && subject.fundingTx === funding[0].txHash && subject.fundingBlock === funding[0].blockNumber,
      'Exactly one matching finalized funding reference is required.');
    const receipt = funding[0];
    result.txHash = receipt.txHash;
    result.blockNumber = receipt.blockNumber;
    const [header, finalizedHash] = await Promise.all([api.rpc.chain.getHeader(receipt.blockHash), api.rpc.chain.getFinalizedHead()]);
    const finalized = await api.rpc.chain.getHeader(finalizedHash);
    const canonicalHash = await api.rpc.chain.getBlockHash(header.number.toNumber());
    check('Canonical finality', header.number.toNumber() === receipt.blockNumber && header.number.toNumber() <= finalized.number.toNumber()
      && canonicalHash.toHex() === receipt.blockHash, 'The funding block must be on the canonical finalized chain reported by the pinned RPC.');
    // Decode with metadata from the execution block, including after runtime upgrades.
    const at = await api.at(receipt.blockHash);
    const block = await api.rpc.chain.getBlock(receipt.blockHash);
    const index = block.block.extrinsics.findIndex(tx => tx.hash.toHex() === receipt.txHash);
    check('Transaction inclusion', index >= 0, 'The referenced transaction must be present in the funding block.');
    const tx = at.registry.createType('Extrinsic', block.block.extrinsics[index].toHex());
    const method: any = tx.method;
    const metadata = await api.rpc.state.getMetadata(receipt.blockHash);
    const historicalCalls = decorateExtrinsics(at.registry, at.registry.metadata, metadata.version);
    const historicalApi = { tx: Object.fromEntries(Object.entries(historicalCalls).map(([section, methods]) =>
      [section, Object.fromEntries(Object.entries(methods).map(([name, factory]) =>
        [name, (...args: unknown[]) => at.tx(factory(...args))]))])) } as unknown as ApiPromise;
    const call = bundle.round ? roundFundingCall(historicalApi, bundle.round, bundle.treasury)
      : fundingCall(historicalApi, bundle.award!, bundle.treasury);
    const callHash = call.method.hash.toHex();
    check('Exact approved call', method.section === 'multisig' && method.method === 'asMulti'
      && Number(method.args[0].toString()) === bundle.treasury.threshold
      && method.args[3].toHex() === call.method.toHex() && subject.callHash === callHash,
      'The executed multisig call must exactly match every payment and the terms commitment.');
    const others = method.args[1].map((a: any) => normalizeAddress(a.toString()));
    check('Executing signers', identity.signatories.includes(normalizeAddress(tx.signer.toString()))
      && JSON.stringify(others) === JSON.stringify(identity.signatories.filter(a => !sameAddress(a, tx.signer.toString()))),
      'The executing signer and other signatories must match the treasury policy.');
    const records: any = await at.query.system.events();
    const events: any[] = records.filter((r: any) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index).map((r: any) => r.event);
    const executed = events.find(e => e.section === 'multisig' && e.method === 'MultisigExecuted'
      && e.data[3].toHex() === callHash && sameAddress(e.data[2].toString(), bundle.treasury.address));
    check('Atomic execution', Boolean(executed?.data[4].isOk)
      && events.some(e => e.section === 'utility' && e.method === 'BatchCompleted')
      && !events.some(e => e.section === 'system' && e.method === 'ExtrinsicFailed' || e.section === 'utility' && e.method === 'BatchInterrupted'),
      'The real chain events must confirm a successful inner multisig dispatch and complete atomic batch.');
    const calls: any[] = [...(call.method.args[0] as any)];
    const remarkCall = calls[calls.length - 1];
    const remarkHash = blake2AsHex(remarkCall.args[0].toU8a(true));
    check('On-chain terms record', events.some(e => e.section === 'system' && e.method === 'Remarked'
      && sameAddress(e.data[0].toString(), bundle.treasury.address) && e.data[1].toHex() === remarkHash),
      'The terms commitment must have been emitted by the treasury in this funding transaction.');
    const expected = new Map<string, bigint>(), actual = new Map<string, bigint>();
    for (const award of awards) expected.set(award.recipient, (expected.get(award.recipient) ?? 0n) + BigInt(award.totalRaw));
    for (const e of events.filter(e => e.section === 'balances' && e.method === 'Transfer' && sameAddress(e.data[0].toString(), bundle.treasury.address))) {
      const recipient = normalizeAddress(e.data[1].toString());
      actual.set(recipient, (actual.get(recipient) ?? 0n) + BigInt(e.data[2].toString()));
    }
    check('Recipient transfers', expected.size === actual.size && [...expected].every(([recipient, amount]) => actual.get(recipient) === amount),
      'Every expected recipient must have received the exact total in the finalized transfer events.');
    result.status = 'verified';
  } catch (error) {
    if (error instanceof InvalidReceipt) result.status = 'invalid';
    else {
      result.status = result.checks.length < 6 ? 'invalid' : 'unavailable';
      result.checks.push({ label: result.status === 'unavailable' ? 'Chain evidence unavailable' : 'Invalid document', passed: false,
        detail: result.status === 'unavailable' ? 'The RPC could not provide all required historical data. Retry; this is not proof of an invalid payment.'
          : 'The receipt contains malformed fields or unsupported payment terms.' });
    }
  }
  return result;
}

function validPayment(a: Award) {
  try {
    if (!a || normalizeAddress(a.recipient) !== a.recipient) return false;
    if (![a.totalRaw, a.upfrontRaw, a.lockedRaw, a.perBlockRaw].every(v => typeof v === 'string' && /^(0|[1-9]\d{0,38})$/.test(v))) return false;
    const total = BigInt(a.totalRaw), locked = BigInt(a.lockedRaw), upfront = BigInt(a.upfrontRaw), perBlock = BigInt(a.perBlockRaw);
    if (total <= 0n || total >= (1n << 128n) || locked + upfront !== total) return false;
    if (locked === 0n) return upfront === total && perBlock === 0n && a.startBlock === 0 && a.endBlock === 0 && a.durationBlocks === 0;
    return perBlock > 0n && Number.isSafeInteger(a.startBlock) && a.startBlock > 0 && Number.isSafeInteger(a.endBlock)
      && a.endBlock <= 0xffff_ffff && a.endBlock === a.startBlock + Number((locked + perBlock - 1n) / perBlock)
      && a.durationBlocks === a.endBlock - a.startBlock;
  } catch { return false; }
}
