import type { ApiError } from "@/core/gen";

/** Every rejected core call rejects with a `CoreError`: an `Error` that is also a tf-proto `ApiError`. */
export class CoreError extends Error implements ApiError {
  readonly code: string;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(err: ApiError) {
    super(err.message);
    this.name = "CoreError";
    this.code = err.code;
    if (err.hint !== undefined) this.hint = err.hint;
    this.retryable = err.retryable;
  }

  toJSON(): ApiError {
    return { code: this.code, message: this.message, hint: this.hint, retryable: this.retryable };
  }
}

export function apiError(code: string, message: string, extra: { hint?: string; retryable?: boolean } = {}): CoreError {
  return new CoreError({ code, message, hint: extra.hint, retryable: extra.retryable ?? false });
}

export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as ApiError).code === "string" &&
    typeof (e as ApiError).message === "string"
  );
}

/** Normalises anything thrown (ApiError objects, strings from Tauri, network errors) into a `CoreError`. */
export function toApiError(e: unknown): CoreError {
  if (e instanceof CoreError) return e;
  if (isApiError(e)) return new CoreError({ ...e, retryable: Boolean(e.retryable) });
  if (typeof e === "string") {
    try {
      const parsed: unknown = JSON.parse(e);
      if (isApiError(parsed)) return new CoreError({ ...parsed, retryable: Boolean(parsed.retryable) });
    } catch {
      /* not JSON: use the string as the message */
    }
    return apiError("internal", e);
  }
  if (e instanceof Error) return apiError("internal", e.message);
  return apiError("internal", String(e));
}
