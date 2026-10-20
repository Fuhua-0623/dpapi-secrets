<p align="center"><a href="./README.md">English</a> | <a href="./README-zh-CN.md">简体中文</a></p>

# @fuhua-0623/dpapi-secrets

[![npm version](https://img.shields.io/npm/v/@fuhua-0623/dpapi-secrets.svg)](https://www.npmjs.com/package/@fuhua-0623/dpapi-secrets)
[![CI](https://github.com/Fuhua-0623/dpapi-secrets/actions/workflows/ci.yml/badge.svg)](https://github.com/Fuhua-0623/dpapi-secrets/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Fuhua-0623/dpapi-secrets/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

> **Stop hardcoding API keys in Windows Node.js apps.** Encrypt them with the Windows Data Protection API and let Windows hold the key material.

Encrypt and decrypt local secrets with the Windows Data Protection API (DPAPI) from Node.js, with no native dependencies.

`@fuhua-0623/dpapi-secrets` gives Node.js applications a small, promise-based API for protecting configuration values, API keys and other local secrets with the same user-bound encryption Windows itself uses. There is no native addon to compile, no prebuilt binary to download and no runtime dependency: the package shells out to the Windows PowerShell that already ships with Windows.

```js
import { encryptSecret, decryptSecret } from "@fuhua-0623/dpapi-secrets";

const blob = await encryptSecret("my-api-key");
// persist `blob` in a config file or environment variable
const apiKey = await decryptSecret(blob);
```

## The problem

Most Node.js applications keep their secrets in plaintext, because the alternatives are inconvenient:

- `.env` files, JSON config files and YAML manifests hold API keys and connection strings in clear text.
- A single careless `git add .` commits those secrets to history, where they are hard to remove and easy to scrape.
- Plaintext secrets are copied into backups, cloud sync folders, crash reports and log files.
- Copying a project between machines means copying its secrets in the open.

Password-based encryption shifts the problem: you still need somewhere to keep the password. `@fuhua-0623/dpapi-secrets` avoids that by using DPAPI, where the key material is managed by Windows and bound to the Windows account (or machine) that created the blob. Your application stores an opaque base64 string; only the same Windows user can turn it back into a secret.

## How it works

1. Your code calls `encryptSecret()` or `decryptSecret()`.
2. The library starts a short-lived Windows PowerShell process with `-NoProfile -NonInteractive`.
3. A one-line PowerShell script calls `[Security.Cryptography.ProtectedData]::Protect` or `Unprotect` from the .NET base class library, using the `CurrentUser` (default) or `LocalMachine` DPAPI scope.
4. The payload — base64 of the UTF-8 plaintext when encrypting, or the validated base64 blob when decrypting — is written to the child process's **stdin**. The script reads it with `[Console]::In.ReadToEnd()`.
5. The child writes the resulting base64 string to stdout, and the library returns it.

The stdin transport matters: command-line arguments are visible to other processes on Windows, so a secret must never be passed in `argv`. Nothing sensitive is written to disk by the library, and nothing sensitive is logged. DPAPI uses per-user key material derived by Windows, so ciphertext is bound to the user profile (or the machine, if you opt into the `LocalMachine` scope).

## Requirements

- **Windows** (`process.platform === "win32"`). Other platforms are not supported and receive a clear `UNSUPPORTED_PLATFORM` error.
- **Node.js 18 or newer.**
- **Windows PowerShell 5.1**, which is present on supported Windows versions by default and is spawned as `powershell.exe` from `PATH`.
- PowerShell 7 (`pwsh`) can be used through the `powershellPath` option, but it must be able to load the `System.Security.Cryptography.ProtectedData` assembly (see [Troubleshooting](#troubleshooting)).

## Installation

```sh
npm install @fuhua-0623/dpapi-secrets
```

Until the package is published to npm, install it straight from GitHub — npm runs the `prepare` script and builds the package locally (requires Git and a local Node.js toolchain):

```sh
npm install github:Fuhua-0623/dpapi-secrets
```

The package is ESM-only and has zero runtime dependencies. TypeScript types are bundled.

## Quick start

### Encrypt and decrypt a string

```js
import { encryptSecret, decryptSecret } from "@fuhua-0623/dpapi-secrets";

const blob = await encryptSecret("my-api-key");
// blob is a base64 DPAPI blob, e.g. "AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA..."
// Store it in a config file, a database row or an environment variable.

const apiKey = await decryptSecret(blob);
// apiKey is "my-api-key" again

```

### Encrypt and decrypt a file

```js
import os from "node:os";
import path from "node:path";
import {
  encryptSecretToFile,
  decryptSecretFromFile,
} from "@fuhua-0623/dpapi-secrets";

const secretFile = path.join(os.homedir(), ".my-app", "api-key.dpapi");

await encryptSecretToFile("my-api-key", secretFile);
const apiKey = await decryptSecretFromFile(secretFile);
```

`encryptSecretToFile` writes the base64 blob as UTF-8 text with mode `0o600`. It does not create parent directories; create them first. Add `*.dpapi` to your `.gitignore`.

### A small config loader

Generate the blob once, then decrypt it at runtime without a password anywhere in the source tree:

```js
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decryptSecretFromFile,
  encryptSecretToFile,
  isDpapiSupported,
} from "@fuhua-0623/dpapi-secrets";

const secretFile = path.join(os.homedir(), ".my-app", "api-key.dpapi");

export async function loadApiKey() {
  if (!isDpapiSupported()) {
    throw new Error("Stored API keys are only available on Windows.");
  }

  if (process.argv.includes("--store-api-key")) {
    const key = await promptForSecret(); // implement your own hidden prompt
    await fs.mkdir(path.dirname(secretFile), { recursive: true });
    await encryptSecretToFile(key, secretFile);
    return key;
  }

  if (!(await fileExists(secretFile))) {
    throw new Error(`No stored API key. Run with --store-api-key to create ${secretFile}.`);
  }
  return decryptSecretFromFile(secretFile);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
```

## API reference

All functions are asynchronous (except `isDpapiSupported`) and accept an optional `DpapiOptions` object as their last argument.

### Functions

| Function | Returns | Description |
| --- | --- | --- |
| `isDpapiSupported()` | `boolean` | `true` when `process.platform === "win32"`. |
| `encryptSecret(plainText, options?)` | `Promise<string>` | Encrypts a UTF-8 string and returns a base64 DPAPI blob. Empty strings are allowed and round-trip. |
| `decryptSecret(encryptedBase64, options?)` | `Promise<string>` | Decrypts a base64 DPAPI blob produced by `encryptSecret`. |
| `encryptSecretToFile(plainText, filePath, options?)` | `Promise<void>` | Encrypts a string and writes the base64 blob to `filePath` with mode `0o600`. |
| `decryptSecretFromFile(filePath, options?)` | `Promise<string>` | Reads a base64 blob from `filePath` and decrypts it. |

### `DpapiOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `scope` | `"CurrentUser" \| "LocalMachine"` | `"CurrentUser"` | DPAPI key material to use. See [Scopes](#scopes). |
| `timeoutMs` | `number` | `15000` | Hard limit for a single PowerShell invocation. The child process is killed and the call rejects with `TIMEOUT`. |
| `powershellPath` | `string` | `"powershell.exe"` | PowerShell executable, resolved through `PATH`. Override for `pwsh` or a specific install. |

### Errors

Every rejected promise is a `DpapiError` with a stable `code`, a human-readable `message` and, where applicable, a `cause`:

```js
import { DpapiError, decryptSecret } from "@fuhua-0623/dpapi-secrets";

try {
  await decryptSecret(someBlob);
} catch (error) {
  if (error instanceof DpapiError) {
    console.error(error.code); // e.g. "DPAPI_FAILURE"
  }
}
```

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | Called on a platform other than Windows. The error class is `DpapiUnsupportedPlatformError`. |
| `INVALID_INPUT` | A string, option or file path argument had the wrong type or value. |
| `INVALID_BASE64` | `encryptedBase64` is empty, malformed or does not decode to any bytes. |
| `POWERSHELL_NOT_FOUND` | The PowerShell executable could not be spawned (usually `ENOENT`); check `powershellPath` / `PATH`. |
| `DPAPI_FAILURE` | PowerShell exited non-zero or returned an unexpected result: bad blob, wrong scope, wrong user, or an unavailable `ProtectedData` assembly. |
| `TIMEOUT` | The PowerShell helper exceeded `timeoutMs` and was terminated. |
| `FILE_NOT_FOUND` | `decryptSecretFromFile` could not find the file. |
| `FILE_READ_FAILED` | The file exists but could not be read. |
| `FILE_WRITE_FAILED` | `encryptSecretToFile` could not write the file, e.g. because the parent directory is missing or permissions are insufficient. |

Error messages include a bounded excerpt of PowerShell's stderr but never the plaintext or the ciphertext. The library never logs secrets: its source contains no logging calls.

## Scopes

DPAPI encrypts with key material owned by either the current user or the local machine.

| Scope | Who can decrypt | When to use it |
| --- | --- | --- |
| `"CurrentUser"` (default) | Only the Windows account that encrypted the blob. | Almost always. Interactive apps, developer tools, CLIs and services running under a dedicated account. |
| `"LocalMachine"` | Any user who can log on to the machine, and any process running as any user on it. | Only when a service account cannot read user-scoped material and you accept that every local user can decrypt the blob. |

Ciphertext created with `CurrentUser` cannot be decrypted with `LocalMachine` and vice versa: the scope is part of the protection. Because `LocalMachine` weakens the security boundary, prefer `CurrentUser` unless you have a concrete service-account reason.

## Security notes

`@fuhua-0623/dpapi-secrets` protects secrets **at rest** on a Windows machine. It is not a substitute for a full secrets management system.

- A decrypted secret lives in the memory of the Node.js process while it is in use. Malware running as the same user can read process memory, so DPAPI does not protect against a compromised interactive session.
- Blobs are not portable. A blob encrypted by one Windows user cannot be decrypted by another user, and generally cannot be decrypted on another machine. Regenerate blobs when you move to a new machine or account.
- Do not commit blobs to version control. They are ciphertext, but they are ciphertext that the right local account can decrypt. Add `*.dpapi` and `*.secret` to `.gitignore`.
- Rotate by re-encrypting: decrypt, then call `encryptSecret` again. DPAPI does not provide server-side rotation, audit logs or revocation.
- This is not a full secrets manager: there is no central distribution, access control, rotation, or audit trail. For fleet-wide secrets, use a dedicated secrets service.
- Never pass a secret on a command line. This library sends payloads over stdin for exactly that reason; do the same in your own scripts.
- Keep `powershellPath` pointed at a trusted executable. A malicious PowerShell binary would obviously see the payload on stdin.

## Platform support

| Platform | Supported | Notes |
| --- | --- | --- |
| Windows 10/11, Windows Server with Windows PowerShell 5.1 | Yes | Default configuration. |
| Windows with PowerShell 7 (`pwsh`) and `System.Security.Cryptography.ProtectedData` available | Yes, with `powershellPath` | Set `powershellPath: "pwsh"` and verify the assembly loads. |
| Windows with PowerShell 7 without that assembly | No | Use Windows PowerShell 5.1 or install the assembly. |
| macOS, Linux, BSD | No | All encrypt/decrypt/file calls throw `UNSUPPORTED_PLATFORM`. Check `isDpapiSupported()` first. |

Node.js 18 or newer is required on every platform.

## Troubleshooting

**`POWERSHELL_NOT_FOUND`**
The executable named by `powershellPath` could not be started. Windows PowerShell 5.1 normally lives at `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`; if it is not on `PATH`, pass that absolute path as `powershellPath`, or install Windows PowerShell 5.1.

**`DPAPI_FAILURE` mentioning `ProtectedData` or `System.Security` on PowerShell 7**
PowerShell 7 does not always ship the `System.Security.Cryptography.ProtectedData` assembly. Either keep the default `powershell.exe` (Windows PowerShell 5.1), or install the assembly for `pwsh` and set `powershellPath: "pwsh"`.

**`DPAPI_FAILURE` after moving a config file**
The blob was encrypted by a different Windows user, with a different scope, or on a different machine. Decrypting cannot recover it; re-encrypt the secret in the new environment.

**`DPAPI_FAILURE` for a blob stored in an environment variable**
Environment variables can be mangled by trailing newlines or shell escaping. The library trims surrounding whitespace, but a truncated or altered blob will not decrypt. Store blobs in files when possible.

**`TIMEOUT`**
PowerShell startup is slow on some machines (antivirus scanning, roaming profiles). Increase `timeoutMs`, or investigate why process creation is slow.

**Using the package from CommonJS**
The package is ESM-only. `require("@fuhua-0623/dpapi-secrets")` fails with `ERR_REQUIRE_ESM`; use a dynamic import instead:

```js
const { decryptSecret } = await import("@fuhua-0623/dpapi-secrets");
```

## License

MIT. See [LICENSE](LICENSE).
