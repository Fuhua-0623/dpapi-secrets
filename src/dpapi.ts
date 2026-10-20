/**
 * PowerShell bridge for the Windows Data Protection API (DPAPI).
 *
 * The library has no native addon and no runtime dependencies: it runs a short
 * lived Windows PowerShell process that calls
 * `[Security.Cryptography.ProtectedData]` from the .NET base class library.
 *
 * Secrets travel over the child process's stdin, never over the command line.
 * Command-line arguments are visible to any process that can inspect the
 * command line on Windows, so a secret must never be passed in `argv`; only the
 * fixed PowerShell script is passed as an argument.
 */
import { spawn } from "node:child_process";
import { DpapiError } from "./errors.js";

/** DPAPI key material scope. */
export type DpapiScope = "CurrentUser" | "LocalMachine";

/** Options accepted by every public encrypt/decrypt function. */
export interface DpapiOptions {
  /**
   * Which DPAPI key material protects the secret.
   *
   * - `"CurrentUser"` (default): only the current Windows user can decrypt it.
   * - `"LocalMachine"`: any user on the machine can decrypt it.
   */
  scope?: DpapiScope;

  /** Hard limit for a single PowerShell invocation, in milliseconds. Defaults to 15000. */
  timeoutMs?: number;

  /**
   * PowerShell executable to spawn. Defaults to `"powershell.exe"` (resolved via
   * `PATH`). Override to use a specific install or a `pwsh` binary that can load
   * `System.Security.Cryptography.ProtectedData`.
   */
  powershellPath?: string;
}

/** Fully resolved options used by the bridge. */
export interface ResolvedDpapiOptions {
  scope: DpapiScope;
  timeoutMs: number;
  powershellPath: string;
}

/** Which ProtectedData entry point the generated PowerShell script calls. */
export type DpapiOperation = "protect" | "unprotect";

export const DEFAULT_SCOPE: DpapiScope = "CurrentUser";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_POWERSHELL_PATH = "powershell.exe";

/** Upper bound for either child-process stream, to keep memory usage bounded. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Maximum number of stderr characters copied into an error message. */
const MAX_STDERR_EXCERPT = 500;

/**
 * Builds the single-line `-Command` script for one DPAPI operation.
 *
 * The script reads its payload from stdin because anything passed as a
 * command-line argument can be observed by other local processes.
 *
 * Note on empty secrets: the base64 encoding of an empty UTF-8 string is the
 * empty string, so an empty stdin payload is a valid request to protect or
 * unprotect zero bytes. Treating it as a protocol error would make it
 * impossible to round-trip `""`, so the script intentionally accepts it.
 */
function buildScript(operation: DpapiOperation, scope: DpapiScope): string {
  const scopeLiteral = `[Security.Cryptography.DataProtectionScope]::${scope === "LocalMachine" ? "LocalMachine" : "CurrentUser"}`;
  const readStdin =
    "$ErrorActionPreference='Stop'; " +
    "Add-Type -AssemblyName System.Security; " +
    "$b64=[Console]::In.ReadToEnd().Trim(); " +
    "$bytes=[byte[]]@(); " +
    "if(-not [string]::IsNullOrEmpty($b64)){$bytes=[Convert]::FromBase64String($b64)}; " +
    `$scope=${scopeLiteral}; `;
  if (operation === "protect") {
    return (
      readStdin +
      "$blob=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope); " +
      "[Console]::Out.Write([Convert]::ToBase64String($blob))"
    );
  }
  return (
    readStdin +
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope); " +
    "[Console]::Out.Write([Convert]::ToBase64String($plain))"
  );
}

