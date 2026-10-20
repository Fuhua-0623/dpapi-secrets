/**
 * Encrypt and decrypt local secrets with the Windows Data Protection API
 * (DPAPI) from Node.js, with no native dependencies.
 *
 * The package shells out to Windows PowerShell, so it works anywhere Node.js
 * runs on Windows without a compiler, a prebuilt binary or an install script.
 * Secrets are transported over stdin so they never appear on a command line.
 */
import { promises as fs } from "node:fs";
import { DpapiError, DpapiUnsupportedPlatformError } from "./errors.js";
import {
  DEFAULT_POWERSHELL_PATH,
  DEFAULT_SCOPE,
  DEFAULT_TIMEOUT_MS,
  runDpapiCall,
} from "./dpapi.js";
import type { DpapiOptions, DpapiScope, ResolvedDpapiOptions } from "./dpapi.js";

export { DpapiError, DpapiUnsupportedPlatformError } from "./errors.js";
export type { DpapiErrorCode } from "./errors.js";
export type { DpapiOptions, DpapiScope } from "./dpapi.js";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Returns `true` when the current platform supports Windows DPAPI, i.e. when
 * `process.platform === "win32"`.
 *
 * Use this to branch before calling the other functions, which throw
 * {@link DpapiUnsupportedPlatformError} on other platforms.
 */
export function isDpapiSupported(): boolean {
  return process.platform === "win32";
}

/** Throws the public unsupported-platform error unless running on Windows. */
function assertDpapiSupported(): void {
  if (!isDpapiSupported()) {
    throw new DpapiUnsupportedPlatformError(process.platform);
  }
}

/** Describes a received value without printing it (values may be secrets). */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a value of type ${typeof value}`;
}

/** Validates and normalizes user-supplied options. */
function resolveOptions(options: DpapiOptions | undefined): ResolvedDpapiOptions {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new DpapiError("INVALID_INPUT", `options must be an object when provided, received ${describeValue(options)}.`);
  }

  const scope: DpapiScope = options === undefined || options.scope === undefined ? DEFAULT_SCOPE : options.scope;
  if (scope !== "CurrentUser" && scope !== "LocalMachine") {
    const received = typeof scope === "string" ? JSON.stringify(scope) : describeValue(scope);
    throw new DpapiError(
      "INVALID_INPUT",
      `options.scope must be either "CurrentUser" or "LocalMachine", received ${received}.`,
    );
  }

  const timeoutMs = options === undefined || options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const received = typeof timeoutMs === "number" ? String(timeoutMs) : describeValue(timeoutMs);
    throw new DpapiError(
      "INVALID_INPUT",
      `options.timeoutMs must be a positive, finite number of milliseconds, received ${received}.`,
    );
  }

  const powershellPath =
    options === undefined || options.powershellPath === undefined ? DEFAULT_POWERSHELL_PATH : options.powershellPath;
  if (typeof powershellPath !== "string" || powershellPath.trim().length === 0) {
    throw new DpapiError(
      "INVALID_INPUT",
      `options.powershellPath must be a non-empty string, received ${describeValue(powershellPath)}.`,
    );
  }

  return { scope, timeoutMs, powershellPath: powershellPath.trim() };
}

/** Validates the plaintext argument. Empty strings are allowed. */
function requirePlainText(value: unknown): string {
  if (typeof value !== "string") {
    throw new DpapiError("INVALID_INPUT", `plainText must be a string, received ${describeValue(value)}.`);
  }
  return value;
}

/** Validates a base64 ciphertext argument and returns its canonical text. */
function requireBase64Ciphertext(value: unknown): string {
  if (typeof value !== "string") {
    throw new DpapiError("INVALID_INPUT", `encryptedBase64 must be a string, received ${describeValue(value)}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DpapiError("INVALID_BASE64", "encryptedBase64 is empty; expected a base64-encoded DPAPI blob.");
  }
  if (!BASE64_PATTERN.test(trimmed)) {
    throw new DpapiError(
      "INVALID_BASE64",
      "encryptedBase64 is not valid base64 text; expected the string returned by encryptSecret().",
    );
  }
  if (Buffer.from(trimmed, "base64").length === 0) {
    throw new DpapiError("INVALID_BASE64", "encryptedBase64 does not decode to any bytes.");
  }
  return trimmed;
}

/** Validates a caller-supplied file path. */
function requireFilePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DpapiError("INVALID_INPUT", `${label} must be a non-empty string, received ${describeValue(value)}.`);
  }
  return value;
}

/** Validates the base64 returned by the `protect` script. */
function requireProtectedOutput(stdout: string): string {
  if (stdout.length === 0 || !BASE64_PATTERN.test(stdout) || Buffer.from(stdout, "base64").length === 0) {
    throw new DpapiError(
      "DPAPI_FAILURE",
      "PowerShell returned an unexpected result while encrypting: expected a non-empty base64 DPAPI blob.",
    );
  }
  return stdout;
}

