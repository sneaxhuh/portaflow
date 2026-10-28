// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IInvoiceToken {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Immediate, atomic payments. Treasury custody remains outside this contract.
contract InvoiceSettlement {
    uint256 public constant WEI_PER_PLANCK = 10_000;
    struct Payment { bytes32 invoiceId; bytes32 termsHash; address recipient; uint256 amount; }
    mapping(address => mapping(bytes32 => bytes32)) public settled;
    bool private entered;

    error InvalidPayment();
    error AlreadySettled(bytes32 invoiceId);
    error WrongValue();
    error TransferFailed();
    error ReentrantCall();

    event InvoiceSettled(address indexed payer, bytes32 indexed invoiceId, bytes32 termsHash, address token, address recipient, uint256 amount);
    event BatchSettled(address indexed payer, bytes32 indexed batchHash, address token, uint256 total, uint256 count);

    function settle(address token, Payment[] calldata payments) external payable {
        if (entered) revert ReentrantCall();
        if (payments.length == 0 || payments.length > 25 || token == address(this)) revert InvalidPayment();
        entered = true;
        uint256 total;
        for (uint256 i; i < payments.length; ++i) {
            Payment calldata p = payments[i];
            if (p.invoiceId == bytes32(0) || p.termsHash == bytes32(0) || p.amount == 0 ||
                p.recipient == address(0) || p.recipient == address(this) || p.recipient == msg.sender) revert InvalidPayment();
            if (token == address(0) && p.amount % WEI_PER_PLANCK != 0) revert InvalidPayment();
            if (settled[msg.sender][p.invoiceId] != bytes32(0)) revert AlreadySettled(p.invoiceId);
            settled[msg.sender][p.invoiceId] = p.termsHash;
            total += p.amount;
        }
        if (msg.value != (token == address(0) ? total : 0)) revert WrongValue();
        for (uint256 i; i < payments.length; ++i) {
            Payment calldata p = payments[i];
            if (token == address(0)) {
                (bool ok,) = p.recipient.call{value: p.amount}("");
                if (!ok) revert TransferFailed();
            } else {
                uint256 beforeBalance = IInvoiceToken(token).balanceOf(p.recipient);
                (bool ok, bytes memory result) = token.call(abi.encodeCall(IInvoiceToken.transferFrom, (msg.sender, p.recipient, p.amount)));
                if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TransferFailed();
                uint256 afterBalance = IInvoiceToken(token).balanceOf(p.recipient);
                if (afterBalance < beforeBalance || afterBalance - beforeBalance != p.amount) revert TransferFailed();
            }
            emit InvoiceSettled(msg.sender, p.invoiceId, p.termsHash, token, p.recipient, p.amount);
        }
        emit BatchSettled(msg.sender, keccak256(abi.encode(token, payments)), token, total, payments.length);
        entered = false;
    }
}
