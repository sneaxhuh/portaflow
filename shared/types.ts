export const NETWORK = {
  name: 'Portaldot V3 Testnet',
  rpc: 'wss://test-node-v3.portaldot.dev',
  genesis: '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd',
  symbol: 'tPOT', decimals: 14, ss58: 42,
  explorer: 'https://scanner-testnet-v3.portaldot.dev/',
};

export type Treasury = {
  id: string; name: string; address: string; signatories: string[];
  threshold: number; creator: string; createdAt: string; createdBlock?: number;
};
export type Award = {
  id: string; treasuryId: string; title: string; recipient: string; workUrl: string;
  totalRaw: string; upfrontRaw: string; lockedRaw: string; perBlockRaw: string;
  startBlock: number; durationBlocks: number; endBlock: number;
  createdAt: string; createdBy: string; createdBlock: number;
  status: 'draft' | 'awaiting_approval' | 'funded' | 'cancelled' | 'failed';
  callHex?: string; callHash?: string; termsHash?: string; specVersion?: number;
  fundingBlock?: number; fundingTx?: string; failure?: string;
};
export type NetworkState = {
  connected: boolean; verified: boolean; name: string; genesis: string;
  finalizedBlock: number; bestBlock: number; specVersion: number;
  blockSeconds: number; existentialDepositRaw: string; minVestedRaw: string;
  maxSchedules: number; depositBaseRaw: string; depositFactorRaw: string;
  lastSyncedBlock: number; error?: string; historyError?: string; sponsorEnabled: boolean;
};
export type WalletState = {
  address: string; freeRaw: string; reservedRaw: string; frozenRaw: string;
  spendableRaw: string; vestingLockRaw: string; remainingLockedRaw: string;
  eligibleUnlockRaw: string;
  schedules: { lockedRaw: string; perBlockRaw: string; startBlock: number }[];
};
export type PendingApproval = {
  approvals: string[]; depositor: string; depositRaw: string;
  timepoint: { height: number; index: number };
};
export type Receipt = {
  txHash: string; blockHash: string; blockNumber: number; awardId: string;
  extrinsicIndex?: number;
  kind: 'approval' | 'funding' | 'cancellation' | 'unlock' | 'failed';
  signer: string; feeRaw: string; events: { section: string; method: string; data: unknown }[];
  timestamp: string;
};
export type AwardDetail = {
  award: Award; treasury: Treasury; pending: PendingApproval | null;
  wallet: WalletState | null; vestedRaw: string; remainingRaw: string;
  receipts: Receipt[]; reviewRequired: boolean;
};
export type TransactionPlan = {
  callHex: string; feeRaw: string; depositRaw: string; signer: string;
  genesis: string; specVersion: number; kind: string;
  storageDepositRaw?: string;
};
export type Overview = {
  network: NetworkState; treasuries: Treasury[]; awards: Award[];
  rounds?: PayoutRound[];
  invoiceBatches?: import('./invoices.js').InvoiceBatch[];
  session: { address: string } | null;
};

export type PayoutRound = {
  id: string; treasuryId: string; title: string; awards: Award[];
  totalRaw: string; upfrontRaw: string; lockedRaw: string;
  createdAt: string; createdBy: string; createdBlock: number; startDelayBlocks: number;
  status: Award['status']; callHex?: string; callHash?: string; termsHash?: string;
  specVersion?: number; preparedBlock?: number; fundingBlock?: number; fundingTx?: string; failure?: string;
};
export type RoundDetail = {
  round: PayoutRound; treasury: Treasury; pending: PendingApproval | null;
  receipts: Receipt[]; reviewRequired: boolean;
};
export type LedgerEntry = {
  id: string; treasuryId: string; txHash: string; blockHash: string; blockNumber: number;
  extrinsicIndex: number; eventIndex: number; timestamp: string;
  direction: 'incoming' | 'outgoing'; counterparty: string; amountRaw: string;
};
export type TreasuryLedger = {
  wallet: WalletState; entries: LedgerEntry[]; coverageFromBlock: number; syncedToBlock: number;
  pendingRaw: string; draftsRaw: string; fundedRaw: string; signerFeesRaw: string;
  pendingDeposits: { proposalId: string; title: string; depositor: string; amountRaw: string }[];
  historyAvailable: boolean;
  historyError?: string;
};
export type ReceiptBundle = {
  application: 'PortaFlow'; version: 1 | 2; network: typeof NETWORK; treasury: Treasury;
  award?: Award; round?: PayoutRound; transactions: Receipt[];
};
export type Verification = {
  status: 'verified' | 'invalid' | 'unavailable'; subject: string; txHash?: string; blockNumber?: number;
  checks: { label: string; passed: boolean; detail: string }[];
};
export type RecipientPortal = {
  address: string; wallet: WalletState; awards: (Award & { roundId?: string; treasuryName: string })[];
  totalFundedRaw: string; totalImmediateRaw: string; totalVestedRaw: string;
};

export type ProgramReport = {
  version: 1; network: typeof NETWORK; treasury: Treasury; generatedAt: string;
  finalizedBlock: number; indexedBlock: number; historySynced: boolean;
  totals: { fundedRaw: string; immediateRaw: string; vestedRaw: string; remainingScheduledRaw: string;
    earnedByScheduleRaw: string; paymentCount: number; recipientCount: number; fundingTransactions: number;
    pendingProposals: number; draftProposals: number };
  payments: { id: string; roundId?: string; roundTitle?: string; title: string; recipient: string; workUrl: string;
    totalRaw: string; upfrontRaw: string; lockedRaw: string; remainingRaw: string; startBlock: number; endBlock: number;
    fundingTx: string; fundingBlock: number; receiptPath: string }[];
};