/** Maps a spawn failure to the public error type. */
function createSpawnError(error: unknown, powershellPath: string): DpapiError {
  const errno = error as NodeJS.ErrnoException | undefined;
  if (errno?.code === "ENOENT") {
    return new DpapiError(
      "POWERSHELL_NOT_FOUND",
      `Could not find the PowerShell executable "${powershellPath}". Windows PowerShell 5.1 is required by default; ` +
        'install it or pass options.powershellPath pointing at "powershell.exe" (or a "pwsh" build that provides ' +
        "System.Security.Cryptography.ProtectedData).",
      error,
    );
  }
  return new DpapiError(
    "DPAPI_FAILURE",
    `Failed to start PowerShell ("${powershellPath}"): ${errno?.message ?? String(error)}`,
    error,
  );
}

/**
 * Formats a bounded stderr excerpt for an error message.
 *
 * The stdin payload is redacted if PowerShell ever echoes it back, so an error
 * can never leak the secret or its ciphertext.
 */
function formatStderr(stderr: string, stdinText: string): string {
  if (stderr.length === 0) return "PowerShell wrote no diagnostic output.";
  let excerpt = stderr;
  const payload = stdinText.trim();
  if (payload.length > 0 && excerpt.includes(payload)) {
    excerpt = excerpt.split(payload).join("[redacted]");
  }
  if (excerpt.length > MAX_STDERR_EXCERPT) {
    excerpt = `${excerpt.slice(0, MAX_STDERR_EXCERPT)}...`;
  }
  return `PowerShell reported: ${excerpt}`;
}

/**
 * Runs one DPAPI operation through PowerShell.
 *
 * @param operation `"protect"` to encrypt, `"unprotect"` to decrypt.
 * @param stdinText Base64 payload written to the child's stdin.
 * @param options Resolved scope, timeout and executable path.
 * @returns The trimmed stdout content produced by PowerShell (base64 text).
 */
export function runDpapiCall(
  operation: DpapiOperation,
  stdinText: string,
  options: ResolvedDpapiOptions,
): Promise<string> {
  const script = buildScript(operation, options.scope);
  return new Promise<string>((resolve, reject) => {
    let child;
    try {
      child = spawn(
        options.powershellPath,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true },
      );
    } catch (error) {
      reject(createSpawnError(error, options.powershellPath));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      action();
    };

    timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(
          new DpapiError(
            "TIMEOUT",
            `The DPAPI helper did not finish within ${options.timeoutMs} ms and was terminated. ` +
              "Increase options.timeoutMs if PowerShell is slow to start on this machine.",
          ),
        ),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        settle(() =>
          reject(
            new DpapiError(
              "DPAPI_FAILURE",
              `PowerShell wrote more than ${MAX_OUTPUT_BYTES} bytes to stdout; the call was aborted to cap memory use.`,
            ),
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (settled || stderrBytes >= MAX_OUTPUT_BYTES) return;
      const room = MAX_OUTPUT_BYTES - stderrBytes;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderrBytes += piece.length;
      stderrChunks.push(piece);
    });

    child.on("error", (error: Error) => {
      settle(() => reject(createSpawnError(error, options.powershellPath)));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0) {
        settle(() => resolve(stdout));
        return;
      }
      if (code === null) {
        settle(() =>
          reject(
            new DpapiError(
              "DPAPI_FAILURE",
              `PowerShell was terminated before it produced a result (signal ${String(signal)}). ${formatStderr(stderr, stdinText)}`,
            ),
          ),
        );
        return;
      }
      settle(() =>
        reject(
          new DpapiError(
            "DPAPI_FAILURE",
            `PowerShell failed with exit code ${code} while running the ${operation} operation. ${formatStderr(stderr, stdinText)}`,
          ),
        ),
      );
    });

    // A broken pipe only means PowerShell exited before reading all of stdin;
    // the `close` handler above reports the actual failure. Registering the
    // listener also prevents an unhandled 'error' event from crashing the host.
    child.stdin.on("error", () => {});

    try {
      child.stdin.end(stdinText, "utf8");
    } catch (error) {
      settle(() => reject(new DpapiError("DPAPI_FAILURE", "Failed to send the DPAPI payload to PowerShell over stdin.", error)));
    }
  });
}
