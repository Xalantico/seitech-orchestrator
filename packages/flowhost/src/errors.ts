/** Failure with an HTTP-like status so the API can surface it unchanged. */
export class FlowError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 422 | 503,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
    this.name = "FlowError";
  }
}
