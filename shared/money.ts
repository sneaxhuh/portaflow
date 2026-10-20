export const UNIT = 100_000_000_000_000n;
export const MAX_BALANCE = (1n << 128n) - 1n;

export function parseAmount(value: string): bigint {
  if (!/^(0|[1-9]\d{0,24})(\.\d{1,14})?$/.test(value)) {
    throw new Error('Enter a positive tPOT amount with up to 14 decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  const raw = BigInt(whole) * UNIT + BigInt(fraction.padEnd(14, '0'));
  if (raw <= 0n || raw > MAX_BALANCE) throw new Error('Amount is outside the supported range.');
  return raw;
}

export function formatAmount(value: string | bigint, digits = 4): string {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const positive = negative ? -raw : raw;
  const whole = (positive / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (positive % UNIT).toString().padStart(14, '0').slice(0, digits).replace(/0+$/, '');
  return (negative ? '−' : '') + whole + (fraction ? '.' + fraction : '');
}

export function vestedRemaining(locked: bigint, perBlock: bigint, start: number, block: number): bigint {
  const elapsed = BigInt(Math.max(0, block - start));
  const remaining = locked - elapsed * perBlock;
  return remaining > 0n ? remaining : 0n;
}

export function schedule(locked: bigint, duration: number, start: number) {
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 10_000_000) {
    throw new Error('Duration must be between 1 and 10,000,000 blocks.');
  }
  if (!Number.isSafeInteger(start) || start < 1 || start > 0xffff_ffff) throw new Error('Invalid starting block.');
  const perBlock = locked / BigInt(duration);
  if (perBlock <= 0n) throw new Error('The award is too small for this duration.');
  const actualDuration = Number((locked + perBlock - 1n) / perBlock);
  if (start + actualDuration > 0xffff_ffff) throw new Error('Schedule exceeds the chain block range.');
  return { perBlockRaw: perBlock.toString(), durationBlocks: actualDuration, endBlock: start + actualDuration };
}

export function shortAddress(address = '') {
  return address.length > 16 ? address.slice(0, 7) + '…' + address.slice(-6) : address;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
