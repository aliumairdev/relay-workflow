// Shared exit codes (PLUGIN_SPEC section 7).
export const EXIT = Object.freeze({
  OK: 0, ERROR: 1, NEEDS_HUMAN: 2, INVALID: 3, GATE_FAILED: 4, TARGET_UNAVAILABLE: 5,
  RENDER: 6, REFUSED: 7, DENIED: 8, ENV: 9, WAIT: 10, DENY: 11,
});

export class RelayError extends Error {
  constructor(message, code = EXIT.ERROR, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
