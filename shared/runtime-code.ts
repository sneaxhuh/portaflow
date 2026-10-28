import { compactFromU8a, compactToU8a, hexToU8a, u8aToHex } from '@polkadot/util';
import { keccak256, type Hex } from 'viem';

/** Some Revive runtime APIs return a SCALE Bytes envelope inside the outer Bytes result. */
export function matchesRuntimeCode(value: Hex, expectedHash: Hex): boolean {
  if (!/^0x(?:[a-f0-9]{2})*$/i.test(value)) return false;
  if (keccak256(value) === expectedHash) return true;
  try {
    const bytes = hexToU8a(value);
    const [offset, length] = compactFromU8a(bytes);
    if (BigInt(length.toString()) !== BigInt(bytes.length - offset)) return false;
    const canonical = compactToU8a(bytes.length - offset);
    if (u8aToHex(bytes.subarray(0, offset)) !== u8aToHex(canonical)) return false;
    return keccak256(u8aToHex(bytes.subarray(offset))) === expectedHash;
  } catch { return false; }
}
