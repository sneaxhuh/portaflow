import {useEffect,useState} from 'react';
import {Clock3,RefreshCw} from 'lucide-react';
import {Button} from './components/ui/button';
import {pendingTransactions,reconcileTransaction,type PendingTransaction} from './transactions';
import {shortAddress} from '../shared/money';

export function TransactionRecovery({address,onRecovered}:{address?:string;onRecovered:()=>void}){
  const [rows,setRows]=useState<PendingTransaction[]>(pendingTransactions),[busy,setBusy]=useState(''),[message,setMessage]=useState('');
  useEffect(()=>{const update=()=>setRows(pendingTransactions());window.addEventListener('portaflow-pending-changed',update);window.addEventListener('storage',update);return()=>{window.removeEventListener('portaflow-pending-changed',update);window.removeEventListener('storage',update);};},[]);
  const mine=rows.filter(tx=>tx.signer===address);
  const check=async(tx:PendingTransaction)=>{
    setBusy(tx.txHash);setMessage('');
    try{
      const result=await reconcileTransaction(tx);
      setMessage(result.status==='finalized'?(result.success?'Transaction finalized. Its receipt has been recovered.':'Transaction finalized with an execution failure. Review its receipt before preparing a new action.'):'No matching finalized transaction in this window yet. Progress is saved; check again to continue.');
      if(result.status==='finalized')onRecovered();
    }catch{setMessage('Portaldot could not confirm this transaction yet. Its reference is saved. Check again when the connection recovers.');}
    finally{setBusy('');}
  };
  if(!mine.length&&!message)return null;
  return <section className="transaction-recovery" aria-label="Transaction recovery"><div><Clock3 size={18}/><div><strong>{mine.length?'Confirmation pending':'Transaction status recovered'}</strong><p>Check the existing transaction before signing again. Checking status does not submit a payment.</p></div></div>
    {mine.map(tx=><div className="transaction-recovery-row" key={tx.txHash}><span>{tx.kind}<code title={tx.txHash}>{shortAddress(tx.txHash)}</code><small>Checking from block #{tx.nextBlock.toLocaleString()}</small></span><Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={()=>void check(tx)}><RefreshCw size={14} className={busy===tx.txHash?'spin':''}/>{busy===tx.txHash?'Checking…':'Check transaction'}</Button></div>)}
    {message&&<p role="status">{message}</p>}
  </section>;
}
