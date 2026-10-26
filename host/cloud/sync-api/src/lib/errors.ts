/**
 * Thrown by store helpers; caught and mapped by route handlers. Kept apart from `http.ts`, which
 * needs Next.js, so pure modules (crypto) can throw it and be tested under plain node.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
