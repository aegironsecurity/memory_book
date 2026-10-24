// Thin fetch wrapper for the guest API. Every failure becomes an ApiError the upload engine understands.
import { ApiError } from './errors.js';

export function createApi({ base, getToken, timeoutMs = 20000, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const root = String(base || '').replace(/\/+$/, '');

  async function request(method, path, body, { auth = true } = {}) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = auth && getToken ? getToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await doFetch(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (e) {
      throw new ApiError(0, 'network', 'No answer from the server');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      // A gateway error page or an empty body is treated as a server problem, which retries.
      const code = (data && data.error) || `http_${res.status}`;
      throw new ApiError(res.status, code, (data && data.message) || code, data);
    }
    if (data === null) throw new ApiError(502, 'bad_response', 'Unreadable answer');
    return data;
  }

  return {
    start: (eventId, code, guestId) => request('POST', '/guest/start', { eventId, code, guestId }, { auth: false }),
    createMemory: (payload) => request('POST', '/guest/memories', payload),
    parts: (id, nums) => request('POST', `/guest/memories/${encodeURIComponent(id)}/parts`, { partNumbers: nums }),
    complete: (id) => request('POST', `/guest/memories/${encodeURIComponent(id)}/complete`, {}),
    abort: (id) => request('DELETE', `/guest/memories/${encodeURIComponent(id)}`),
  };
}
