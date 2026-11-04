// Sequencer keys: made on the box with the Aztec tool (from new or existing
// recovery words), or brought along as a keystore file. Only the keystore with
// the attester's Ethereum and BLS keys is kept (mode 600). Recovery words are
// shown to the owner once and never stored.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./lib/files.mjs";

// Mainnet contract the staking file is made for (docs.aztec.network, sequencer setup, 2026-11-04).
export const GSE_ADDRESS_MAINNET = "0xa92ecFD0E70c9cd5E5cd76c50Af0F7Da93567a4f";
export const AZTEC_CLI = "/usr/src/yarn-project/aztec/dest/bin/index.js";
const VIEM_ACCOUNTS = "/usr/src/yarn-project/node_modules/viem/_esm/accounts/index.js";
const ZERO_FEE_RECIPIENT = "0x" + "00".repeat(32);

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const HEX_BLS = /^0x[0-9a-fA-F]{1,64}$/;
export const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** 12 to 24 lower-case English words separated by single spaces. */
export function normaliseWords(text) {
  const words = String(text || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length) || !words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    throw fail("Enter the 12 or 24 recovery words, separated by spaces.");
  }
  return words.join(" ");
}

/**
 * Checks a keystore the owner brings. Accepts the plain file the Aztec tool
 * writes (schemaVersion 1, validators with an attester Ethereum key and BLS key).
 */
export function parseKeystore(text) {
  let ks;
  try {
    ks = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw fail("That file is not a keystore: it is not JSON.");
  }
  if (!ks || ks.schemaVersion !== 1 || !Array.isArray(ks.validators) || ks.validators.length === 0) {
    throw fail("That file is not an Aztec keystore. Choose the key1.json file the Aztec tool made (not the staker output file).");
  }
  if (ks.validators.length > 10) throw fail("This page handles up to 10 sequencers in one keystore.");
  for (const v of ks.validators) {
    const a = v && v.attester;
    if (!a || typeof a !== "object" || !HEX_KEY.test(String(a.eth || "")) || !HEX_BLS.test(String(a.bls || ""))) {
      throw fail("This keystore uses a format this page does not handle (password-protected or remote keys). Use a plain key1.json from the Aztec tool, or make new keys here.");
    }
    if (v.coinbase !== undefined && !ETH_ADDRESS.test(String(v.coinbase))) throw fail("The keystore has a reward address that is not an Ethereum address.");
  }
  return ks;
}

/** Sets the reward (coinbase) address of every sequencer in the keystore. */
export function withCoinbase(ks, coinbase) {
  if (!ETH_ADDRESS.test(String(coinbase || ""))) throw fail("Enter an Ethereum address: 0x followed by 40 characters.");
  return { ...ks, validators: ks.validators.map((v) => ({ ...v, coinbase })) };
}

export async function newWords() {
  const { generateMnemonic, english } = await import(VIEM_ACCOUNTS);
  return generateMnemonic(english, 256);
}

/** Ethereum address of a private key (the attester address). */
export async function addressOf(privateKey) {
  const { privateKeyToAccount } = await import(VIEM_ACCOUNTS);
  return privateKeyToAccount(privateKey).address;
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (b) => (out = (out + b.toString()).slice(-20000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(Object.assign(new Error(`exit ${code}`), { output: out }))));
  });
}

/**
 * Makes the keystore and the staking file with the Aztec tool, from the given
 * words. The words go to the tool as an argument of a short-lived process
 * inside this container only. Returns { keystore, stakerOutput }.
 */
export async function makeKeys({ words, l1RpcUrl, coinbase, runImpl = run, cli = AZTEC_CLI, env = process.env }) {
  if (!l1RpcUrl) throw fail("The Ethereum node is needed to make the keys. Wait until it is found and answers.", 409);
  const dir = mkdtempSync(join(tmpdir(), "aztec-keys-"));
  try {
    const args = [
      "--no-warnings", cli, "validator-keys", "new",
      "--fee-recipient", ZERO_FEE_RECIPIENT,
      "--staker-output",
      "--gse-address", GSE_ADDRESS_MAINNET,
      "--l1-rpc-urls", l1RpcUrl,
      "--l1-chain-id", "1",
      "--data-dir", dir,
      "--file", "key1.json",
      // keeps every BLS key under the L1 gas limit for its registration; the same flag regenerates the same keys
      "--bls-key-derivation-v6",
      "--mnemonic", words,
      ...(coinbase ? ["--coinbase", coinbase] : []),
    ];
    try {
      await runImpl(process.execPath, args, { ...env, HOME: dir });
    } catch (err) {
      const last = String(err.output || "").split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !l.includes(words.split(" ")[0] + " ")).pop();
      throw fail(`The Aztec tool could not make the keys${last ? `: ${last.slice(0, 300)}` : ""}`, 502);
    }
    const keystore = parseKeystore(readFileSync(join(dir, "key1.json"), "utf8"));
    const stakerPath = join(dir, "key1_staker_output.json");
    const stakerOutput = existsSync(stakerPath) ? JSON.parse(readFileSync(stakerPath, "utf8")) : null;
    return { keystore, stakerOutput };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class KeyStore {
  constructor(dataDir) {
    this.keysDir = join(dataDir, "keys");
    this.keystorePath = join(this.keysDir, "key1.json");
    // outside keysDir: the node reads every file in that folder as a keystore
    this.stakerPath = join(dataDir, "staker-output.json");
  }

  get present() {
    return existsSync(this.keystorePath);
  }

  read() {
    try {
      return parseKeystore(readFileSync(this.keystorePath, "utf8"));
    } catch {
      return null;
    }
  }

  readStakerOutput() {
    try {
      return JSON.parse(readFileSync(this.stakerPath, "utf8"));
    } catch {
      return null;
    }
  }

  save(keystore, stakerOutput) {
    writeFileAtomic(this.keystorePath, JSON.stringify(keystore, null, 2) + "\n", 0o600);
    if (stakerOutput) writeFileAtomic(this.stakerPath, JSON.stringify(stakerOutput, null, 2) + "\n", 0o644);
    else rmSync(this.stakerPath, { force: true });
  }

  remove() {
    rmSync(this.keystorePath, { force: true });
    rmSync(this.stakerPath, { force: true });
  }

  /** All private key strings in the keystore, so the log view can hide them. */
  secrets() {
    const ks = this.read();
    if (!ks) return [];
    return ks.validators.flatMap((v) => [v.attester.eth, v.attester.bls, ...(Array.isArray(v.publisher) ? v.publisher : [])]).filter((s) => typeof s === "string");
  }
}
