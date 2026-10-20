import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { NETWORK, type Award, type NetworkState, type PendingApproval, type Receipt, type TransactionPlan, type Treasury, type WalletState } from '../shared/types.js';
import { vestedRemaining, UNIT } from '../shared/money.js';
import { normalizeAddress, sameAddress } from './identity.js';
import type { Store } from './store.js';
import { awardTermsHash, fundingCall, transactionFromCall } from '../shared/calls.js';

export const initialNetwork = (): NetworkState => ({
  connected: false, verified: false, name: NETWORK.name, genesis: NETWORK.genesis,
  bestBlock: 0, finalizedBlock: 0, specVersion: 0, blockSeconds: 6,
  existentialDepositRaw: '0', minVestedRaw: '0', maxSchedules: 0,
  depositBaseRaw: '0', depositFactorRaw: '0', lastSyncedBlock: 0, sponsorEnabled: false,
});

// A successful outer extrinsic does not prove a successful multisig dispatch.
export function fundingSucceeded(innerOk: boolean, methods: string[]) {
  return innerOk && methods.includes('BatchCompleted') && !methods.includes('BatchInterrupted') && !methods.includes('ExtrinsicFailed');
}

export class Chain {
  api?: ApiPromise;
  state = initialNetwork();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private scanning?: Promise<void>;
  private sponsor?: KeyringPair;
  private sponsorBusy = new Set<string>();
  private sponsoredAt = new Map<string, number>();
  constructor(public store: Store, public rpc = process.env.PORTAFLOW_RPC || NETWORK.rpc) {}

