import type { ApiError } from "@/core/gen";

/** Narrow a rejection to the protocol's ApiError (core rejects with it). */
export function isApiError(err: unknown): err is ApiError {
  return typeof err === "object" && err !== null && "code" in err && "message" in err && typeof err.message === "string";
}

/** Human message for any rejection: ApiError message, Error message, or the stringified value. */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The fix-it hint of an ApiError, when there is one. */
export function errorHint(err: unknown): string | undefined {
  return isApiError(err) ? err.hint : undefined;
}
