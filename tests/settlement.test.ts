import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createVM } from '@ethereumjs/vm';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createAccount, createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, keccak256, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { settlementAbi } from '../shared/settlement-abi';

const artifact = JSON.parse(readFileSync('contracts/artifacts/InvoiceSettlement.json', 'utf8'));
const account = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Address;
const payer = account(101), recipient = account(102), other = account(103);
const payment = (n: number, to = recipient) => ({ invoiceId: ('0x' + n.toString(16).padStart(64, '0')) as Hex,
  termsHash: ('0x' + (n + 100).toString(16).padStart(64, '0')) as Hex, recipient: to, amount: 10_000n });

async function setup() {
  const vm = await createVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Cancun }) });
  for (const address of [payer, other]) await vm.stateManager.putAccount(createAddressFromString(address), createAccount({ balance: 10n ** 23n }));
  const deployment = await vm.evm.runCall({ caller: createAddressFromString(payer), data: hexToBytes(artifact.bytecode), gasLimit: 20_000_000n });
  assert.equal(deployment.execResult.exceptionError, undefined);
  const router = deployment.createdAddress!.toString() as Address;
  const call = (data: Hex, value = 0n, from = payer, to = router) => vm.evm.runCall({ caller: createAddressFromString(from), origin: createAddressFromString(from), to: createAddressFromString(to), data: hexToBytes(data), value, gasLimit: 20_000_000n });
  const settle = (payments: ReturnType<typeof payment>[], token: Address = zeroAddress, value = payments.reduce((n,p) => n + p.amount, 0n), from = payer) => call(encodeFunctionData({ abi: settlementAbi, functionName: 'settle', args: [token, payments] }), value, from);
  const settled = async (id: Hex, from = payer) => {
    const r = await call(encodeFunctionData({ abi: settlementAbi, functionName: 'settled', args: [from, id] }));
    return decodeFunctionResult({ abi: settlementAbi, functionName: 'settled', data: bytesToHex(r.execResult.returnValue) });
  };
  const balance = async (address: Address) => (await vm.stateManager.getAccount(createAddressFromString(address)))?.balance || 0n;
  const deploy = async (source: string, name: string) => {
    const solc = createRequire(import.meta.url)('solc');
    const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Helper.sol': { content: source } }, settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['evm.bytecode.object'] } } } })));
    const r = await vm.evm.runCall({ caller: createAddressFromString(payer), data: hexToBytes(('0x' + compiled.contracts['Helper.sol'][name].evm.bytecode.object) as Hex), gasLimit: 20_000_000n });
    assert.equal(r.execResult.exceptionError, undefined); return r.createdAddress!.toString() as Address;
  };
  return { vm, router, call, settle, settled, balance, deploy };
}
test('compiled settlement transfers a batch, leaves no payment balance, and emits exact invoice evidence', async () => {
  const s = await setup(), a = payment(1), b = payment(2, other), before = await s.balance(recipient);
  const r = await s.settle([a,b]);
  assert.equal(r.execResult.exceptionError, undefined);
  assert.equal(await s.balance(recipient), before + a.amount);
  assert.equal(await s.balance(s.router), 0n);
  assert.equal(await s.settled(a.invoiceId), a.termsHash);
  const logs = r.execResult.logs!.map(([, topics, data]) => decodeEventLog({ abi: settlementAbi, topics: topics.map(bytesToHex) as [Hex,...Hex[]], data: bytesToHex(data) }));
  assert.deepEqual(logs.map(l=>l.eventName), ['InvoiceSettled','InvoiceSettled','BatchSettled']);
  assert.equal(keccak256(bytesToHex(await s.vm.stateManager.getCode(createAddressFromString(s.router)))), artifact.runtimeCodeHash);
});
test('settlement rejects a repeat, including altered terms, and rolls back a batch containing a duplicate', async () => {
  const s = await setup(), a = payment(1), b = payment(2);
  assert.equal((await s.settle([a])).execResult.exceptionError, undefined);
  const before = await s.balance(recipient);
  assert.ok((await s.settle([{ ...a, termsHash: b.termsHash }])).execResult.exceptionError);
  assert.ok((await s.settle([b,a])).execResult.exceptionError);
  assert.equal(await s.settled(b.invoiceId), zeroHash); assert.equal(await s.balance(recipient), before);
  assert.ok((await s.settle([b,b])).execResult.exceptionError);
});
test('another payer cannot mark a treasury invoice settled or affect its replay protection', async () => {
  const s = await setup(), a = payment(1);
  assert.equal((await s.settle([a], zeroAddress, a.amount, other)).execResult.exceptionError, undefined);
  assert.equal(await s.settled(a.invoiceId), zeroHash);
  assert.equal((await s.settle([a])).execResult.exceptionError, undefined);
});
test('failed recipient, wrong total, invalid native precision and excessive batch size all revert without paid markers', async () => {
  const s = await setup();
  const reject = await s.deploy('pragma solidity ^0.8.24; contract Reject { receive() external payable { revert(); } }', 'Reject');
  const a = payment(1), b = payment(2,reject), before = await s.balance(recipient);
  assert.ok((await s.settle([a,b])).execResult.exceptionError);
  assert.equal(await s.settled(a.invoiceId), zeroHash); assert.equal(await s.balance(recipient), before);
  assert.ok((await s.settle([a],zeroAddress,1n)).execResult.exceptionError);
  assert.ok((await s.settle([{...a,amount:1n}])).execResult.exceptionError);
  assert.ok((await s.settle(Array.from({length:26},(_,i)=>payment(i+1)))).execResult.exceptionError);
});
test('asset settlement rejects false and short transfers and consumes the exact allowance on success', async () => {
  const s = await setup();
  const token = await s.deploy(`pragma solidity ^0.8.24; contract Token {
    mapping(address=>uint) public balanceOf; mapping(address=>mapping(address=>uint)) public allowance; uint public mode;
    constructor(){balanceOf[msg.sender]=1000000;} function setMode(uint v) external {mode=v;}
    function approve(address s,uint n) external returns(bool){allowance[msg.sender][s]=n;return true;}
    function transferFrom(address f,address t,uint n) external returns(bool){if(mode==1)return false;require(allowance[f][msg.sender]>=n);allowance[f][msg.sender]-=n;balanceOf[f]-=n;balanceOf[t]+=mode==2?n-1:n;return true;}}
    `,'Token');
  const { parseAbi } = await import('viem');
  const abi=parseAbi(['function approve(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)','function setMode(uint256)']);
  await s.call(encodeFunctionData({abi,functionName:'approve',args:[s.router,20000n]}),0n,payer,token);
  const a=payment(1), b=payment(2);
  assert.equal((await s.settle([a,b],token,0n)).execResult.exceptionError,undefined);
  const allowance=await s.call(encodeFunctionData({abi,functionName:'allowance',args:[payer,s.router]}),0n,payer,token);
  assert.equal(decodeFunctionResult({abi,functionName:'allowance',data:bytesToHex(allowance.execResult.returnValue)}),0n);
  await s.call(encodeFunctionData({abi,functionName:'approve',args:[s.router,20000n]}),0n,payer,token);
  for(const mode of [1n,2n]){
    await s.call(encodeFunctionData({abi,functionName:'setMode',args:[mode]}),0n,payer,token);
    assert.ok((await s.settle([payment(3)],token,0n)).execResult.exceptionError);
    assert.equal(await s.settled(payment(3).invoiceId),zeroHash);
  }
});
test('recipient callbacks cannot reenter settlement while the outer batch completes',async()=>{
 const s=await setup();
 const receiver=await s.deploy(`pragma solidity ^0.8.24;
 interface I {struct P{bytes32 invoiceId;bytes32 termsHash;address recipient;uint amount;}function settle(address,I.P[] calldata)external payable;}
 contract Receiver{bool public blocked;receive()external payable{I.P[] memory p=new I.P[](0);(bool ok,bytes memory reason)=msg.sender.call(abi.encodeCall(I.settle,(address(0),p)));blocked=!ok&&reason.length>=4&&bytes4(reason)==bytes4(keccak256("ReentrantCall()"));}}`,'Receiver');
 assert.equal((await s.settle([payment(1,receiver)])).execResult.exceptionError,undefined);
 const {parseAbi}=await import('viem'),abi=parseAbi(['function blocked() view returns (bool)']);
 const r=await s.call(encodeFunctionData({abi,functionName:'blocked'}),0n,payer,receiver);
 assert.equal(decodeFunctionResult({abi,functionName:'blocked',data:bytesToHex(r.execResult.returnValue)}),true);
});
