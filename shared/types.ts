export const NETWORK = {
  name: 'Portaldot V3 Testnet',
  rpc: 'wss://test-node-v3.portaldot.dev',
  genesis: '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd',
  symbol: 'tPOT', decimals: 14, ss58: 42,
  explorer: 'https://node-console.portaldot.dev/',
};

export type Treasury = {
  id: string; name: string; address: string; signatories: string[];
  threshold: number; creator: string; createdAt: string;
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
  lastSyncedBlock: number; error?: string; sponsorEnabled: boolean;
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
};
export type Overview = {
  network: NetworkState; treasuries: Treasury[]; awards: Award[];
  session: { address: string } | null;
};
