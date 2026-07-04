/**
 * Error taxonomy for the send pipeline.
 *
 * TransientError  -> worth retrying (provider 5xx, timeout, rate limit).
 * PermanentError  -> never retry (invalid address, template error, 4xx).
 *
 * Workers translate PermanentError into BullMQ's UnrecoverableError so the
 * job fails immediately instead of burning retry attempts.
 */
export class TransientError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TransientError';
  }
}

export class PermanentError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PermanentError';
  }
}
