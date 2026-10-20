/**
 * Error types shared by the package.
 *
 * Every failure surfaced by this library is a {@link DpapiError} carrying a
 * machine-readable {@link DpapiErrorCode}. Errors never contain the plaintext
 * or the ciphertext being processed.
 */

/** Machine-readable error codes returned by this package. */
export type DpapiErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_INPUT"
  | "INVALID_BASE64"
  | "POWERSHELL_NOT_FOUND"
  | "DPAPI_FAILURE"
  | "TIMEOUT"
  | "FILE_NOT_FOUND"
  | "FILE_READ_FAILED"
  | "FILE_WRITE_FAILED";

/**
 * Base class for every error thrown by `@fuhua-0623/dpapi-secrets`.
 *
 * The `code` property is stable API; the `message` is intended for humans and
 * may change between releases.
 */
export class DpapiError extends Error {
  /** Stable, machine-readable failure category. */
  readonly code: DpapiErrorCode;

  /** Original error that caused this failure, when one exists. */
  declare readonly cause?: unknown;

  constructor(code: DpapiErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DpapiError";
    this.code = code;
  }
}

/**
 * Thrown when an operation that needs the Windows Data Protection API is called
 * on a platform other than Windows (`process.platform !== "win32"`).
 *
 * Call {@link isDpapiSupported} first if you want to branch instead of catch.
 */
export class DpapiUnsupportedPlatformError extends DpapiError {
  constructor(platform: string) {
    super(
      "UNSUPPORTED_PLATFORM",
      `Windows DPAPI is only available on Windows ("win32"), but this process is running on "${platform}". ` +
        "Call isDpapiSupported() before using this package, and fall back to another secret store on this platform.",
    );
    this.name = "DpapiUnsupportedPlatformError";
  }
}
