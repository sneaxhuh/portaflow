import test from 'node:test';
import assert from 'node:assert/strict';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { zeroAddress, zeroHash, type Hex } from 'viem';
import { Store } from '../server/store';
import { Chain } from '../server/chain';
import { InvoiceChain } from '../server/invoice-chain';
import { createApp } from '../server/app';
import { sessionHash } from '../server/identity';
import { treasuryIdentity } from '../shared/accounts';
import { NATIVE_ASSET, invoiceId, invoiceTermsHash, invoiceMessage, verifyInvoiceSignature, parseAssetAmount, formatAssetAmount, type Invoice, type InvoiceBatch } from '../shared/invoices';
import type { Treasury } from '../shared/types';

await cryptoWaitReady();
const ring=new Keyring({type:'sr25519',ss58Format:42});
// Public development accounts, used only in isolated in-memory tests.
const one=ring.addFromUri('//Alice'), two=ring.addFromUri('//Bob'), contributor=ring.addFromUri('//Charlie'), outsider=ring.addFromUri('//Dave');
const treasury:Treasury={id:'team',name:'Team',...treasuryIdentity([one.address,two.address],2),threshold:2,creator:one.address,createdAt:new Date().toISOString()};
function signed(number='DESIGN-001'):Invoice {
 const i:Invoice={id:invoiceId(treasury.address,contributor.address,number),number,title:'Design work',treasuryId:treasury.id,treasuryAddress:treasury.address,issuer:contributor.address,recipient:contributor.address,asset:{...NATIVE_ASSET},amountRaw:'123456789012345',workUrl:'https://github.com/example/work',dueDate:'2026-11-06',createdAt:'2026-10-26T10:00:00.000Z',termsHash:zeroHash,signature:'0x',status:'submitted'};
 i.termsHash=invoiceTermsHash(i);i.signature=u8aToHex(contributor.sign(invoiceMessage(i))) as Hex;return i;
}
test('invoice identity survives term changes while the contributor signature rejects changed payment details',()=>{
 const i=signed();assert.equal(verifyInvoiceSignature(i),true);
 assert.equal(invoiceId(treasury.address,contributor.address,'design-001'),i.id);
 for(const patch of [{amountRaw:'1'},{recipient:outsider.address},{treasuryAddress:one.address},{workUrl:'https://evil.example/'}])assert.equal(verifyInvoiceSignature({...i,...patch}),false);
 assert.notEqual(invoiceId(treasury.address,outsider.address,i.number),i.id);
});
test('asset precision is exact and invalid or excessive amounts never reach a settlement plan',()=>{
 assert.equal(parseAssetAmount('12.345678',6),12345678n);assert.equal(formatAssetAmount('12345678',6),'12.345678');
 assert.equal(parseAssetAmount('0.00000000000001',14),1n);
 for(const input of ['0','-1','1e3','01','1.0000001'])assert.throws(()=>parseAssetAmount(input,6));
 assert.throws(()=>parseAssetAmount('1',19));assert.throws(()=>parseAssetAmount('9'.repeat(39),0));
});
async function setup(){
 const store=new Store(':memory:'),chain=new Chain(store,undefined,false),settlement=new InvoiceChain(chain);
 await store.saveTreasury(treasury);
 const auth=async(address:string,n:number)=>{const token=n.toString(16).padStart(64,'0');await store.saveSession(sessionHash(token),{address,expires:Date.now()+60000});return {portaflow_session:token};};
 const cookies={owner:await auth(one.address,1),contributor:await auth(contributor.address,2),outsider:await auth(outsider.address,3)};
 const {app}=await createApp({store,chain,invoiceChain:settlement,connect:false,serve:false});
 return {app,store,chain,settlement,cookies};
}
test('real API accepts a signed invoice, denies a substituted amount and duplicate number, and keeps it private',async()=>{
 const {app,store,cookies}=await setup();
 try{
 const input={treasuryId:treasury.id,recipient:contributor.address,number:'BUILD-001',title:'Core implementation',amount:'1.23456789012345',dueDate:'2026-11-06',workUrl:'https://github.com/example/work'};
 const prepared=await app.inject({method:'POST',url:'/api/invoices/prepare',cookies:cookies.contributor,payload:input});assert.equal(prepared.statusCode,200);
 const invoice=prepared.json() as Invoice;
 const payload={...input,id:invoice.id,createdAt:invoice.createdAt,termsHash:invoice.termsHash,signature:u8aToHex(contributor.sign(invoiceMessage(invoice)))};
 assert.equal((await app.inject({method:'POST',url:'/api/invoices',cookies:cookies.contributor,payload:{...payload,amount:'9'}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/invoices',cookies:cookies.contributor,payload})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/api/invoices',cookies:cookies.contributor,payload})).statusCode,409);
 assert.equal((await store.invoice(invoice.id))!.amountRaw,'123456789012345');
 for(const cookiesArg of [undefined,cookies.outsider])assert.equal((await app.inject({url:'/api/invoices/'+invoice.id,cookies:cookiesArg})).statusCode,403);
 assert.equal((await app.inject({url:'/api/invoices/'+invoice.id,cookies:cookies.owner})).statusCode,200);
 assert.equal((await app.inject({url:'/api/invoices',cookies:cookies.outsider})).json().invoices.length,0);
 assert.equal((await app.inject({url:'/api/invoices',cookies:cookies.contributor})).json().invoices.length,1);
 const share=await app.inject({method:'POST',url:'/api/invoices/'+invoice.id+'/share',cookies:cookies.contributor,payload:{}});
 assert.equal((await app.inject({url:'/api'+share.json().path})).statusCode,200);
 const again=await app.inject({method:'POST',url:'/api/invoices/'+invoice.id+'/share',cookies:cookies.owner,payload:{}});
 assert.equal(again.json().path,share.json().path);
 const second=await app.inject({method:'POST',url:'/api/invoices/'+invoice.id+'/share',cookies:cookies.owner,payload:{rotate:true}});
 assert.equal((await app.inject({url:'/api'+share.json().path})).statusCode,403);
 assert.equal((await app.inject({url:'/api'+second.json().path})).statusCode,200);
 }finally{await app.close();}
});
test('API restricts batch creation to signers, freezes signed invoices and prevents competing batches',async()=>{
 const {app,store,settlement,cookies,chain}=await setup();
 try{
 const i=signed();await store.saveInvoice(i);
 settlement.prepare=async b=>({...b,router:'0x1111111111111111111111111111111111111111',runtimeCodeHash:zeroHash,payer:zeroAddress,recipients:[zeroAddress],callHex:'0x00',callHash:'0x'+'1'.repeat(64)} as InvoiceBatch);
 const input={title:'October payments',treasuryId:treasury.id,invoiceIds:[i.id]};
 assert.equal((await app.inject({method:'POST',url:'/api/invoice-batches',cookies:cookies.outsider,payload:input})).statusCode,403);
 const response=await app.inject({method:'POST',url:'/api/invoice-batches',cookies:cookies.owner,payload:input});assert.equal(response.statusCode,200);
 const batch=response.json();assert.equal(batch.invoices[0].termsHash,i.termsHash);assert.equal((await store.invoice(i.id))!.status,'awaiting_approval');
 assert.notEqual((await app.inject({method:'POST',url:'/api/invoice-batches',cookies:cookies.owner,payload:input})).statusCode,200);
 assert.notEqual((await app.inject({method:'POST',url:'/api/invoices/'+i.id+'/decline',cookies:cookies.owner,payload:{reason:'Late'}})).statusCode,200);
 // Direct current-state reconciliation must work even while the global history cursor is stale.
 chain.ready=async()=>{};chain.refreshHead=async()=>{};chain.pending=async()=>null;chain.state.lastSyncedBlock=1;chain.state.finalizedBlock=99999;
 settlement.paid=async()=>[i.termsHash];
 const detail=await app.inject({url:'/api/invoice-batches/'+batch.id,cookies:cookies.owner});assert.equal(detail.statusCode,200);assert.equal(detail.json().batch.status,'paid');assert.equal((await store.invoice(i.id))!.status,'paid');
 }finally{await app.close();}
});
test('API decline is authenticated and never changes an invoice signature or frozen terms',async()=>{
 const {app,store,cookies}=await setup();
 try{const i=signed();await store.saveInvoice(i);
 assert.equal((await app.inject({method:'POST',url:'/api/invoices/'+i.id+'/decline',cookies:cookies.outsider,payload:{reason:'No'}})).statusCode,403);
 const result=await app.inject({method:'POST',url:'/api/invoices/'+i.id+'/decline',cookies:cookies.owner,payload:{reason:'Please discuss scope first.'}});
 assert.equal(result.statusCode,200);assert.equal(result.json().status,'declined');assert.equal(verifyInvoiceSignature(result.json()),true);
 }finally{await app.close();}
});
