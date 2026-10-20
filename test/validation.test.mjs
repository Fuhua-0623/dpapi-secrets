import test from "node:test";
import assert from "node:assert/strict";
import {
  DpapiError,
  decryptSecret,
  encryptSecret,
  isDpapiSupported,
} from "../dist/index.js";

const skip = isDpapiSupported() ? false : "Windows DPAPI is only available on Windows";
const winTest = (name, fn) => test(name, { skip }, fn);

function isCode(expected) {
  return (error) => {
    assert.ok(error instanceof DpapiError, `expected a DpapiError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, expected);
    return true;
  };
}

winTest("encryptSecret rejects non-string plaintext with INVALID_INPUT", async () => {
  for (const value of [undefined, null, 42, true, {}, [], Buffer.from("bytes")]) {
    await assert.rejects(() => encryptSecret(value), isCode("INVALID_INPUT"));
  }
});

winTest("decryptSecret rejects non-string ciphertext with INVALID_INPUT", async () => {
  for (const value of [undefined, null, 42, true, {}, []]) {
    await assert.rejects(() => decryptSecret(value), isCode("INVALID_INPUT"));
  }
});

winTest("decryptSecret rejects malformed base64 with INVALID_BASE64", async () => {
  for (const value of ["", "   ", "not base64!!", "abc%def", "====", "AAAA!", 12]) {
    if (typeof value !== "string") {
      await assert.rejects(() => decryptSecret(value), isCode("INVALID_INPUT"));
    } else {
      await assert.rejects(() => decryptSecret(value), isCode("INVALID_BASE64"));
    }
  }
});

winTest("encryptSecret rejects an unknown scope with INVALID_INPUT", async () => {
  for (const scope of ["Everyone", "currentuser", "LocalMachine ", 1, null]) {
    await assert.rejects(() => encryptSecret("value", { scope }), isCode("INVALID_INPUT"));
  }
});

winTest("encryptSecret rejects a non-positive or non-numeric timeout with INVALID_INPUT", async () => {
  for (const timeoutMs of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY, "fast", null]) {
    await assert.rejects(() => encryptSecret("value", { timeoutMs }), isCode("INVALID_INPUT"));
  }
});

winTest("encryptSecret rejects an empty powershellPath with INVALID_INPUT", async () => {
  for (const powershellPath of ["", "   ", null, 42]) {
    await assert.rejects(() => encryptSecret("value", { powershellPath }), isCode("INVALID_INPUT"));
  }
});

winTest("encryptSecret rejects a non-object options value with INVALID_INPUT", async () => {
  for (const options of [null, [], "options", 7]) {
    await assert.rejects(() => encryptSecret("value", options), isCode("INVALID_INPUT"));
  }
});

winTest("encryptSecret reports POWERSHELL_NOT_FOUND for a missing executable", async () => {
  await assert.rejects(
    () => encryptSecret("value", { powershellPath: "dpapi-secrets-no-such-powershell-9e5c3f" }),
    isCode("POWERSHELL_NOT_FOUND"),
  );
});

winTest("encryptSecret reports TIMEOUT when the helper exceeds timeoutMs", async () => {
  await assert.rejects(() => encryptSecret("value", { timeoutMs: 1 }), isCode("TIMEOUT"));
});
