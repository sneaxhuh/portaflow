// Share in-flight reads across components without caching finalized balances or plans.
const reads = new Map<string, Promise<unknown>>();

export function request<T>(path: string, data?: unknown): Promise<T> {
  if (data === undefined) {
    const existing = reads.get(path);
    if (existing) return existing as Promise<T>;
    const read = send<T>(path).finally(() => { if (reads.get(path) === read) reads.delete(path); });
    reads.set(path, read);
    return read;
  }
  // Never merge signing plans, login requests, or other mutations.
  return send<T>(path, data);
}

async function send<T>(path: string, data?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch('/api' + path, {
      method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error('The service is temporarily unavailable. Please retry shortly.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The service took too long to respond. Please retry.');
    throw error;
  } finally { clearTimeout(timeout); }
}
