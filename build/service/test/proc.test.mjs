import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, Supervised } from "../src/lib/proc.mjs";

test("redact hides keys, known secrets and recovery phrases", () => {
  assert.equal(redact("signer key 0xabc123def4567890", ["0xabc123def4567890"]), "signer key [hidden]");
  assert.match(redact('privateKey: "0x1234567890abcdef"'), /\[hidden\]/);
  assert.doesNotMatch(redact("SIGNER_PRIVATE_KEY=0xdeadbeefdeadbeef"), /deadbeef/);
  const phrase = "option moral foam lawsuit girl verb mango hour isolate flame symbol silly";
  assert.doesNotMatch(redact(`Using new mnemonic: ${phrase}`), /lawsuit/);
  assert.equal(redact("Stored Block number 345"), "Stored Block number 345");
  assert.equal(redact("  " + "ab".repeat(32)), "  [hidden]");
  assert.equal(redact("block hash 0x" + "ab".repeat(32) + " stored"), "block hash 0x" + "ab".repeat(32) + " stored");
});

test("supervised program: runs, keeps its log, stops", async () => {
  const p = new Supervised({
    name: "t",
    build: () => ({ cmd: process.execPath, args: ["-e", "console.log('hello'); setInterval(() => {}, 1000)"], env: {} }),
  });
  p.start();
  try {
    // wait for the first line: a busy build machine (emulated amd64) can take seconds to start Node.js
    for (let i = 0; i < 300 && p.tail().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.running, true);
    assert.deepEqual(p.tail(), ["hello"]);
  } finally {
    // always stop the child, or a failed check leaves it running and the test never ends
    await p.stop();
  }
  assert.equal(p.running, false);
});

test("supervised program: build() returning null means do not start", () => {
  const p = new Supervised({ name: "t", build: () => null });
  p.start();
  assert.equal(p.running, false);
  assert.equal(p.wanted, false);
});
