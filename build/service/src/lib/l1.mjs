// Finds the Ethereum (L1) execution and beacon nodes on this AVADO. Package
// names, host names and ports are the ones the AVADO client packages use (same
// list as the Rocket Pool package's resolve_client_urls and the Starknet
// Validator package). A package that is not installed has no *.my.ava.do name,
// so a failed DNS lookup means "not installed".
//
// Aztec reads Ethereum transaction traces (trace_transaction or
// debug_traceTransaction). On an AVADO only Nethermind offers them out of the
// box (its "Trace" RPC module is on by default), so Nethermind is the one
// execution client this package uses. Geth and Reth are only asked for
// their chain id, so the page can tell their owners that Aztec needs
// Nethermind.
import { lookup } from "node:dns/promises";

export const NETHERMIND = {
  id: "nethermind",
  title: "Nethermind",
  packageName: "avado-dnp-nethermind.public.dappnode.eth",
  http: "http://avado-dnp-nethermind.my.ava.do:8545",
};

/** Other execution clients an AVADO can run: only detected, to explain that Aztec needs Nethermind. */
export const OTHER_EXECUTION_CLIENTS = [
  { id: "geth", title: "Geth", http: "http://ethchain-geth.my.ava.do:8545" },
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
// A node whose newest block is older than this is not up to date, whatever eth_syncing says.
const STALE_HEAD_S = 10 * 60;

export async function resolves(url) {
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

// The answer of the tracing check is kept for a few minutes per address.
const TRACING_RECHECK_MS = 5 * 60 * 1000;
const tracingSeen = new Map();

/** Forget the kept answers. */
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

/**
 * Aztec needs trace_transaction or debug_traceTransaction on the L1 node.
 * Nethermind answers trace_transaction (null for an unknown transaction) and
 * refuses debug_* with "namespace 'Debug' is disabled", so trace_ is asked first.
 */
export async function probeTracing(url, rpc = jsonRpc) {
  for (const [method, params] of [
    ["trace_transaction", [NO_TX]],
    ["debug_traceTransaction", [NO_TX, { tracer: "callTracer" }]],
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

/** State of the execution node at `client.http`: installed, answering, chain, syncing, tracing. */
export async function probeExecution(client, { rpc = jsonRpc, resolve = resolves, now = () => Date.now() } = {}) {
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
    if (out.synced) {
      const head = await rpc(client.http, "eth_getBlockByNumber", ["latest", false]).catch(() => null);
      const ts = head && head.timestamp ? parseInt(head.timestamp, 16) : 0;
      if (!ts || now() / 1000 - ts > STALE_HEAD_S) out.synced = false;
    }
    out.tracing = await probeTracingKept(client.http, rpc);
  } catch {
    // installed but not answering (starting, stopped)
  }
  return out;
}

/**
 * The other execution clients that run on this AVADO. The box's name server can keep
 * the name of a removed package for a while, so a name alone is not enough: the node
 * must also answer eth_chainId (a plain call that no client logs a warning for).
 */
export async function otherExecutionClients({ resolve = resolves, rpc = jsonRpc } = {}) {
  const found = await Promise.all(
    OTHER_EXECUTION_CLIENTS.map(async (c) => {
      if (!(await resolve(c.http))) return null;
      try {
        await rpc(c.http, "eth_chainId", [], 3000);
        return { id: c.id, title: c.title };
      } catch {
        return null;
      }
    }),
  );
  return found.filter(Boolean);
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
 * Picks a beacon node: the one the owner chose, otherwise the first installed one
 * that is synced, otherwise the first answering one, otherwise the first installed one.
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
