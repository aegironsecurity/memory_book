// PUT one part to a presigned S3 URL with XMLHttpRequest, so we get upload progress.
// A watchdog aborts the request if no bytes move for stallMs, which is how a dead cell connection looks.
import { PutError } from './errors.js';

export function putPart(url, blob, { onProgress, stallMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer = null;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          xhr.abort();
        } catch (e) {
          /* ignore */
        }
        finish(reject, new PutError(0, 'stall', 'Upload stalled'));
      }, stallMs);
    };
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      arm();
      if (onProgress && e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish(resolve);
      else finish(reject, new PutError(xhr.status, 'put_failed', `S3 answered ${xhr.status}`));
    };
    xhr.onerror = () => finish(reject, new PutError(0, 'network', 'Network error'));
    xhr.ontimeout = () => finish(reject, new PutError(0, 'timeout', 'Timed out'));
    xhr.onabort = () => finish(reject, new PutError(0, 'aborted', 'Aborted'));
    arm();
    xhr.send(blob);
  });
}
