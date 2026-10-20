import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DpapiError,
  decryptSecretFromFile,
  encryptSecretToFile,
  isDpapiSupported,
} from "../dist/index.js";

const skip = isDpapiSupported() ? false : "Windows DPAPI is only available on Windows";
const winTest = (name, fn) => test(name, { skip }, fn);

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function assertDpapiError(expectedCode) {
  return (error) => {
    assert.ok(error instanceof DpapiError, `expected a DpapiError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpapi-secrets-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

winTest("encryptSecretToFile writes a base64 blob and decryptSecretFromFile restores it", async (t) => {
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "secret.dpapi");
  const plainText = "file-backed-secret-2718";

  await encryptSecretToFile(plainText, filePath);

  const content = await fs.readFile(filePath, "utf8");
  assert.match(content, BASE64_PATTERN, "file content should be a base64 DPAPI blob");
  assert.ok(!content.includes(plainText), "file content must not contain the plaintext");
  assert.ok(Buffer.from(content, "base64").length > 0);

  assert.equal(await decryptSecretFromFile(filePath), plainText);
});

winTest("an empty secret round-trips through the file helpers", async (t) => {
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "empty.dpapi");
  await encryptSecretToFile("", filePath);
  const content = await fs.readFile(filePath, "utf8");
  assert.match(content, BASE64_PATTERN);
  assert.equal(await decryptSecretFromFile(filePath), "");
});

winTest("decryptSecretFromFile reports FILE_NOT_FOUND for a missing file", async (t) => {
  const dir = await makeTempDir(t);
  const missing = path.join(dir, "does-not-exist.dpapi");
  await assert.rejects(() => decryptSecretFromFile(missing), assertDpapiError("FILE_NOT_FOUND"));
});

winTest("encryptSecretToFile reports FILE_WRITE_FAILED when the parent directory is missing", async (t) => {
  const dir = await makeTempDir(t);
  const missingParent = path.join(dir, "no-such-directory", "secret.dpapi");
  await assert.rejects(
    () => encryptSecretToFile("value", missingParent),
    assertDpapiError("FILE_WRITE_FAILED"),
  );
});

winTest("file helpers validate their path argument with INVALID_INPUT", async (t) => {
  const dir = await makeTempDir(t);
  for (const filePath of ["", "   ", null, 42]) {
    await assert.rejects(() => encryptSecretToFile("value", filePath), assertDpapiError("INVALID_INPUT"));
    await assert.rejects(() => decryptSecretFromFile(filePath), assertDpapiError("INVALID_INPUT"));
  }
  // A valid path must still be required to exist before decrypting.
  await assert.rejects(
    () => decryptSecretFromFile(path.join(dir, "missing.dpapi")),
    assertDpapiError("FILE_NOT_FOUND"),
  );
});
