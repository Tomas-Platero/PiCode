/**
 * Thrown by store helpers; caught and mapped by route handlers. Kept apart from `http.ts`, which
 * needs Next.js, so pure modules (crypto) can throw it and be tested under plain node.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "HttpError";
  }
}
