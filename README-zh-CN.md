<p align="center"><a href="./README.md">English</a> | <a href="./README-zh-CN.md"><strong>简体中文</strong></a></p>

# @fuhua-0623/dpapi-secrets

[![npm version](https://img.shields.io/npm/v/@fuhua-0623/dpapi-secrets.svg)](https://www.npmjs.com/package/@fuhua-0623/dpapi-secrets)
[![CI](https://github.com/Fuhua-0623/dpapi-secrets/actions/workflows/ci.yml/badge.svg)](https://github.com/Fuhua-0623/dpapi-secrets/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Fuhua-0623/dpapi-secrets/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

> **别再在 Windows Node.js 应用里硬编码 API 密钥。** 用 Windows 数据保护 API 加密它们，让 Windows 替你保管密钥材料。

在 Node.js 中使用 Windows 数据保护 API（DPAPI）加密和解密本地机密，无需任何原生依赖。

`@fuhua-0623/dpapi-secrets` 为 Node.js 应用提供一套小巧的、基于 Promise 的 API，用与 Windows 自身相同的、绑定到用户的加密机制来保护配置值、API 密钥和其他本地机密。无需编译原生插件，无需下载预编译二进制文件，也没有任何运行时依赖：本包通过调用 Windows 自带的 Windows PowerShell 来完成任务。

```js
import { encryptSecret, decryptSecret } from "@fuhua-0623/dpapi-secrets";

const blob = await encryptSecret("my-api-key");
// persist `blob` in a config file or environment variable
const apiKey = await decryptSecret(blob);
```

## 问题所在

大多数 Node.js 应用都以明文保存机密，因为其他替代方案都不太方便：

- `.env` 文件、JSON 配置文件和 YAML 清单以明文保存 API 密钥和连接字符串。
- 一次疏忽的 `git add .` 就会把这些机密提交进历史记录，既难以移除，又容易被抓取。
- 明文机密会被复制进备份、云同步文件夹、崩溃报告和日志文件。
- 在机器之间复制项目，就意味着以明文形式复制其中的机密。

基于口令的加密只是把问题转移了：你仍然需要找个地方存放口令。`@fuhua-0623/dpapi-secrets` 通过使用 DPAPI 规避了这一点——在 DPAPI 中，密钥材料由 Windows 管理，并绑定到创建加密数据块的那个 Windows 账户（或这台机器）。你的应用只需保存一个不透明的 base64 字符串；只有同一个 Windows 用户才能把它还原成机密。

## 工作原理

1. 你的代码调用 `encryptSecret()` 或 `decryptSecret()`。
2. 本库会启动一个短生命周期的 Windows PowerShell 进程，参数为 `-NoProfile -NonInteractive`。
3. 一段单行 PowerShell 脚本从 .NET 基础类库中调用 `[Security.Cryptography.ProtectedData]::Protect` 或 `Unprotect`，使用 `CurrentUser`（默认）或 `LocalMachine` 的 DPAPI 作用域。
4. 载荷——加密时是 UTF-8 明文的 base64，解密时是校验过的 base64 加密数据块——通过子进程的**标准输入**写入，脚本用 `[Console]::In.ReadToEnd()` 读取。
5. 子进程把得到的 base64 字符串写到标准输出，本库再把它返回。

通过标准输入传输这一点很重要：在 Windows 上，命令行参数对其他进程可见，因此机密绝不应通过 `argv` 传递。本库不会把任何敏感信息写入磁盘，也不会记录任何敏感信息。DPAPI 使用由 Windows 派生的、按用户划分的密钥材料，因此密文与用户配置文件绑定（如果你选择 `LocalMachine` 作用域，则与整台机器绑定）。

## 环境要求

- **Windows**（`process.platform === "win32"`）。不支持其他平台，在这些平台上会收到清晰的 `UNSUPPORTED_PLATFORM` 错误。
- **Node.js 18 或更高版本。**
- **Windows PowerShell 5.1**，受支持的 Windows 版本默认自带，本库会从 `PATH` 中启动 `powershell.exe`。
- 可以通过 `powershellPath` 选项使用 PowerShell 7（`pwsh`），但它必须能够加载 `System.Security.Cryptography.ProtectedData` 程序集（参见[故障排查](#故障排查)）。

## 安装

```sh
npm install @fuhua-0623/dpapi-secrets
```

在包发布到 npm 之前，可以直接从 GitHub 安装——npm 会运行 `prepare` 脚本并在本地构建本包（需要 Git 和本地 Node.js 工具链）：

```sh
npm install github:Fuhua-0623/dpapi-secrets
```

本包仅支持 ESM（ES 模块），零运行时依赖，并自带 TypeScript 类型定义。

## 快速开始

### 加密和解密字符串

```js
import { encryptSecret, decryptSecret } from "@fuhua-0623/dpapi-secrets";

const blob = await encryptSecret("my-api-key");
// blob is a base64 DPAPI blob, e.g. "AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA..."
// Store it in a config file, a database row or an environment variable.

const apiKey = await decryptSecret(blob);
// apiKey is "my-api-key" again

```

### 加密和解密文件

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

`encryptSecretToFile` 以 UTF-8 文本写入 base64 加密数据块，文件模式为 `0o600`。它不会创建父目录，请先自行创建。把 `*.dpapi` 加入你的 `.gitignore`。

### 简易配置加载器

先一次性生成加密数据块，之后在运行时解密它，源码树中无需出现任何口令：

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

## API 参考

除 `isDpapiSupported` 外，所有函数都是异步的，并且接受一个可选的 `DpapiOptions` 对象作为最后一个参数。

### 函数

| 函数 | 返回值 | 说明 |
| --- | --- | --- |
| `isDpapiSupported()` | `boolean` | 当 `process.platform === "win32"` 时为 `true`。 |
| `encryptSecret(plainText, options?)` | `Promise<string>` | 加密 UTF-8 字符串并返回 base64 DPAPI 加密数据块。允许空字符串，且可完整往返。 |
| `decryptSecret(encryptedBase64, options?)` | `Promise<string>` | 解密由 `encryptSecret` 生成的 base64 DPAPI 加密数据块。 |
| `encryptSecretToFile(plainText, filePath, options?)` | `Promise<void>` | 加密字符串，并以模式 `0o600` 把 base64 加密数据块写入 `filePath`。 |
| `decryptSecretFromFile(filePath, options?)` | `Promise<string>` | 从 `filePath` 读取 base64 加密数据块并解密。 |

### `DpapiOptions`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `scope` | `"CurrentUser" \| "LocalMachine"` | `"CurrentUser"` | 要使用的 DPAPI 密钥材料。参见[作用域](#作用域)。 |
| `timeoutMs` | `number` | `15000` | 单次 PowerShell 调用的硬性时限。超时后会终止子进程，并使调用以 `TIMEOUT` 拒绝。 |
| `powershellPath` | `string` | `"powershell.exe"` | PowerShell 可执行文件，通过 `PATH` 解析。可覆盖为 `pwsh` 或某个具体安装路径。 |

### 错误

每个被拒绝的 Promise 都是 `DpapiError`，带有稳定的 `code`、人类可读的 `message`，以及（在适用时）`cause`：

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

| 错误码 | 含义 |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | 在非 Windows 平台上调用。错误类为 `DpapiUnsupportedPlatformError`。 |
| `INVALID_INPUT` | 字符串、选项或文件路径参数的类型或值不正确。 |
| `INVALID_BASE64` | `encryptedBase64` 为空、格式错误或无法解码出任何字节。 |
| `POWERSHELL_NOT_FOUND` | 无法启动 PowerShell 可执行文件（通常是 `ENOENT`）；请检查 `powershellPath` / `PATH`。 |
| `DPAPI_FAILURE` | PowerShell 以非零状态退出，或返回了意外结果：加密数据块损坏、作用域错误、用户错误，或 `ProtectedData` 程序集不可用。 |
| `TIMEOUT` | PowerShell 辅助进程超过了 `timeoutMs` 并被终止。 |
| `FILE_NOT_FOUND` | `decryptSecretFromFile` 找不到文件。 |
| `FILE_READ_FAILED` | 文件存在但无法读取。 |
| `FILE_WRITE_FAILED` | `encryptSecretToFile` 无法写入文件，例如父目录不存在或权限不足。 |

错误消息会包含一段长度受限的 PowerShell 标准错误输出摘录，但绝不会包含明文或密文。本库从不记录机密：其源码中没有任何日志调用。

## 作用域

DPAPI 使用当前用户或本地机器所拥有的密钥材料进行加密。

| 作用域 | 谁可以解密 | 何时使用 |
| --- | --- | --- |
| `"CurrentUser"`（默认） | 只有加密该数据块的那个 Windows 账户。 | 几乎总是。交互式应用、开发者工具、CLI，以及以专用账户运行的服务。 |
| `"LocalMachine"` | 任何能登录这台机器的用户，以及机器上以任意用户身份运行的任意进程。 | 仅当服务账户无法读取用户作用域的材料，且你能接受本机所有用户都能解密该数据块时。 |

用 `CurrentUser` 创建的密文无法用 `LocalMachine` 解密，反之亦然：作用域是保护机制的一部分。由于 `LocalMachine` 会削弱安全边界，除非你有明确的服务账户理由，否则应优先使用 `CurrentUser`。

## 安全说明

`@fuhua-0623/dpapi-secrets` 在 Windows 机器上保护静态存储的机密，但它不能替代完整的机密管理系统。

- 解密后的机密在使用期间会存在于 Node.js 进程的内存中。以同一用户身份运行的恶意软件可以读取进程内存，因此 DPAPI 无法抵御已被攻陷的交互式会话。
- 加密数据块不可移植。由一个 Windows 用户加密的数据块无法被另一个用户解密，通常也无法在另一台机器上解密。迁移到新机器或新账户时，请重新生成加密数据块。
- 不要把加密数据块提交到版本控制。它们虽然是密文，但却是本地相应账户可以解密的密文。请把 `*.dpapi` 和 `*.secret` 加入 `.gitignore`。
- 通过重新加密来轮换：先解密，再调用一次 `encryptSecret`。DPAPI 不提供服务端轮换、审计日志或吊销机制。
- 这不是完整的机密管理系统：它没有集中分发、访问控制、轮换或审计轨迹。对于大规模（fleet-wide）机密，请使用专门的机密服务。
- 绝不要在命令行上传递机密。本库正是出于这个原因才通过标准输入传输载荷；在你自己的脚本中也请这样做。
- 让 `powershellPath` 指向受信任的可执行文件。恶意的 PowerShell 二进制文件显然能够看到标准输入上的载荷。

## 平台支持

| 平台 | 是否支持 | 说明 |
| --- | --- | --- |
| 运行 Windows PowerShell 5.1 的 Windows 10/11、Windows Server | 是 | 默认配置。 |
| 安装了 PowerShell 7（`pwsh`）且 `System.Security.Cryptography.ProtectedData` 可用的 Windows | 是，需指定 `powershellPath` | 设置 `powershellPath: "pwsh"`，并确认该程序集可以加载。 |
| 缺少该程序集的 PowerShell 7 Windows 环境 | 否 | 改用 Windows PowerShell 5.1，或安装该程序集。 |
| macOS、Linux、BSD | 否 | 所有加密/解密/文件调用都会抛出 `UNSUPPORTED_PLATFORM`。请先检查 `isDpapiSupported()`。 |

在所有平台上都需要 Node.js 18 或更高版本。

## 故障排查

**`POWERSHELL_NOT_FOUND`**
`powershellPath` 指定的可执行文件无法启动。Windows PowerShell 5.1 通常位于 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`；如果它不在 `PATH` 中，请把该绝对路径作为 `powershellPath` 传入，或安装 Windows PowerShell 5.1。

**在 PowerShell 7 上提示 `ProtectedData` 或 `System.Security` 的 `DPAPI_FAILURE`**
PowerShell 7 并不总是自带 `System.Security.Cryptography.ProtectedData` 程序集。要么继续使用默认的 `powershell.exe`（Windows PowerShell 5.1），要么为 `pwsh` 安装该程序集并设置 `powershellPath: "pwsh"`。

**移动配置文件后出现 `DPAPI_FAILURE`**
该加密数据块是由另一个 Windows 用户、以不同的作用域或在另一台机器上加密的。解密无法恢复它；请在新环境中重新加密该机密。

**从环境变量读取的加密数据块出现 `DPAPI_FAILURE`**
环境变量可能因行尾换行符或 shell 转义而被破坏。本库会去除首尾空白，但被截断或篡改过的加密数据块将无法解密。尽可能把加密数据块存放在文件中。

**`TIMEOUT`**
在某些机器上 PowerShell 启动较慢（例如杀毒软件扫描、漫游配置文件）。请增大 `timeoutMs`，或排查进程创建为何缓慢。

**在 CommonJS 中使用本包**
本包仅支持 ESM（ES 模块）。`require("@fuhua-0623/dpapi-secrets")` 会以 `ERR_REQUIRE_ESM` 失败；请改用动态导入：

```js
const { decryptSecret } = await import("@fuhua-0623/dpapi-secrets");
```

## 许可证

MIT。参见 [LICENSE](LICENSE)。
