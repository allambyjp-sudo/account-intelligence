export class FetchPolicyError extends Error {
  override name = "FetchPolicyError";
}

/** robots.txt disallows this URL for our user agent. Adapters must not work around this. */
export class RobotsDisallowedError extends FetchPolicyError {
  override name = "RobotsDisallowedError";
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

/** The host asked us to back off for longer than a job should wait. Reschedule after retryAt. */
export class BackOffError extends FetchPolicyError {
  override name = "BackOffError";
  constructor(
    readonly url: string,
    readonly retryAt: Date,
  ) {
    super(`${new URL(url).host} asked us to wait until ${retryAt.toISOString()}`);
  }
}

export class HttpStatusError extends Error {
  override name = "HttpStatusError";
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} returned ${status}`);
  }
}

/** Network failure (DNS, reset, timeout) that persisted through every retry. */
export class FetchFailedError extends Error {
  override name = "FetchFailedError";
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`GET ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