  async connect() {
    if (this.timer) clearInterval(this.timer);
    await this.api?.disconnect();
    this.state.connected = false;
    this.state.verified = false;
    const provider = new WsProvider(this.rpc, 6000, {}, 25_000);
    provider.on('disconnected', () => { this.state.connected = false; });
    provider.on('error', () => { this.state.error = 'The network connection is unavailable. Reconnecting…'; });
    this.api = await ApiPromise.create({ provider, noInitWarn: true });
    const api = this.api;
    if (api.genesisHash.toHex() !== NETWORK.genesis) {
      await api.disconnect();
      throw new Error('The RPC does not match the pinned Portaldot V3 testnet genesis.');
    }
    if (api.registry.chainDecimals[0] !== NETWORK.decimals || api.registry.chainTokens[0] !== NETWORK.symbol) {
      await api.disconnect();
      throw new Error('Unexpected native token properties.');
    }
    for (const [pallet, call] of [['multisig', 'asMulti'], ['utility', 'batchAll'], ['vesting', 'vestedTransfer'], ['system', 'remarkWithEvent']]) {
      if (!(api.tx as any)[pallet]?.[call]) throw new Error('Required native call is unavailable: ' + pallet + '.' + call);
    }
    this.state = { ...this.state, connected: true, verified: true,
      specVersion: api.runtimeVersion.specVersion.toNumber(),
      existentialDepositRaw: api.consts.balances.existentialDeposit.toString(),
      minVestedRaw: api.consts.vesting.minVestedTransfer.toString(),
      maxSchedules: Number(api.consts.vesting.maxVestingSchedules.toString()),
      depositBaseRaw: api.consts.multisig.depositBase.toString(),
      depositFactorRaw: api.consts.multisig.depositFactor.toString(),
      error: undefined,
    };
    if (process.env.PORTAFLOW_SPONSOR_URI) {
      this.sponsor = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(process.env.PORTAFLOW_SPONSOR_URI);
    }
    await this.refresh();
    this.timer = setInterval(() => { void this.tick(); }, 6000);
  }
  requireApi(): ApiPromise {
    if (!this.api || !this.state.verified || !this.api.isConnected) throw new Error('Waiting for a verified Portaldot testnet connection.');
    return this.api;
  }
  async refreshHead() {
    const api = this.requireApi();
    const finalizedHash = await api.rpc.chain.getFinalizedHead();
    const [finalized, best] = await Promise.all([api.rpc.chain.getHeader(finalizedHash), api.rpc.chain.getHeader()]);
    this.state.connected = true;
    this.state.finalizedBlock = finalized.number.toNumber();
    this.state.bestBlock = best.number.toNumber();
    this.state.specVersion = api.runtimeVersion.specVersion.toNumber();
    this.state.error = undefined;
  }
  async refresh() {
    await this.refreshHead();
    await this.scan();
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await this.refresh(); await this.runSponsor(); }
    catch { this.state.connected = Boolean(this.api?.isConnected); this.state.error = 'Chain synchronization paused. Retrying automatically.'; }
    finally { this.busy = false; }
  }
  async wallet(address: string): Promise<WalletState> {
    const api = this.requireApi();
    const hash = await api.rpc.chain.getFinalizedHead();
    const at = await api.at(hash);
    const [account, stored, locks, header]: any[] = await Promise.all([
      at.query.system.account(address), at.query.vesting.vesting(address),
      at.query.balances.locks(address), api.rpc.chain.getHeader(hash),
    ]);
    const free = BigInt(account.data.free.toString());
    const frozen = BigInt(account.data.frozen.toString());
    const ed = BigInt(this.state.existentialDepositRaw);
    const retained = frozen > ed ? frozen : ed;
    const schedules: WalletState['schedules'] = (stored.isSome ? stored.unwrap() : []).map((item: any) => ({
      lockedRaw: item.locked.toString(), perBlockRaw: item.perBlock.toString(), startBlock: item.startingBlock.toNumber(),
    }));
    const lock = locks.find((item: any) => Buffer.from(item.id.toU8a()).toString('utf8').trim() === 'vesting');
    const lockAmount = lock ? BigInt(lock.amount.toString()) : 0n;
    const remaining = schedules.reduce((sum, item) => sum + vestedRemaining(BigInt(item.lockedRaw), BigInt(item.perBlockRaw), item.startBlock, header.number.toNumber()), 0n);
    return { address, freeRaw: free.toString(), reservedRaw: account.data.reserved.toString(), frozenRaw: frozen.toString(),
      spendableRaw: (free > retained ? free - retained : 0n).toString(),
      vestingLockRaw: lockAmount.toString(), remainingLockedRaw: remaining.toString(),
      eligibleUnlockRaw: (lockAmount > remaining ? lockAmount - remaining : 0n).toString(), schedules,
    };
  }
  async pending(treasury: Treasury, award: Award): Promise<PendingApproval | null> {
    if (!award.callHash) return null;
    const api = this.requireApi();
    const value: any = await api.query.multisig.multisigs(treasury.address, award.callHash);
    if (value.isNone) return null;
    const pending = value.unwrap();
    return { approvals: pending.approvals.map((a: any) => normalizeAddress(a.toString())),
      depositor: normalizeAddress(pending.depositor.toString()), depositRaw: pending.deposit.toString(),
      timepoint: { height: pending.when.height.toNumber(), index: pending.when.index.toNumber() } };
  }
  async prepare(award: Award, treasury: Treasury) {
    const api = this.requireApi();
    if (award.callHex) return award;
    if (award.status !== 'draft') throw new Error('This award can no longer be prepared.');
    const termsHash = awardTermsHash(award, treasury);
    const batch = fundingCall(api, award, treasury);
    const result: Award = { ...award, callHex: batch.method.toHex(), callHash: batch.method.hash.toHex(), termsHash, specVersion: this.state.specVersion };
    this.store.saveAward(result);
    return result;
  }
  async estimate(call: any, signer: string, kind: string, deposit = 0n): Promise<TransactionPlan> {
    const info = await call.paymentInfo(signer);
    const wallet = await this.wallet(signer);
    if (BigInt(wallet.spendableRaw) < BigInt(info.partialFee.toString()) + deposit) {
      throw new Error(deposit > 0n
        ? 'This signing wallet needs more tPOT for the estimated fee and refundable approval deposit.'
        : 'This signing wallet needs more tPOT for the estimated transaction fee.');
    }
    return { callHex: call.method.toHex(), signer, feeRaw: info.partialFee.toString(), depositRaw: deposit.toString(),
      genesis: NETWORK.genesis, specVersion: this.state.specVersion, kind };
  }
  async approvalPlan(award: Award, treasury: Treasury, signer: string, cancel = false): Promise<TransactionPlan> {
    const api = this.requireApi();
    await this.refresh();
    const latest = this.store.award(award.id)!;
    if (['funded', 'cancelled', 'failed'].includes(latest.status)) throw new Error('This award has already been finalized. Refresh its receipt.');
    if (this.state.lastSyncedBlock < this.state.finalizedBlock) throw new Error('Catching up with finalized blocks. Please try again shortly.');
    if (!treasury.signatories.includes(signer)) throw new Error('Only a treasury signer can approve this award.');
    const prepared = await this.prepare(latest, treasury);
    const pending = await this.pending(treasury, prepared);
    const others = treasury.signatories.filter(address => !sameAddress(address, signer));
    if (cancel) {
      if (!pending || !sameAddress(pending.depositor, signer)) throw new Error('Only the wallet that initiated this approval can cancel it.');
      return this.estimate(api.tx.multisig.cancelAsMulti(treasury.threshold, others, pending.timepoint, prepared.callHash!), signer, 'cancellation');
    }
    if (prepared.specVersion !== this.state.specVersion) throw new Error('The runtime changed. Cancel this proposal and create a new award to review the new call.');
    if (this.state.bestBlock >= prepared.startBlock) throw new Error('The scheduled start has passed. Cancel this proposal and create a new award with a future start.');
    if (pending?.approvals.includes(signer)) throw new Error('This wallet has already approved. Another treasury signer must approve next.');
    const wallet = await this.wallet(treasury.address);
    if (BigInt(wallet.spendableRaw) < BigInt(prepared.totalRaw)) throw new Error('Fund the treasury before requesting approval. It must retain its minimum account balance.');
    const recipient = await this.wallet(prepared.recipient);
    if (recipient.schedules.length >= this.state.maxSchedules) throw new Error('This recipient has reached the native vesting schedule limit.');
    const inner = transactionFromCall(api, prepared.callHex!);
    const weight = (await inner.paymentInfo(treasury.address)).weight;
    // Normalize codec values through strings: integer codecs need not expose
    // BN arithmetic methods. Round the 20% allowance up without losing precision.
    const allowance = (value: { toString(): string }) => ((BigInt(value.toString()) * 12n + 9n) / 10n).toString();
    const maxWeight = { refTime: allowance(weight.refTime), proofSize: allowance(weight.proofSize) };
    const final = Boolean(pending && pending.approvals.length + 1 >= treasury.threshold);
    const call = final
      ? api.tx.multisig.asMulti(treasury.threshold, others, pending!.timepoint, inner.method, maxWeight)
      : api.tx.multisig.approveAsMulti(treasury.threshold, others, pending?.timepoint ?? null, prepared.callHash!, maxWeight);
    const deposit = pending ? 0n : BigInt(this.state.depositBaseRaw) + BigInt(treasury.threshold) * BigInt(this.state.depositFactorRaw);
    return this.estimate(call, signer, final ? 'funding' : 'approval', deposit);
  }
  async fundingPlan(treasury: Treasury, signer: string, amount: bigint) {
    const api = this.requireApi();
    const call = api.tx.balances.transferKeepAlive(treasury.address, amount.toString());
    const plan = await this.estimate(call, signer, 'treasury funding');
    if (BigInt((await this.wallet(signer)).spendableRaw) < amount + BigInt(plan.feeRaw)) throw new Error('The wallet cannot cover this transfer and its fee while keeping the minimum account balance.');
    return plan;
  }
  async unlockPlan(recipient: string, signer: string) {
    const api = this.requireApi();
    if (BigInt((await this.wallet(recipient)).eligibleUnlockRaw) === 0n) throw new Error('There are no vested funds waiting to be unlocked.');
    return this.estimate(api.tx.vesting.vestOther(recipient), signer, 'unlock');
  }
  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.scanBlocks().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private async scanBlocks() {
    const api = this.requireApi();
    const cursorKey = 'cursor:' + NETWORK.genesis;
    let cursor = Number(this.store.getMeta(cursorKey) ?? this.state.finalizedBlock);
    // Only prepared calls can have matching on-chain activity. Their creation
    // block precedes signing, so older history cannot contain an award receipt.
    const preparedAwards = this.store.list<Award>('awards').filter(award => award.callHash);
    const earliestRelevantBlock = preparedAwards.length
      ? Math.min(...preparedAwards.map(award => award.createdBlock))
      : this.state.finalizedBlock;
    cursor = Math.max(cursor, Math.min(earliestRelevantBlock, this.state.finalizedBlock));
    this.state.lastSyncedBlock = cursor;
    const end = Math.min(this.state.finalizedBlock, cursor + 120);
    // Fetch a small window concurrently, but apply receipts and persist the
    // cursor in block order. A failed request never skips an unprocessed block.
    for (let windowStart = cursor + 1; windowStart <= end; windowStart += 6) {
      const blocks = await Promise.all(Array.from({ length: Math.min(6, end - windowStart + 1) }, async (_, offset) => {
        const blockNumber = windowStart + offset;
        const hash = await api.rpc.chain.getBlockHash(blockNumber);
        const records: any = await api.query.system.events.at(hash);
        return { blockNumber, hash, records };
      }));
      for (const { blockNumber, hash, records } of blocks) {
      // Most blocks have no award activity. Avoid downloading their extrinsics
      // or constructing a historical API just to advance the receipt cursor.
      const relevant = records.some(({ event }: any) => event.section === 'multisig'
        || event.section === 'vesting' && ['VestingUpdated', 'VestingCompleted'].includes(event.method));
      if (!relevant) {
        cursor = blockNumber;
        this.store.setMeta(cursorKey, String(cursor));
        this.state.lastSyncedBlock = cursor;
        continue;
      }
      const [block, timestamp]: any[] = await Promise.all([api.rpc.chain.getBlock(hash), api.query.timestamp.now.at(hash)]);
      const awards = this.store.list<Award>('awards');
      for (let index = 0; index < block.block.extrinsics.length; index++) {
        const events: any[] = records.filter((record: any) => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === index).map((record: any) => record.event);
        const tx = block.block.extrinsics[index];
        const fee = events.find(event => event.section === 'transactionPayment' && event.method === 'TransactionFeePaid');
        const base = { txHash: tx.hash.toHex(), blockHash: hash.toHex(), blockNumber,
          signer: tx.isSigned ? tx.signer.toString() : '', feeRaw: fee ? fee.data[1].toString() : '0',
          timestamp: new Date(Number(timestamp.toString())).toISOString(),
          events: events.map(event => ({ section: event.section, method: event.method, data: event.data.toJSON() })) };
        for (const event of events) {
          if (event.section === 'multisig') {
            const isNew = event.method === 'NewMultisig';
            if (!['NewMultisig', 'MultisigApproval', 'MultisigExecuted', 'MultisigCancelled'].includes(event.method)) continue;
            const callHash = event.data[isNew ? 2 : 3].toHex();
            const award = awards.find(item => item.callHash === callHash);
            if (!award) continue;
            const treasury = this.store.treasury(award.treasuryId)!;
            if (!sameAddress(event.data[isNew ? 1 : 2].toString(), treasury.address)) continue;
            let kind: Receipt['kind'] = 'approval';
            if (event.method === 'MultisigExecuted') {
              const success = fundingSucceeded(event.data[4].isOk, events.map(e => e.method));
              award.status = success ? 'funded' : 'failed';
              if (success) { award.fundingBlock = blockNumber; award.fundingTx = base.txHash; kind = 'funding'; }
              else { award.failure = 'The multisig inner call failed. No award funding was confirmed. Review the receipt before creating a replacement.'; kind = 'failed'; }
            } else if (event.method === 'MultisigCancelled') { award.status = 'cancelled'; kind = 'cancellation'; }
            else award.status = 'awaiting_approval';
            this.store.saveAward(award);
            this.store.saveReceipt({ ...base, awardId: award.id, kind });
          }
          if (event.section === 'vesting' && ['VestingUpdated', 'VestingCompleted'].includes(event.method)
            && tx.method.section === 'vesting' && ['vest', 'vestOther'].includes(tx.method.method)) {
            for (const award of awards.filter(item => item.status === 'funded' && sameAddress(item.recipient, event.data[0].toString()))) {
              this.store.saveReceipt({ ...base, awardId: award.id, kind: 'unlock' });
            }
          }
        }
      }
      cursor = blockNumber;
      this.store.setMeta(cursorKey, String(cursor));
      this.state.lastSyncedBlock = cursor;
      }
    }
    this.store.setMeta(cursorKey, String(cursor));
    this.state.lastSyncedBlock = cursor;
  }
  async runSponsor() {
    this.state.sponsorEnabled = false;
    if (!this.sponsor) return;
    const cap = BigInt(process.env.PORTAFLOW_SPONSOR_MAX_FEE_RAW || String(UNIT / 10n));
    const budget = BigInt(process.env.PORTAFLOW_SPONSOR_DAILY_BUDGET_RAW || String(UNIT));
    const sponsorWallet = await this.wallet(this.sponsor.address);
    if (BigInt(sponsorWallet.spendableRaw) < cap || this.store.sponsoredToday() >= budget) return;
    this.state.sponsorEnabled = true;
    const recipients = [...new Set(this.store.list<Award>('awards').filter(a => a.status === 'funded').map(a => a.recipient))];
    for (const recipient of recipients) {
      if (this.sponsorBusy.has(recipient) || Date.now() - (this.sponsoredAt.get(recipient) || 0) < 60_000) continue;
      const wallet = await this.wallet(recipient);
      if (BigInt(wallet.eligibleUnlockRaw) === 0n) continue;
      const api = this.requireApi();
      // The sponsor can only submit this permissionless operation, never a treasury call.
      const call = api.tx.vesting.vestOther(recipient);
      const info = await call.paymentInfo(this.sponsor.address);
      const estimated = BigInt(info.partialFee.toString());
      if (estimated > cap || this.store.sponsoredToday() + cap > budget) continue;
      this.sponsorBusy.add(recipient);
      this.sponsoredAt.set(recipient, Date.now());
      try {
        await call.signAsync(this.sponsor, { nonce: -1 });
        // Reserve the full fee allowance before broadcast, including across restarts.
        this.store.db.prepare('INSERT OR IGNORE INTO sponsored VALUES (?, ?, ?)')
          .run(call.hash.toHex(), new Date().toISOString().slice(0, 10), cap.toString());
        await new Promise<string>((resolve, reject) => {
          let unsub: (() => void) | undefined;
          let settled = false;
          const finish = (error?: Error, hash?: string) => {
            if (settled) return;
            settled = true; clearTimeout(timeout); unsub?.();
            if (error) reject(error); else resolve(hash!);
          };
          const timeout = setTimeout(() => finish(new Error('Sponsored unlock confirmation timed out.')), 90_000);
          void call.send(result => {
            if (result.status.isDropped || result.status.isInvalid || result.status.isUsurped) finish(new Error('Sponsored unlock was dropped.'));
            else if (result.status.isFinalized) {
              if (result.dispatchError) finish(new Error('Sponsored unlock failed.'));
              else finish(undefined, result.txHash.toHex());
            }
          }).then(fn => { unsub = fn; if (settled) fn(); }).catch(error => finish(error));
        });
      } finally { this.sponsorBusy.delete(recipient); }
    }
  }
  async close() { if (this.timer) clearInterval(this.timer); await this.api?.disconnect(); }
}
