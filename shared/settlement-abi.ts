import { parseAbi } from 'viem';
export const settlementAbi = parseAbi([
  'function settled(address payer, bytes32 invoiceId) view returns (bytes32)',
  'function settle(address token, (bytes32 invoiceId, bytes32 termsHash, address recipient, uint256 amount)[] payments) payable',
  'event InvoiceSettled(address indexed payer, bytes32 indexed invoiceId, bytes32 termsHash, address token, address recipient, uint256 amount)',
  'event BatchSettled(address indexed payer, bytes32 indexed batchHash, address token, uint256 total, uint256 count)',
  'error InvalidPayment()', 'error AlreadySettled(bytes32 invoiceId)', 'error WrongValue()', 'error TransferFailed()', 'error ReentrantCall()',
]);
export const invoiceTokenAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
