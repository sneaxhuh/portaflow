import type {ProviderInterface} from '@polkadot/rpc-provider/types';
import type {Transport} from 'viem';

// An explicit allowlist: signing, submissions, subscriptions and unknown methods never retry.
export const RETRYABLE_READS=new Set(['rpc_methods','system_chain','system_name','system_version','system_properties','system_accountNextIndex',
  'chain_getHeader','chain_getBlock','chain_getBlockHash','chain_getFinalizedHead',
  'state_getMetadata','state_getRuntimeVersion','state_getStorage','state_getStorageAt','state_queryStorageAt','state_getKeysPaged','state_call',
  'payment_queryInfo','payment_queryFeeDetails','eth_chainId','eth_getCode','eth_call','eth_getBalance','eth_getBlockByNumber','eth_getTransactionReceipt']);
export class RpcReadTimeout extends Error { constructor(){super('Portaldot RPC read timed out.');this.name='RpcReadTimeout';} }
export function transientReadError(error:unknown):boolean {
  const e=error as {message?:string;status?:number;statusCode?:number;cause?:unknown};
  const message=e?.message||String(error);
  return error instanceof RpcReadTimeout||[429,502,503,504].includes(e?.status??e?.statusCode??0)
    ||/\b(429|502|503|504)\b|timed? ?out|timeout|fetch failed|network error|connection (closed|reset|lost)|disconnected|socket hang up|ECONNRESET|ETIMEDOUT/i.test(message);
}
type Options={attempts?:number;timeoutMs?:number;delayMs?:number;random?:()=>number;sleep?:(ms:number)=>Promise<void>};
export async function retryRpcRead<T>(operation:()=>Promise<T>,options:Options={}):Promise<T>{
  const {attempts=3,timeoutMs=5000,delayMs=250,random=Math.random,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}=options;
  for(let attempt=0;;attempt++){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RpcReadTimeout()),timeoutMs);})]);}
    catch(error){if(attempt>=attempts-1||!transientReadError(error))throw error;}
    finally{clearTimeout(timer);}
    await sleep(Math.floor(Math.min(2000,delayMs*2**attempt)*(0.5+random()*0.5)));
  }
}
const wrappedProviders=new WeakSet<object>();
export function withRpcReadRetries<T extends ProviderInterface>(provider:T):T{
  if(wrappedProviders.has(provider))return provider;wrappedProviders.add(provider);
  const send=provider.send.bind(provider),clone=provider.clone.bind(provider);
  provider.send=(method,params,cacheable)=>{
    if(!RETRYABLE_READS.has(method))return send(method,params,cacheable);
    let attempt=0;
    return retryRpcRead(()=>send(method,params,attempt++===0?cacheable:false));
  };
  provider.clone=()=>withRpcReadRetries(clone());
  return provider;
}
export function retryingTransport(transport:Transport):Transport{
  return options=>{
    const configured=transport({...options,retryCount:0});
    const request:typeof configured.request=args=>RETRYABLE_READS.has(args.method)
      ?retryRpcRead(()=>configured.request(args)):configured.request(args);
    return{...configured,request};
  };
}
