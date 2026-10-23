import { ApiPromise, WsProvider } from '@polkadot/api';
import { randomUUID } from 'node:crypto';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { NETWORK, type Award, type NetworkState, type PendingApproval, type Receipt, type TransactionPlan, type Treasury, type WalletState, type PayoutRound } from '../shared/types.js';
import { vestedRemaining, UNIT, schedule } from '../shared/money.js';
import { normalizeAddress, sameAddress } from './identity.js';
import type { DataStore } from './store.js';
import { awardTermsHash, fundingCall, transactionFromCall, roundFundingCall, roundTermsHash } from '../shared/calls.js';

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
  private connecting?: Promise<void>;
  private walletReads = new Map<string, Promise<WalletState>>();
  private sponsor?: KeyringPair;
  private sponsorBusy = new Set<string>();
  private sponsoredAt = new Map<string, number>();
  constructor(public store: DataStore, public rpc = process.env.PORTAFLOW_RPC || NETWORK.rpc, public background = true) {}

  async ready() {
    if (this.api?.isConnected && this.state.verified) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async connect() {
    if (this.timer) clearInterval(this.timer);
    await this.api?.disconnect();
    this.state.connected = false;
    this.state.verified = false;
    const provider = new WsProvider(this.rpc, 6000, {}, 10_000);
    provider.on('disconnected', () => { this.state.connected = false; });
    provider.on('error', () => { this.state.error = 'The network connection is unavailable. Reconnecting…'; });
    const api = new ApiPromise({ provider, noInitWarn: true });
    this.api = api;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([api.isReadyOrError, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('The Portaldot RPC connection timed out. Please retry shortly.')), 20_000);
      })]);
    } catch (error) { await api.disconnect(); throw error; }
    finally { if (timeout) clearTimeout(timeout); }
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
    if (this.background && process.env.PORTAFLOW_SPONSOR_URI) {
      this.sponsor = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(process.env.PORTAFLOW_SPONSOR_URI);
    }
    await this.refreshHead();
    if (this.background) this.timer = setInterval(() => { void this.tick(); }, 6000);
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
  async synchronizeForApproval(budgetMs = 20_000) {
    await this.refreshHead();
    // Pin the required height: new finalized blocks must not move the goal
    // while an approval request is catching up with persisted history.
    const target = this.state.finalizedBlock;
    const deadline = Date.now() + budgetMs;
    do {
      const before = this.state.lastSyncedBlock;
      await this.scan();
      if (this.state.lastSyncedBlock >= target) return;
      if (Date.now() >= deadline) break;
      // Another serverless instance may own the scan lease. Give it time to
      // persist progress rather than spinning or immediately rejecting review.
      if (this.state.lastSyncedBlock <= before) await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    const remaining = Math.max(0, target - this.state.lastSyncedBlock);
    throw Object.assign(new Error(`Synchronizing payout history: ${remaining} blocks remaining (indexed #${this.state.lastSyncedBlock}, target #${target}). Progress is saved; retry review to continue.`), { statusCode: 503 });
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
    const key = hash.toHex() + ':' + address;
    const cached = this.walletReads.get(key);
    if (cached) return cached;
    const read = this.readWallet(address, hash).catch(error => { this.walletReads.delete(key); throw error; });
    if (this.walletReads.size >= 128) this.walletReads.delete(this.walletReads.keys().next().value!);
    this.walletReads.set(key, read);
    return read;
  }
  private async readWallet(address: string, hash: any): Promise<WalletState> {
    const api = this.requireApi();
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
  async pending(treasury: Treasury, award: { callHash?: string }): Promise<PendingApproval | null> {
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
    await this.store.saveAward(result);
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
    await this.synchronizeForApproval();
    const latest = (await this.store.award(award.id))!;
    if (['funded', 'cancelled', 'failed'].includes(latest.status)) throw new Error('This award has already been finalized. Refresh its receipt.');
    if (!treasury.signatories.includes(signer)) throw new Error('Only a treasury signer can approve this award.');
    const prepared = await this.prepare(latest, treasury);
    const pending = await this.pending(treasury, prepared);
    const others = treasury.signatories.filter(address => !sameAddress(address, signer));
    if (cancel) {
      if (!pending || !sameAddress(pending.depositor, signer)) throw new Error('Only the wallet that initiated this approval can cancel it.');
      return this.estimate(api.tx.multisig.cancelAsMulti(treasury.threshold, others, pending.timepoint, prepared.callHash!), signer, 'cancellation');
    }
    if (prepared.specVersion !== this.state.specVersion) throw new Error('The runtime changed. Cancel this proposal and create a new award to review the new call.');
    if (BigInt(prepared.lockedRaw) > 0n && this.state.bestBlock >= prepared.startBlock) throw new Error('The scheduled start has passed. Cancel this proposal and create a new award with a future start.');
    if (pending?.approvals.includes(signer)) throw new Error('This wallet has already approved. Another treasury signer must approve next.');
    const wallet = await this.wallet(treasury.address);
    if (BigInt(wallet.spendableRaw) < BigInt(prepared.totalRaw)) throw new Error('Fund the treasury before requesting approval. It must retain its minimum account balance.');
    const recipient = await this.wallet(prepared.recipient);
    if (BigInt(prepared.lockedRaw) > 0n && recipient.schedules.length >= this.state.maxSchedules) throw new Error('This recipient has reached the native vesting schedule limit.');
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
  async prepareRound(round: PayoutRound, treasury: Treasury) {
    const owner = randomUUID(), key = 'prepare-round:' + round.id;
    if (!await this.store.acquireLease(key, owner, 30_000)) throw new Error('Another signer is preparing this round. Try again shortly.');
    try {
      const latest = await this.store.round(round.id);
      if (!latest || !['draft', 'awaiting_approval'].includes(latest.status)) throw new Error('This round can no longer be prepared.');
      if (latest.callHex) return latest;
      const start = this.state.bestBlock + latest.startDelayBlocks;
      const awards = latest.awards.map(a => BigInt(a.lockedRaw) > 0n
        ? { ...a, startBlock: start, ...schedule(BigInt(a.lockedRaw), a.durationBlocks, start) } : a);
      const prepared = { ...latest, awards, preparedBlock: this.state.finalizedBlock, specVersion: this.state.specVersion };
      const batch = roundFundingCall(this.requireApi(), prepared, treasury);
      if (batch.method.encodedLength > 48_000) throw new Error('This round is too large. Create smaller rounds before requesting signatures.');
      const result = { ...prepared, callHex: batch.method.toHex(), callHash: batch.method.hash.toHex(), termsHash: roundTermsHash(prepared, treasury) };
      await this.store.saveRound(result);
      return result;
    } finally { await this.store.releaseLease(key, owner); }
  }
  async roundApprovalPlan(round: PayoutRound, treasury: Treasury, signer: string, cancel = false) {
    await this.synchronizeForApproval();
    const api = this.requireApi();
    const latest = (await this.store.round(round.id))!;
    if (['funded', 'cancelled', 'failed'].includes(latest.status)) throw new Error('This round has already been finalized.');
    if (!treasury.signatories.includes(signer)) throw new Error('Only a treasury signer can approve this round.');
    const prepared = await this.prepareRound(latest, treasury);
    const pending = await this.pending(treasury, prepared);
    const others = treasury.signatories.filter(a => !sameAddress(a, signer));
    if (cancel) {
      if (!pending || !sameAddress(pending.depositor, signer)) throw new Error('Only the initiating signer can cancel this proposal.');
      return this.estimate(api.tx.multisig.cancelAsMulti(treasury.threshold, others, pending.timepoint, prepared.callHash!), signer, 'cancellation');
    }
    if (prepared.specVersion !== this.state.specVersion) throw new Error('The runtime changed. Cancel this proposal and create a new round.');
    if (pending?.approvals.includes(signer)) throw new Error('This wallet has already approved the round.');
    if (prepared.awards.some(a => BigInt(a.lockedRaw) > 0n && this.state.bestBlock >= a.startBlock)) throw new Error('A vesting start has passed. Cancel and create a new round.');
    const treasuryWallet = await this.wallet(treasury.address);
    if (BigInt(treasuryWallet.spendableRaw) < BigInt(prepared.totalRaw)) throw new Error('The treasury cannot fund this complete round while retaining its minimum balance.');
    const recipients = [...new Set(prepared.awards.map(a => a.recipient))];
    const checkRecipient = async (recipient: string) => {
      const wallet = await this.wallet(recipient);
      const payments = prepared.awards.filter(a => a.recipient === recipient);
      const schedules = payments.filter(a => BigInt(a.lockedRaw) > 0n).length;
      if (wallet.schedules.length + schedules > this.state.maxSchedules) throw new Error('A recipient would exceed the native vesting schedule limit.');
      if (BigInt(wallet.freeRaw) + BigInt(payments[0].lockedRaw || '0') === 0n && BigInt(payments[0].upfrontRaw) < BigInt(this.state.existentialDepositRaw)) throw new Error('The first payment to a new recipient must cover the minimum account balance.');
    };
    for (let i = 0; i < recipients.length; i += 4) await Promise.all(recipients.slice(i, i + 4).map(checkRecipient));
    const inner = transactionFromCall(api, prepared.callHex!);
    const info = await inner.paymentInfo(treasury.address);
    const weight = info.weight;
    const maxWeight = { refTime: ((BigInt(weight.refTime.toString()) * 12n + 9n) / 10n).toString(),
      proofSize: ((BigInt(weight.proofSize.toString()) * 12n + 9n) / 10n).toString() };
    const maxBlock: any = (api.consts.system.blockWeights as any)?.maxBlock;
    if (maxBlock && (BigInt(maxWeight.refTime) > BigInt(maxBlock.refTime.toString()) * 3n / 4n
      || BigInt(maxWeight.proofSize) > BigInt(maxBlock.proofSize.toString()) * 3n / 4n)) throw new Error('This round exceeds the safe transaction weight. Split it into smaller rounds.');
    const final = Boolean(pending && pending.approvals.length + 1 >= treasury.threshold);
    const call = final ? api.tx.multisig.asMulti(treasury.threshold, others, pending!.timepoint, inner.method, maxWeight)
      : api.tx.multisig.approveAsMulti(treasury.threshold, others, pending?.timepoint ?? null, prepared.callHash!, maxWeight);
    const deposit = pending ? 0n : BigInt(this.state.depositBaseRaw) + BigInt(treasury.threshold) * BigInt(this.state.depositFactorRaw);
    return this.estimate(call, signer, final ? 'funding' : 'approval', deposit);
  }
  async unlockPlan(recipient: string, signer: string) {
    const api = this.requireApi();
    if (BigInt((await this.wallet(recipient)).eligibleUnlockRaw) === 0n) throw new Error('There are no vested funds waiting to be unlocked.');
    return this.estimate(api.tx.vesting.vestOther(recipient), signer, 'unlock');
  }
  async scan() {
    if (this.scanning) return this.scanning;
    const owner = randomUUID();
    this.scanning = (async () => {
      if (!await this.store.acquireLease('chain:' + NETWORK.genesis, owner, 120_000)) {
        this.state.lastSyncedBlock = Number(await this.store.getMeta('cursor:' + NETWORK.genesis) ?? 0);
        return;
      }
      try { await this.scanBlocks(owner); }
      finally { await this.store.releaseLease('chain:' + NETWORK.genesis, owner); }
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private async scanBlocks(owner: string) {
    const api = this.requireApi();
    const cursorKey = 'cursor:' + NETWORK.genesis;
    const savedCursor = await this.store.getMeta(cursorKey);
    // Only prepared calls can have matching on-chain activity. Their creation
    // block precedes signing, so older history cannot contain an award receipt.
    const preparedAwards = [...await this.store.list<Award>('awards'), ...await this.store.list<PayoutRound>('rounds')].filter(award => award.callHash);
    const treasuries = await this.store.list<Treasury>('treasuries');
    const startingBlocks = [...preparedAwards.map(a => a.createdBlock), ...treasuries.map(t => t.createdBlock).filter((b): b is number => b !== undefined)];
    const earliestRelevantBlock = startingBlocks.length ? Math.min(...startingBlocks, this.state.finalizedBlock) : this.state.finalizedBlock;
    // Never jump a saved cursor to the current head: ordinary treasury deposits
    // must be indexed even when there are no prepared award proposals.
    let cursor = Number(savedCursor ?? earliestRelevantBlock);
    this.state.lastSyncedBlock = cursor;
    if (await this.store.getMeta('ledger:from') === undefined) await this.store.setMeta('ledger:from', String(cursor + 1));
    const end = Math.min(this.state.finalizedBlock, cursor + (this.background ? 120 : 24));
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
      if (!await this.store.acquireLease('chain:' + NETWORK.genesis, owner, 120_000)) return;
      // Most blocks have no award activity. Avoid downloading their extrinsics
      // or constructing a historical API just to advance the receipt cursor.
      const relevant = records.some(({ event }: any) => event.section === 'multisig' || event.section === 'balances' && event.method === 'Transfer'
        || event.section === 'vesting' && ['VestingUpdated', 'VestingCompleted'].includes(event.method));
      if (!relevant) {
        cursor = blockNumber;
        await this.store.setMeta(cursorKey, String(cursor));
        this.state.lastSyncedBlock = cursor;
        continue;
      }
      await this.indexBlock(hash.toHex(), blockNumber, records);
      cursor = blockNumber;
      await this.store.setMeta(cursorKey, String(cursor));
      this.state.lastSyncedBlock = cursor;
      }
    }
    await this.store.setMeta(cursorKey, String(cursor));
    this.state.lastSyncedBlock = cursor;
  }
  private async indexBlock(blockHash: string, blockNumber: number, suppliedRecords?: any, txHash?: string) {
      const api = this.requireApi();
      const [block, timestamp, records]: any[] = await Promise.all([api.rpc.chain.getBlock(blockHash), api.query.timestamp.now.at(blockHash),
        suppliedRecords ?? api.query.system.events.at(blockHash)]);
      if (txHash && !block.block.extrinsics.some((tx: any) => tx.hash.toHex() === txHash)) throw new Error('The transaction is not present in this finalized block.');
      const awards = await this.store.list<Award>('awards');
      const rounds = await this.store.list<PayoutRound>('rounds');
      const treasuries = await this.store.list<Treasury>('treasuries');
      for (let index = 0; index < block.block.extrinsics.length; index++) {
        const events: any[] = records.filter((record: any) => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === index).map((record: any) => record.event);
        const tx = block.block.extrinsics[index];
        const fee = events.find(event => event.section === 'transactionPayment' && event.method === 'TransactionFeePaid');
        const base = { txHash: tx.hash.toHex(), blockHash, blockNumber, extrinsicIndex: index,
          signer: tx.isSigned ? tx.signer.toString() : '', feeRaw: fee ? fee.data[1].toString() : '0',
          timestamp: new Date(Number(timestamp.toString())).toISOString(),
          events: events.map(event => ({ section: event.section, method: event.method, data: event.data.toJSON() })) };
        for (const event of events) {
          if (event.section === 'balances' && event.method === 'Transfer') {
            const from = normalizeAddress(event.data[0].toString()), to = normalizeAddress(event.data[1].toString());
            const eventIndex = records.findIndex((r: any) => r.event === event);
            for (const treasury of treasuries) {
              if (from !== treasury.address && to !== treasury.address) continue;
              await this.store.saveLedger({ id: `${blockHash}:${eventIndex}:${treasury.id}`, treasuryId: treasury.id,
                txHash: base.txHash, blockHash, blockNumber, extrinsicIndex: index, eventIndex, timestamp: base.timestamp,
                direction: to === treasury.address ? 'incoming' : 'outgoing', counterparty: to === treasury.address ? from : to,
                amountRaw: event.data[2].toString() });
            }
          }
          if (event.section === 'multisig') {
            const isNew = event.method === 'NewMultisig';
            if (!['NewMultisig', 'MultisigApproval', 'MultisigExecuted', 'MultisigCancelled'].includes(event.method)) continue;
            const callHash = event.data[isNew ? 2 : 3].toHex();
            const award = awards.find(item => item.callHash === callHash);
            const round = rounds.find(item => item.callHash === callHash);
            if (round) {
              const treasury = treasuries.find(t => t.id === round.treasuryId)!;
              if (!sameAddress(event.data[isNew ? 1 : 2].toString(), treasury.address)) continue;
              let kind: Receipt['kind'] = 'approval';
              if (event.method === 'MultisigExecuted') {
                const success = fundingSucceeded(event.data[4].isOk, events.map(e => e.method));
                kind = success ? 'funding' : 'failed';
                if (!['funded', 'failed', 'cancelled'].includes(round.status)) {
                  round.status = success ? 'funded' : 'failed';
                  if (success) { round.fundingBlock = blockNumber; round.fundingTx = base.txHash; }
                  else round.failure = 'The atomic batch failed. No payments in this round were confirmed.';
                }
              } else if (event.method === 'MultisigCancelled') { if (!['funded', 'failed', 'cancelled'].includes(round.status)) round.status = 'cancelled'; kind = 'cancellation'; }
              else if (!['funded', 'cancelled', 'failed'].includes(round.status)) round.status = 'awaiting_approval';
              round.awards = round.awards.map(a => ({ ...a, status: round.status, fundingBlock: round.fundingBlock, fundingTx: round.fundingTx }));
              await this.store.saveRound(round);
              await this.store.saveReceipt({ ...base, awardId: round.id, kind });
            }
            if (!award) continue;
            const treasury = (await this.store.treasury(award.treasuryId))!;
            if (!sameAddress(event.data[isNew ? 1 : 2].toString(), treasury.address)) continue;
            let kind: Receipt['kind'] = 'approval';
            const terminal = ['funded', 'cancelled', 'failed'].includes(award.status);
            if (event.method === 'MultisigExecuted') {
              const success = fundingSucceeded(event.data[4].isOk, events.map(e => e.method));
              kind = success ? 'funding' : 'failed';
              if (!terminal) {
                award.status = success ? 'funded' : 'failed';
                if (success) { award.fundingBlock = blockNumber; award.fundingTx = base.txHash; }
                else award.failure = 'The multisig inner call failed. No award funding was confirmed. Review the receipt before creating a replacement.';
              }
            } else if (event.method === 'MultisigCancelled') { if (!terminal) award.status = 'cancelled'; kind = 'cancellation'; }
            else if (!terminal) award.status = 'awaiting_approval';
            await this.store.saveAward(award);
            await this.store.saveReceipt({ ...base, awardId: award.id, kind });
          }
          if (event.section === 'vesting' && ['VestingUpdated', 'VestingCompleted'].includes(event.method)
            && tx.method.section === 'vesting' && ['vest', 'vestOther'].includes(tx.method.method)) {
            for (const award of awards.filter(item => item.status === 'funded' && sameAddress(item.recipient, event.data[0].toString()))) {
              await this.store.saveReceipt({ ...base, awardId: award.id, kind: 'unlock' });
            }
            for (const round of rounds.filter(item => item.status === 'funded' && item.awards.some(a => sameAddress(a.recipient, event.data[0].toString())))) {
              await this.store.saveReceipt({ ...base, awardId: round.id, kind: 'unlock' });
            }
          }
        }
      }
  }
  async syncTransactions(transactions: { txHash: string; blockHash: string }[]) {
    await this.refreshHead();
    const api = this.requireApi();
    const owner = randomUUID(), key = 'chain:' + NETWORK.genesis;
    if (!await this.store.acquireLease(key, owner, 120_000)) throw new Error('Receipt syncing is already in progress. Retrying shortly.');
    const accepted: string[] = [];
    try {
      for (const tx of transactions) {
        const header = await api.rpc.chain.getHeader(tx.blockHash);
        const height = header.number.toNumber();
        if (height > this.state.finalizedBlock || (await api.rpc.chain.getBlockHash(height)).toHex() !== tx.blockHash) throw new Error('The submitted block is not on the finalized Portaldot chain.');
        if (!await this.store.acquireLease(key, owner, 120_000)) throw new Error('Receipt sync lease expired. Please retry.');
        await this.indexBlock(tx.blockHash, height, undefined, tx.txHash);
        accepted.push(tx.txHash);
      }
    } finally { await this.store.releaseLease(key, owner); }
    return accepted;
  }
  async runSponsor() {
    this.state.sponsorEnabled = false;
    if (!this.sponsor) return;
    const cap = BigInt(process.env.PORTAFLOW_SPONSOR_MAX_FEE_RAW || String(UNIT / 10n));
    const budget = BigInt(process.env.PORTAFLOW_SPONSOR_DAILY_BUDGET_RAW || String(UNIT));
    const sponsorWallet = await this.wallet(this.sponsor.address);
    if (BigInt(sponsorWallet.spendableRaw) < cap || await this.store.sponsoredToday() >= budget) return;
    this.state.sponsorEnabled = true;
    const payments = [...(await this.store.list<Award>('awards')).filter(a => a.status === 'funded'),
      ...(await this.store.list<PayoutRound>('rounds')).filter(r => r.status === 'funded').flatMap(r => r.awards)];
    const recipients = [...new Set(payments.filter(a => BigInt(a.lockedRaw) > 0n).map(a => a.recipient))];
    for (const recipient of recipients) {
      if (this.sponsorBusy.has(recipient) || Date.now() - (this.sponsoredAt.get(recipient) || 0) < 60_000) continue;
      const wallet = await this.wallet(recipient);
      if (BigInt(wallet.eligibleUnlockRaw) === 0n) continue;
      const api = this.requireApi();
      // The sponsor can only submit this permissionless operation, never a treasury call.
      const call = api.tx.vesting.vestOther(recipient);
      const info = await call.paymentInfo(this.sponsor.address);
      const estimated = BigInt(info.partialFee.toString());
      if (estimated > cap || await this.store.sponsoredToday() + cap > budget) continue;
      this.sponsorBusy.add(recipient);
      this.sponsoredAt.set(recipient, Date.now());
      try {
        await call.signAsync(this.sponsor, { nonce: -1 });
        // Reserve the full fee allowance before broadcast, including across restarts.
        await this.store.reserveSponsored(call.hash.toHex(), new Date().toISOString().slice(0, 10), cap.toString());
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
