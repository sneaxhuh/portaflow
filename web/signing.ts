import type {ApiPromise} from '@polkadot/api';
import type {Signer} from '@polkadot/api/types';
import type {SignerPayloadJSON} from '@polkadot/types/types';

export async function prepareSigningPayload(api:ApiPromise,address:string,method:string){
  const [hash,nonce]=await Promise.all([api.rpc.chain.getFinalizedHead(),api.rpc.system.accountNextIndex(address)]);
  const head=await api.rpc.chain.getHeader(hash);
  const payload=api.registry.createType('SignerPayload',{
    address,blockHash:hash.toHex(),blockNumber:head.number,
    era:api.registry.createType('ExtrinsicEra',{current:head.number,period:64}),
    genesisHash:api.genesisHash,method,nonce,runtimeVersion:api.runtimeVersion,
    signedExtensions:api.registry.signedExtensions,version:api.extrinsicVersion,
  }).toPayload();
  return{payload,fromBlock:head.number.toNumber()+1};
}
export async function requestPayloadSignature(signer:Signer,payload:SignerPayloadJSON,timeoutMs=120_000){
  if(!signer.signPayload)throw new Error('This wallet does not support native transaction payload signing. No transaction was submitted.');
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([signer.signPayload(payload),new Promise<never>((_,reject)=>{
      timeout=setTimeout(()=>reject(new Error('The wallet did not return a transaction signature. No transaction was submitted by PortaFlow. Close any pending wallet request before trying again.')),timeoutMs);
    })]);
  }finally{clearTimeout(timeout);}
}
