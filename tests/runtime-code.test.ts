import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compactAddLength,hexToU8a,u8aToHex} from '@polkadot/util';
import {matchesRuntimeCode} from '../shared/runtime-code';
import type {Hex} from 'viem';

const artifact=JSON.parse(readFileSync('contracts/artifacts/InvoiceSettlement.json','utf8'));
const raw=artifact.deployedBytecode as Hex, hash=artifact.runtimeCodeHash as Hex;
test('Revive code verification accepts exact raw bytecode and the canonical native SCALE Bytes envelope',()=>{
  const wrapped=u8aToHex(compactAddLength(hexToU8a(raw)));
  assert.equal(wrapped.slice(0,6),'0x2925'); // Observed on Portaldot at deployment block 207101.
  assert.equal(matchesRuntimeCode(raw,hash),true);
  assert.equal(matchesRuntimeCode(wrapped,hash),true);
});
test('Revive code verification rejects modified code, mismatched lengths, noncanonical and repeated envelopes',()=>{
  const wrapped=u8aToHex(compactAddLength(hexToU8a(raw)));
  assert.equal(matchesRuntimeCode((raw.slice(0,-2)+'00') as Hex,hash),false);
  assert.equal(matchesRuntimeCode(('0x2926'+raw.slice(2)) as Hex,hash),false);
  assert.equal(matchesRuntimeCode(('0x2a250000'+raw.slice(2)) as Hex,hash),false);
  assert.equal(matchesRuntimeCode(u8aToHex(compactAddLength(hexToU8a(wrapped))),hash),false);
  assert.equal(matchesRuntimeCode('0x',hash),false);
});
