// Error types shared by the API client and the upload engine.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status; // 0 means the request never got an answer (offline, timeout)
    this.code = code;
    this.details = details || null;
  }
}

export class PutError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'PutError';
    this.status = status; // 0 means network failure or stall
    this.code = code;
  }
}
