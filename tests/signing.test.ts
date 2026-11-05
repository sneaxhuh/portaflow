import test from 'node:test';
import assert from 'node:assert/strict';
import {requestPayloadSignature} from '../web/signing';
import type {Signer} from '@polkadot/api/types';
import type {SignerPayloadJSON} from '@polkadot/types/types';
test('an absent wallet signature times out without retrying and a late response cannot trigger submission',async()=>{
 let calls=0,resolve!:(v:any)=>void;
 const signer={signPayload:()=>{calls++;return new Promise(r=>{resolve=r;});}} as Signer;
 await assert.rejects(()=>requestPayloadSignature(signer,{} as SignerPayloadJSON,5),/No transaction was submitted/);
 resolve({id:1,signature:'0x00'});await Promise.resolve();assert.equal(calls,1);
});
test('wallet rejection is preserved and the request is never retried',async()=>{
 let calls=0;const signer={signPayload:async()=>{calls++;throw new Error('User rejected signing');}} as Signer;
 await assert.rejects(()=>requestPayloadSignature(signer,{} as SignerPayloadJSON),/User rejected signing/);assert.equal(calls,1);
});
