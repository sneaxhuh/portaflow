import { parseAmount, UNIT } from './money.js';

export type ImportRow = { title: string; recipient: string; amount: string; upfront: string; durationDays: number; workUrl: string };
export const IMPORT_COLUMNS = ['title', 'recipient', 'amount', 'upfront_percent', 'duration_days', 'work_url'];

export function readAwardCsv(source: string): ImportRow[] {
  if (source.length > 40_000) throw new Error('Keep the CSV under 40 KB and 25 awards.');
  const lines: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  source = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const pushField = () => { row.push(field.trim()); field = ''; closed = false; };
  const pushRow = () => { pushField(); if (row.some(Boolean)) lines.push(row); row = []; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ',' || char === '\n') { if (char === ',') pushField(); else pushRow(); }
    else if (char === '"') { if (field || closed) throw new Error('A CSV quote is misplaced. Export the sheet as CSV again.'); quoted = true; }
    else if (closed && char.trim()) throw new Error('Unexpected text after a quoted CSV field.');
    else if (!closed) field += char;
  }
  if (quoted) throw new Error('A quoted CSV field was not closed.');
  if (field || row.length || closed) pushRow();
  const headers = lines.shift()?.map(h => h.toLowerCase());
  if (!headers || headers.length !== new Set(headers).size || IMPORT_COLUMNS.slice(0, 3).some(column => !headers.includes(column)) || headers.some(h => !IMPORT_COLUMNS.includes(h))) {
    throw new Error('Use title, recipient, amount, upfront_percent, duration_days, work_url as column names. The first three are required.');
  }
  if (!lines.length || lines.length > 25) throw new Error('Import between 1 and 25 awards at a time.');
  return lines.map((values, index) => {
    try {
      if (values.length !== headers.length) throw new Error('The number of fields does not match the header.');
      const get = (key: string) => values[headers.indexOf(key)] || '';
      const title = get('title'), recipient = get('recipient'), amount = get('amount');
      if (!title || title.length > 100 || !recipient) throw new Error('Add an award title and recipient address.');
      const total = parseAmount(amount);
      const percentText = get('upfront_percent') || '20';
      const daysText = get('duration_days') || '30';
      if (!/^\d+$/.test(percentText) || Number(percentText) > 90) throw new Error('Upfront percent must be a whole number between 0 and 90.');
      if (!/^\d+$/.test(daysText) || Number(daysText) < 1 || Number(daysText) > 365) throw new Error('Duration must be between 1 and 365 days.');
      const upfront = total * BigInt(percentText) / 100n;
      return { title, recipient, amount, upfront: upfront === 0n ? '0' : (upfront / UNIT).toString() + '.' + (upfront % UNIT).toString().padStart(14, '0'), durationDays: Number(daysText), workUrl: get('work_url') };
    } catch (error) { throw new Error('Row ' + (index + 2) + ': ' + (error instanceof Error ? error.message : 'Invalid award.')); }
  });
}
