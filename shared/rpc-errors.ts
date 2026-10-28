/** A failed read says nothing about whether an earlier transaction was submitted. */
export function rpcReadFailureMessage(error: unknown): string | undefined {
  const message=error instanceof Error?error.message:String(error);
  if(!/\b503\b/.test(message)||!/["']method["']\s*:\s*["']chain_getHeader["']/.test(message))return;
  return 'Portaldot’s RPC is temporarily unable to read block information. If you already signed, refresh the payment status before trying again; this read error does not establish whether the transaction succeeded.';
}
