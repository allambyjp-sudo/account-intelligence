/** Base class, so callers can catch any model-layer failure in one place. */
export class LLMError extends Error {
  override name = "LLMError";
}

/** The provider isn't set up yet (e.g. Conver before its API details are known). */
export class LLMNotConfiguredError extends LLMError {
  override name = "LLMNotConfiguredError";
}

/** A caller asked for something this provider can't do, such as web search on Conver. */
export class LLMCapabilityError extends LLMError {
  override name = "LLMCapabilityError";
}

/** The model declined, after any configured fallback also declined. */
export class LLMRefusalError extends LLMError {
  override name = "LLMRefusalError";
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(`The model declined the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
  }
}

/** The response was cut off, unparseable, or didn't match the requested schema. */
export class LLMOutputError extends LLMError {
  override name = "LLMOutputError";
  constructor(
    message: string,
    readonly rawText?: string,
  ) {
    super(message);
  }
}
