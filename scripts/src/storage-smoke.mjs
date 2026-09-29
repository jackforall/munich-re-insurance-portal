import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const secret = "test-secret";
const objectPath = "/objects/uploads/test";
const payload = {
  objectPath,
  contentType: "text/plain",
  size: 5,
  expiresAt: Date.now() + 60_000,
};
const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
const token = `${encoded}.${signature}`;

assert.equal(token.split(".").length, 2);
assert.equal(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).objectPath, objectPath);
assert.equal(signature, createHmac("sha256", secret).update(encoded).digest("base64url"));
console.log("storage token smoke test: ok");
