import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {encodeFunctionData,keccak256,stringToHex,zeroAddress,type Hex} from 'viem';
import {Store} from '../server/store.js';
import {Chain} from '../server/chain.js';
import {NETWORK} from '../shared/types.js';
import {matchesRuntimeCode} from '../shared/runtime-code.js';
import {settlementAbi} from '../shared/settlement-abi.js';
import artifact from '../contracts/artifacts/InvoiceSettlement.json' with{type:'json'};
const payer=process.argv[2],recipient=process.argv[3],router=process.argv[4];
if(!payer||!recipient||!/^0x[0-9a-f]{40}$/i.test(router||''))throw new Error('Usage: node --import tsx scripts/measure-settlement.ts NATIVE_TREASURY NATIVE_RECIPIENT CONTRACT');
const store=new Store(':memory:'),chain=new Chain(store,process.env.PORTAFLOW_RPC||NETWORK.rpc,false);
try{
 await chain.ready();const api=chain.requireApi(),head=await api.rpc.chain.getFinalizedHead(),at=await api.at(head);
 if(!matchesRuntimeCode((await(at.call as any).reviveApi.code(router)).toHex(),artifact.runtimeCodeHash as Hex))throw new Error('The benchmark requires the reviewed settlement contract.');
 const target=(await(at.call as any).reviveApi.address(recipient)).toString();
 const simulations=[];
 for(const count of [1,2,5]){
  // Fresh identifiers exist only in this RPC simulation. No invoices are created or signed.
  const payments=Array.from({length:count},(_,n)=>({invoiceId:keccak256(stringToHex('simulation-only:'+head.toHex()+':'+count+':'+n)),termsHash:keccak256(stringToHex('simulation-only terms')),recipient:target,amount:10n**18n}));
  const input=encodeFunctionData({abi:settlementAbi,functionName:'settle',args:[zeroAddress,payments]});
  const result:any=await(at.call as any).reviveApi.call(payer,router,(10n**14n*BigInt(count)).toString(),null,null,input);
  simulations.push({count,result:result.toJSON()});
 }
 const solc=createRequire(import.meta.url)('solc'),source=readFileSync('contracts/InvoiceSettlement.sol','utf8');
 const compilerComparisons=[1,50,200].map(runs=>{
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'InvoiceSettlement.sol':{content:source}},settings:{optimizer:{enabled:true,runs},evmVersion:'paris',metadata:{bytecodeHash:'none',appendCBOR:false},outputSelection:{'*':{'*':['evm.bytecode.object','evm.deployedBytecode.object']}}}})));
  const errors=(output.errors||[]).filter((e:any)=>e.severity==='error');if(errors.length)throw new Error(errors[0].formattedMessage);
  const code=output.contracts['InvoiceSettlement.sol'].InvoiceSettlement.evm;
  return{runs,creationBytes:code.bytecode.object.length/2,runtimeBytes:code.deployedBytecode.object.length/2,estimatedCodeBytesDepositRaw:(BigInt(code.bytecode.object.length/2)*BigInt(api.consts.revive.depositPerByte.toString())).toString()};
 });
 console.log(JSON.stringify({mode:'read-only simulation; no transactions submitted',endpoint:chain.rpc,blockHash:head.toHex(),constants:{perByteRaw:api.consts.revive.depositPerByte.toString(),perItemRaw:api.consts.revive.depositPerChildTrieItem.toString()},simulations,compilerComparisons},null,2));
}finally{await chain.close();await store.close();}
