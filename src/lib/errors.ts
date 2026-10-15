/**
 * Error infrastructure.
 *
 * `AppError` is the only error type application code should throw at system
 * boundaries. The `toSafeResponse` helper converts an error into a JSON-safe
 * shape that never exposes SQL, stack traces, or secrets.
 *
 * Internal details (SQL, stack, original cause) are stored on the error
 * instance for server-side logging only and never serialized to the client.
 */

/** Stable, documented error codes. Keep this list narrow and explicit. */
export type AppErrorCode =
  | "CONFIG_INVALID"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "MUST_CHANGE_PASSWORD"
  | "CSRF_INVALID"
  | "INVARIANT_VIOLATED"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

const HTTP_BY_CODE: Record<AppErrorCode, number> = {
  CONFIG_INVALID: 500,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  MUST_CHANGE_PASSWORD: 426, // Upgrade Required — caller must change password
  CSRF_INVALID: 403,
  INVARIANT_VIOLATED: 409,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export interface AppErrorInit {
  code: AppErrorCode;
  message: string;
  httpStatus?: number;
  /** Safe, client-visible extra detail (never secrets/SQL). */
  detail?: string;
  /** Server-only cause. Never serialized to the client. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  readonly detail?: string;
  readonly serverCause?: unknown;

  constructor(init: AppErrorInit) {
    super(init.message);
    this.name = "AppError";
    this.code = init.code;
    this.httpStatus = init.httpStatus ?? HTTP_BY_CODE[init.code];
    this.detail = init.detail;
    this.serverCause = init.cause;
    // Restore prototype chain for cross-target instanceof.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** JSON-safe representation for API responses. */
  toSafeJSON(): { error: { code: string; message: string; detail?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail ? { detail: this.detail } : {}),
      },
    };
  }
}

/** Convenience constructors — keeps call sites short and explicit. */
export const Err = {
  config: (message = "Invalid configuration", detail?: string) =>
    new AppError({ code: "CONFIG_INVALID", message, detail }),
  unauthorized: (message = "Unauthorized") => new AppError({ code: "UNAUTHORIZED", message }),
  forbidden: (message = "Forbidden") => new AppError({ code: "FORBIDDEN", message }),
  notFound: (message = "Not found") => new AppError({ code: "NOT_FOUND", message }),
  validation: (message: string, detail?: string) =>
    new AppError({ code: "VALIDATION_FAILED", message, detail }),
  conflict: (message: string, detail?: string) =>
    new AppError({ code: "CONFLICT", message, detail }),
  rateLimited: (message = "Too many requests") => new AppError({ code: "RATE_LIMITED", message }),
  mustChangePassword: () =>
    new AppError({
      code: "MUST_CHANGE_PASSWORD",
      message: "Password change required before accessing this resource",
    }),
  csrf: (message = "Invalid CSRF token") => new AppError({ code: "CSRF_INVALID", message }),
  invariant: (message: string, detail?: string) =>
    new AppError({ code: "INVARIANT_VIOLATED", message, detail }),
  upstream: (message: string, cause?: unknown) =>
    new AppError({ code: "UPSTREAM_ERROR", message, cause }),
  internal: (message = "Internal server error", cause?: unknown) =>
    new AppError({ code: "INTERNAL", message, cause }),
};

/**
 * Convert any thrown value into a safe JSON response. Unknown errors become
 * `INTERNAL` with a generic message; the original is logged server-side only.
 */
export function toSafeResponse(err: unknown): {
  status: number;
  body: { error: { code: string; message: string; detail?: string } };
  loggable: { name: string; message: string; cause?: unknown; stack?: string };
} {
  if (err instanceof AppError) {
    return {
      status: err.httpStatus,
      body: err.toSafeJSON(),
      loggable: {
        name: err.name,
        message: err.message,
        cause: err.serverCause,
        stack: err.stack,
      },
    };
  }
  // Unknown error — never leak.
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: "Internal server error" } },
    loggable: {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
  };
}