/**
 * Encrypts a UTF-8 string with Windows DPAPI and returns the base64-encoded
 * DPAPI blob.
 *
 * The ciphertext is bound to the current Windows account (or machine, for the
 * `"LocalMachine"` scope) and cannot be decrypted by another user or on another
 * machine. An empty string encrypts successfully and decrypts back to `""`.
 *
 * @throws {DpapiUnsupportedPlatformError} on platforms other than Windows.
 * @throws {DpapiError} with code `INVALID_INPUT`, `POWERSHELL_NOT_FOUND`,
 * `DPAPI_FAILURE` or `TIMEOUT` on failure.
 */
export async function encryptSecret(plainText: string, options?: DpapiOptions): Promise<string> {
  assertDpapiSupported();
  const text = requirePlainText(plainText);
  const resolved = resolveOptions(options);
  const payload = Buffer.from(text, "utf8").toString("base64");
  const stdout = await runDpapiCall("protect", payload, resolved);
  return requireProtectedOutput(stdout);
}

/**
 * Decrypts a base64-encoded DPAPI blob produced by {@link encryptSecret} and
 * returns the original UTF-8 string.
 *
 * @throws {DpapiUnsupportedPlatformError} on platforms other than Windows.
 * @throws {DpapiError} with code `INVALID_INPUT`, `INVALID_BASE64`,
 * `POWERSHELL_NOT_FOUND`, `DPAPI_FAILURE` or `TIMEOUT` on failure.
 */
export async function decryptSecret(encryptedBase64: string, options?: DpapiOptions): Promise<string> {
  assertDpapiSupported();
  const ciphertext = requireBase64Ciphertext(encryptedBase64);
  const resolved = resolveOptions(options);
  const stdout = await runDpapiCall("unprotect", ciphertext, resolved);

  // The base64 encoding of an empty byte sequence is the empty string, so an
  // empty stdout is a valid result here and means the secret was empty.
  let plainBytes: Buffer;
  if (stdout.length === 0) {
    plainBytes = Buffer.alloc(0);
  } else {
    if (!BASE64_PATTERN.test(stdout)) {
      throw new DpapiError(
        "DPAPI_FAILURE",
        "PowerShell returned an unexpected result while decrypting: expected base64 plaintext.",
      );
    }
    plainBytes = Buffer.from(stdout, "base64");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plainBytes);
  } catch (error) {
    throw new DpapiError(
      "DPAPI_FAILURE",
      "The decrypted payload is not valid UTF-8 text; the blob was not produced from a text secret.",
      error,
    );
  }
}

/**
 * Encrypts a string and writes the base64 DPAPI blob to `filePath` as UTF-8
 * text, with mode `0o600`.
 *
 * Parent directories are not created; create them first. The written file is a
 * DPAPI blob, not plaintext, but it should still be treated as sensitive: it is
 * decryptable by the same Windows user and must not be committed.
 *
 * @throws {DpapiError} with code `FILE_WRITE_FAILED` when the write fails.
 */
export async function encryptSecretToFile(
  plainText: string,
  filePath: string,
  options?: DpapiOptions,
): Promise<void> {
  assertDpapiSupported();
  const target = requireFilePath(filePath, "filePath");
  const ciphertext = await encryptSecret(plainText, options);
  try {
    await fs.writeFile(target, ciphertext, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const reason =
      code === "ENOENT"
        ? "the parent directory does not exist"
        : code === "EPERM" || code === "EACCES"
          ? "the process does not have permission to write there"
          : code === "EISDIR"
            ? "the path is a directory"
            : code !== undefined
              ? `a filesystem error occurred (${code})`
              : "a filesystem error occurred";
    throw new DpapiError(
      "FILE_WRITE_FAILED",
      `Could not write the encrypted secret to "${target}": ${reason}. The library does not create parent directories; create them first.`,
      error,
    );
  }
}

/**
 * Reads a base64 DPAPI blob from `filePath` and decrypts it.
 *
 * @throws {DpapiError} with code `FILE_NOT_FOUND` when the file does not exist,
 * `FILE_READ_FAILED` for other read errors, or the regular decrypt errors.
 */
export async function decryptSecretFromFile(filePath: string, options?: DpapiOptions): Promise<string> {
  assertDpapiSupported();
  const target = requireFilePath(filePath, "filePath");
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new DpapiError(
        "FILE_NOT_FOUND",
        `No encrypted secret file was found at "${target}". Create one with encryptSecretToFile().`,
        error,
      );
    }
    const reason =
      code === "EPERM" || code === "EACCES"
        ? "the process does not have permission to read it"
        : code === "EISDIR"
          ? "the path is a directory"
          : code !== undefined
            ? `a filesystem error occurred (${code})`
            : "a filesystem error occurred";
    throw new DpapiError("FILE_READ_FAILED", `Could not read the encrypted secret at "${target}": ${reason}.`, error);
  }
  return decryptSecret(raw.trim(), options);
}
