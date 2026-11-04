// Finds the Ethereum (L1) execution and beacon nodes on this AVADO. Package
// names, host names and ports are the ones the AVADO client packages use (same
// list as the Rocket Pool package's resolve_client_urls and the Starknet
// Validator package). A package that is not installed has no *.my.ava.do name,
// so a failed DNS lookup means "not installed".
import { lookup } from "node:dns/promises";

export const EXECUTION_CLIENTS = [
  { id: "geth", title: "Geth", packageName: "ethchain-geth.public.dappnode.eth", http: "http://ethchain-geth.my.ava.do:8545" },
  { id: "nethermind", title: "Nethermind", packageName: "avado-dnp-nethermind.public.dappnode.eth", http: "http://avado-dnp-nethermind.my.ava.do:8545" },
  { id: "reth", title: "Reth", http: "http://reth-mainnet.my.ava.do:8545" },
];

export const CONSENSUS_CLIENTS = [
  { id: "teku", title: "Teku", http: "http://teku.my.ava.do:5051" },
  { id: "nimbus", title: "Nimbus", http: "http://nimbus.my.ava.do:5052" },
  { id: "lighthouse", title: "Lighthouse", http: "http://lighthouse.my.ava.do:5052" },
  { id: "prysm", title: "Prysm", http: "http://prysm-beacon-chain-mainnet.my.ava.do:3500" },
];

const TIMEOUT_MS = 4000;
// A transaction hash that does not exist: enough to see whether a trace method is there at all.
const NO_TX = "0x" + "00".repeat(31) + "01";

async function resolves(url) {
  try {
    await lookup(new URL(url).hostname);
    return true;
  } catch {
    return false;
  }
}

export async function jsonRpc(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`answered with HTTP ${res.status}`);
  }
  if (body.error) {
    const e = new Error(body.error.message || "error");
    e.code = body.error.code;
    e.data = body.error.data;
    throw e;
  }
  return body.result;
}

/** True when an error means "this method is not offered" (as opposed to "no such transaction"). */
export function isMethodMissing(err) {
  if (!err) return false;
  if (err.code === -32601) return true;
  return /does not exist|not available|not found: method|method not found|unsupported method|not supported|not enabled|not allowed|not whitelisted|disabled/i.test(String(err.message || ""));
}

// The tracing check makes the Ethereum node log a warning each time (Geth logs
// every failed call), so its answer is kept for a few minutes per address.
const TRACING_RECHECK_MS = 5 * 60 * 1000;
const tracingSeen = new Map();

/** Forget the kept answers, e.g. right after the owner turned traces on. */
export function forgetTracing() {
  tracingSeen.clear();
}

/** probeTracing, asked again only every few minutes for the same address. */
export async function probeTracingKept(url, rpc = jsonRpc, now = Date.now()) {
  const seen = tracingSeen.get(url);
  if (seen && now - seen.at < TRACING_RECHECK_MS) return seen.value;
  const value = await probeTracing(url, rpc);
  tracingSeen.set(url, { value, at: now });
  return value;
}

/** Aztec needs debug_traceTransaction or trace_transaction on the L1 node. */
export async function probeTracing(url, rpc = jsonRpc) {
  for (const [method, params] of [
    ["debug_traceTransaction", [NO_TX, { tracer: "callTracer" }]],
    ["trace_transaction", [NO_TX]],
  ]) {
    try {
      await rpc(url, method, params, TIMEOUT_MS);
      return true;
    } catch (err) {
      if (!isMethodMissing(err) && err.code !== undefined) return true;
    }
  }
  return false;
}

/** State of one execution client: installed, answering, chain, syncing, tracing. */
export async function probeExecution(client, { rpc = jsonRpc, resolve = resolves } = {}) {
  const out = { id: client.id, title: client.title, installed: false, answering: false, mainnet: null, synced: null, tracing: null };
  if (!(await resolve(client.http))) return out;
  out.installed = true;
  try {
    const chainId = await rpc(client.http, "eth_chainId");
    out.answering = true;
    out.mainnet = chainId === "0x1";
    const syncing = await rpc(client.http, "eth_syncing");
    out.synced = syncing === false;
    if (syncing && typeof syncing === "object" && syncing.highestBlock) {
      const cur = parseInt(syncing.currentBlock, 16);
      const high = parseInt(syncing.highestBlock, 16);
      if (high > 0) out.progress = Math.min(1, cur / high);
    }
    out.tracing = await probeTracingKept(client.http, rpc);
  } catch {
    // installed but not answering (starting, stopped)
  }
  return out;
}

/** State of one beacon node. */
export async function probeConsensus(client, { fetchImpl = fetch, resolve = resolves } = {}) {
  const out = { id: client.id, title: client.title, installed: false, answering: false, synced: null };
  if (!(await resolve(client.http))) return out;
  out.installed = true;
  try {
    const res = await fetchImpl(`${client.http}/eth/v1/node/syncing`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return out;
    const body = await res.json();
    out.answering = true;
    out.synced = body?.data?.is_syncing === false;
  } catch {
    // not answering
  }
  return out;
}

/**
 * Picks a client: the one the owner chose, otherwise the first installed one that
 * is synced, otherwise the first answering one, otherwise the first installed one.
 */
export async function pick(list, probe, chosenId) {
  const states = await Promise.all(list.map((c) => probe(c)));
  const byId = (id) => list.find((c) => c.id === id);
  if (chosenId && chosenId !== "auto") {
    return { client: byId(chosenId) || null, states };
  }
  const installed = states.filter((s) => s.installed);
  const best = installed.find((s) => s.synced) || installed.find((s) => s.answering) || installed[0];
  return { client: best ? byId(best.id) : null, states };
}
