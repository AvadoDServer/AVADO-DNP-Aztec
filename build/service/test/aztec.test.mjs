import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AztecBox, explainLine, splitOptions } from "../src/aztec.mjs";
import { gethOptsWithDebug } from "../src/lib/dappmanager.mjs";
import { forgetTracing, isMethodMissing, probeTracing, probeTracingKept } from "../src/lib/l1.mjs";
import { keygenError, makeKeys, normaliseWords, parseKeystore, withCoinbase } from "../src/keys.mjs";

const KEY = "0x" + "11".repeat(32);
const BLS = "0x" + "22".repeat(32);
const KEYSTORE = { schemaVersion: 1, validators: [{ attester: { eth: KEY, bls: BLS }, feeRecipient: "0x" + "00".repeat(32) }] };
const STAKER = [{ attester: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A", publicKeyG1: { x: "0x1", y: "0x2" } }];

function stubBox({ el = {}, cl = {}, rpc } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aztec-"));
  const calls = [];
  const box = new AztecBox({
    dataDir: dir,
    env: { PATH: "/bin", EXTRA_OPTS: "" },
    log: () => {},
    probeEl: async (c) => ({ id: c.id, title: c.title, installed: c.id === "nethermind", answering: true, mainnet: true, synced: true, tracing: true, ...el }),
    probeCl: async (c) => ({ id: c.id, title: c.title, installed: c.id === "teku", answering: true, synced: true, ...cl }),
    rpc: rpc || (async () => { throw new Error("offline"); }),
    keyTools: {
      newWords: async () => "abandon ".repeat(23) + "art",
      makeKeys: async (o) => {
        calls.push(o);
        return { keystore: KEYSTORE, stakerOutput: STAKER };
      },
      addressOf: async () => STAKER[0].attester,
      enableGethTracing: async () => ({ changed: true, before: "--http.api eth", after: "--http.api eth,debug" }),
    },
  });
  // never start the real node in tests
  box.proc.start = () => {};
  box.proc.restart = async () => {};
  box.proc.stop = async () => {};
  return { box, dir, calls };
}

test("extra options are split on spaces only", () => {
  assert.deepEqual(splitOptions("  --a 1   --b "), ["--a", "1", "--b"]);
  assert.deepEqual(splitOptions(undefined), []);
});

test("log lines become plain problems", () => {
  assert.equal(explainLine("Error: insufficient funds for gas * price + value"), "lowEth");
  assert.equal(explainLine("ENOSPC: no space left on device"), "diskFull");
  assert.equal(explainLine("ERROR: node Failed during node creation: Error: L1 RPC at https://x does not return historical logs for the Rollup contract."), "noHistoricalLogs");
  assert.equal(explainLine("Archiver synced to L1 block 123"), null);
});

test("geth options get debug added once", () => {
  assert.equal(gethOptsWithDebug("--http.api eth,net,web3,txpool"), "--http.api eth,net,web3,txpool,debug");
  assert.equal(gethOptsWithDebug("--http.api=eth,net --cache 4096"), "--http.api=eth,net,debug --cache 4096");
  assert.equal(gethOptsWithDebug('--rpcapi "eth,net"'), '--rpcapi "eth,net,debug"');
  assert.equal(gethOptsWithDebug("--http.api eth,debug,net"), null);
  assert.equal(gethOptsWithDebug(""), "--http.api eth,net,web3,txpool,debug");
  assert.equal(gethOptsWithDebug("--cache 4096"), "--cache 4096 --http.api eth,net,web3,txpool,debug");
});

test("tracing probe: method missing means no, transaction not found means yes", async () => {
  const missing = Object.assign(new Error("the method debug_traceTransaction does not exist/is not available"), { code: -32601 });
  const notFound = Object.assign(new Error("transaction not found"), { code: -32000 });
  assert.equal(isMethodMissing(missing), true);
  assert.equal(isMethodMissing(notFound), false);
  assert.equal(await probeTracing("x", async () => { throw missing; }), false);
  assert.equal(await probeTracing("x", async () => { throw notFound; }), true);
  // Nethermind: no debug module, but trace_transaction answers null for an unknown transaction
  assert.equal(await probeTracing("x", async (_u, m) => { if (m.startsWith("debug_")) throw missing; return null; }), true);
  // a timeout is not a yes
  assert.equal(await probeTracing("x", async () => { throw new Error("timeout"); }), false);
});

test("keystore check accepts the Aztec tool's file and refuses others", () => {
  assert.equal(parseKeystore(JSON.stringify(KEYSTORE)).validators.length, 1);
  assert.throws(() => parseKeystore("not json"), /not JSON/);
  assert.throws(() => parseKeystore(JSON.stringify(STAKER)), /not an Aztec keystore/);
  assert.throws(() => parseKeystore({ schemaVersion: 1, validators: [{ attester: { eth: { path: "x", password: "y" } } }] }), /format/);
  const withCb = withCoinbase(KEYSTORE, "0x" + "ab".repeat(20));
  assert.equal(withCb.validators[0].coinbase, "0x" + "ab".repeat(20));
  assert.throws(() => withCoinbase(KEYSTORE, "0x12"), /Ethereum address/);
});

test("recovery words are cleaned up and checked", () => {
  assert.equal(normaliseWords("  Abandon  ABANDON\nabandon abandon abandon abandon abandon abandon abandon abandon abandon about "), "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  assert.throws(() => normaliseWords("one two three"), /12 or 24/);
});

test("makeKeys calls the Aztec tool for mainnet and never leaks the words in its error", async () => {
  let seen;
  let input;
  const words = "zoo ".repeat(23) + "wrong";
  await assert.rejects(
    makeKeys({
      words,
      l1RpcUrl: "http://eth:8545",
      runImpl: async (_cmd, args, _env, stdin) => {
        seen = args;
        input = stdin;
        throw Object.assign(new Error("exit 1"), { output: `Using mnemonic ${words}\nError: invalid mnemonic` });
      },
    }),
    (err) => err.status === 502 && /invalid mnemonic/.test(err.message) && !err.message.includes("zoo"),
  );
  assert.ok(seen.includes("--staker-output"));
  assert.equal(seen[seen.indexOf("--l1-chain-id") + 1], "1");
  assert.equal(seen[seen.indexOf("--gse-address") + 1], "0xa92ecFD0E70c9cd5E5cd76c50Af0F7Da93567a4f");
  assert.ok(seen.includes("--bls-key-derivation-v6"));
  // the words go on standard input, never on the command line (readable with ps)
  assert.equal(input, words);
  assert.ok(!seen.includes("--mnemonic"));
  assert.ok(!seen.some((a) => a.includes("zoo")));
  await assert.rejects(makeKeys({ words, l1RpcUrl: null }), /Ethereum node/);
});

test("the node waits for an Ethereum node, a beacon node and traces", async () => {
  let s = stubBox({ el: { installed: false }, cl: { installed: false } });
  await s.box.tick();
  assert.equal(s.box.status().node.state, "needEthereumAndBeacon");
  s = stubBox({ cl: { installed: false } });
  await s.box.tick();
  assert.equal(s.box.status().node.state, "needBeacon");
  s = stubBox({ el: { tracing: false } });
  await s.box.tick();
  assert.equal(s.box.status().node.state, "needTracing");
  s = stubBox({ el: { synced: false } });
  await s.box.tick();
  assert.equal(s.box.status().node.state, "waitingForEthereum");
});

test("launch settings: full node first, sequencer once keys exist", async () => {
  const { box } = stubBox();
  await box.refreshL1();
  let spec = box.launchSpec();
  assert.ok(!spec.run.args.includes("--sequencer"));
  assert.equal(spec.run.env.ETHEREUM_HOSTS, "http://avado-dnp-nethermind.my.ava.do:8545");
  assert.equal(spec.run.env.L1_CONSENSUS_HOST_URLS, "http://teku.my.ava.do:5051");
  assert.equal(spec.run.env.P2P_QUERY_FOR_IP, "true");
  assert.equal(spec.run.env.KEY_STORE_DIRECTORY, undefined);
  assert.ok(spec.run.args.includes("mainnet"));
  const first = spec.key;
  await box.createKeys({ coinbase: "" });
  spec = box.launchSpec();
  assert.ok(spec.run.args.includes("--sequencer"));
  assert.equal(spec.run.env.KEY_STORE_DIRECTORY, box.keys.keysDir);
  assert.notEqual(spec.key, first);
});

test("keys: made once, words returned once, keystore private, staking file outside the keys folder", async () => {
  const { box, dir } = stubBox();
  await box.refreshL1();
  const r = await box.createKeys({ coinbase: "" });
  assert.match(r.words, /^abandon/);
  assert.equal(r.attester, STAKER[0].attester);
  const ksPath = join(dir, "keys", "key1.json");
  assert.equal(statSync(ksPath).mode & 0o777, 0o600);
  assert.ok(existsSync(join(dir, "staker-output.json")));
  assert.ok(!readFileSync(ksPath, "utf8").includes("abandon"));
  assert.deepEqual(box.stakerOutput(), STAKER);
  const status = JSON.stringify(box.status());
  assert.ok(!status.includes(KEY.slice(2)) && !status.includes("abandon"));
  await assert.rejects(box.createKeys({}), /already set up/);
  await box.setCoinbase({ coinbase: "0x" + "cd".repeat(20) });
  assert.equal(JSON.parse(readFileSync(ksPath, "utf8")).validators[0].coinbase, "0x" + "cd".repeat(20));
  await box.removeKeys();
  assert.ok(!existsSync(ksPath));
  assert.equal(box.stakerOutput(), null);
});

test("restore passes the cleaned words; import keeps the keystore without a staking file", async () => {
  const { box, calls } = stubBox();
  await box.refreshL1();
  const words = Array(24).fill("abandon").join(" ");
  await box.restoreKeys({ words: `  ${words.toUpperCase()} ` });
  assert.equal(calls[0].words, words);
  assert.equal(calls[0].l1RpcUrl, "http://avado-dnp-nethermind.my.ava.do:8545");
  await box.removeKeys();
  await box.importKeystore({ keystore: KEYSTORE });
  assert.equal(box.keys.present, true);
  assert.equal(box.stakerOutput(), null);
  assert.equal(box.status().sequencer.stakerFile, false);
});

test("sequencer status is read from the rollup contract", async () => {
  const rpc = async (url, method, params) => {
    if (method === "node_getChainTips") return { proposed: { number: 42 }, proven: { block: { number: 40 } } };
    if (method === "node_isReady") return true;
    if (method === "node_getNodeInfo") return { nodeVersion: "6.0.0", l1ContractAddresses: { rollupAddress: "0xrollup" } };
    if (method === "eth_getBalance") return "0x2386f26fc10000"; // 0.01 ETH
    if (method === "eth_call") {
      assert.equal(params[0].to, "0xrollup");
      assert.ok(params[0].data.startsWith("0x30ccebb5"));
      return "0x" + "0".repeat(63) + "1";
    }
    if (method === "node_getValidatorStats") return { validator: { missedAttestations: { count: 1, total: 20, currentStreak: 0 } } };
    throw new Error(`unexpected ${method}`);
  };
  const { box } = stubBox({ rpc });
  await box.refreshL1();
  await box.createKeys({ coinbase: "" });
  box.proc.child = {}; // pretend the node runs
  await box.refreshNode();
  await box.refreshAttesters();
  const s = box.status();
  assert.equal(s.node.block, 42);
  assert.equal(s.node.version, "6.0.0");
  assert.equal(s.sequencer.state, "validating");
  assert.equal(s.sequencer.attesters[0].eth, 0.01);
  assert.equal(s.sequencer.attesters[0].missedAttestations.count, 1);
  box.proc.child = null;
});

test("the tracing button only applies to Geth", async () => {
  const { box } = stubBox();
  await box.refreshL1();
  await assert.rejects(box.enableTracing(), /only applies to Geth/);
});

test("custom addresses must be http(s)", async () => {
  const { box } = stubBox();
  await assert.rejects(box.setL1({ el: "custom", elCustom: "ws://x", cl: "auto", clCustom: "" }), /http/);
  await assert.rejects(box.setL1({ el: "nope", cl: "auto" }), /Unknown/);
  await box.setL1({ el: "custom", elCustom: "http://my-eth:8545", cl: "custom", clCustom: "https://beacon.example" });
  assert.equal(box.status().ethereum.using.id, "custom");
});

test("keys wait for an Ethereum node that answers and is up to date", async () => {
  let s = stubBox({ el: { installed: false } });
  await s.box.refreshL1();
  assert.equal(s.box.status().sequencer.canMakeKeys, false);
  await assert.rejects(s.box.createKeys({ coinbase: "" }), (e) => e.status === 409 && /once there is an Ethereum node/.test(e.message));
  s = stubBox({ el: { synced: false } });
  await s.box.refreshL1();
  assert.equal(s.box.status().sequencer.canMakeKeys, false);
  await assert.rejects(s.box.createKeys({ coinbase: "" }), (e) => e.status === 409 && /not up to date/.test(e.message));
  await assert.rejects(s.box.restoreKeys({ words: Array(24).fill("abandon").join(" ") }), /not up to date/);
  assert.equal(s.calls.length, 0);
  s = stubBox();
  await s.box.refreshL1();
  assert.equal(s.box.status().sequencer.canMakeKeys, true);
});

test("a failed key tool run gives a plain message, never the Node.js version or the words", () => {
  const words = "zoo ".repeat(23) + "wrong";
  const viem = "[18:56:46.325] ERROR: cli Error in command execution\n[18:56:46.327] ERROR: cli ContractFunctionExecutionError: HTTP request failed.\nRequest body: {\"method\":\"eth_call\"}\n    at readContract (x.js:1)\nNode.js v24.22.1";
  assert.match(keygenError(viem, words), /needs to read Ethereum through your Ethereum node/);
  const other = `[1] ERROR: cli Error in command execution\n[2] ERROR: cli Error: invalid fee recipient\n    at y (z.js:2)\n}\nNode.js v24.22.1`;
  assert.equal(keygenError(other, words), "The Aztec tool could not make the keys: Error: invalid fee recipient");
  assert.equal(keygenError("Node.js v24.22.1", words), "The Aztec tool could not make the keys.");
  assert.ok(!keygenError(`Using mnemonic ${words}`, words).includes("zoo"));
});

test("the tracing answer is kept for a few minutes, and forgotten on request", async () => {
  forgetTracing();
  let calls = 0;
  const missing = Object.assign(new Error("the method debug_traceTransaction does not exist/is not available"), { code: -32601 });
  const rpc = async () => { calls++; throw missing; };
  assert.equal(await probeTracingKept("http://geth", rpc, 1000), false);
  const n = calls;
  assert.equal(await probeTracingKept("http://geth", rpc, 1000 + 60000), false);
  assert.equal(calls, n);
  assert.equal(await probeTracingKept("http://geth", rpc, 1000 + 6 * 60000), false);
  assert.ok(calls > n);
  forgetTracing();
  const m = calls;
  await probeTracingKept("http://geth", rpc, 1000 + 6 * 60000);
  assert.ok(calls > m);
});

test("restart does not start the node while Ethereum is not ready", async () => {
  let started = 0;
  let s = stubBox({ el: { synced: false } });
  s.box.proc.restart = async () => { started++; };
  await s.box.refreshL1();
  assert.deepEqual(await s.box.restartNode(), { running: false });
  assert.equal(started, 0);
  s = stubBox();
  s.box.proc.restart = async () => { started++; };
  await s.box.refreshL1();
  assert.deepEqual(await s.box.restartNode(), { running: true });
  assert.equal(started, 1);
});
