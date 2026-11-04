// Calls DAPPMANAGER procedures over WAMP (router ws://wamp.my.ava.do:8080/ws,
// realm dappnode_admin, anonymous), one short session per action. A trimmed
// JavaScript port of the WAMP client in AVADO Care (CALL only).
//
// Used for one thing only: with the owner's click, add "debug" to Geth's
// --http.api list so Aztec can read the transaction traces it needs.

const HELLO = 1;
const WELCOME = 2;
const ABORT = 3;
const CHALLENGE = 4;
const GOODBYE = 6;
const ERROR = 8;
const CALL = 48;
const RESULT = 50;
const SUFFIX = ".dappmanager.dnp.dappnode.eth";

export const WAMP_URL = "ws://wamp.my.ava.do:8080/ws";
export const GETH_PACKAGE = "ethchain-geth.public.dappnode.eth";

/** Opens a session, runs fn(call), closes the session. */
export async function withDappmanager(fn, { url = WAMP_URL, WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  const ws = new WebSocketImpl(url, ["wamp.2.json"]);
  const pending = new Map();
  let nextId = 1;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the AVADO system did not answer")), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify([HELLO, "dappnode_admin", { roles: { caller: { features: {} } }, agent: "avado-aztec" }]));
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(timer);
      reject(new Error("the connection to the AVADO system closed"));
      for (const p of pending.values()) p.reject(new Error("the connection to the AVADO system closed"));
      pending.clear();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === WELCOME) {
        clearTimeout(timer);
        resolve();
      } else if (msg[0] === ABORT || msg[0] === CHALLENGE) {
        clearTimeout(timer);
        reject(new Error("the AVADO system refused the connection"));
      } else if (msg[0] === RESULT) {
        const p = pending.get(msg[1]);
        if (!p) return;
        pending.delete(msg[1]);
        const args = msg[3];
        p.resolve(Array.isArray(args) && args.length > 0 ? args[0] : msg[4]);
      } else if (msg[0] === ERROR && msg[1] === CALL) {
        const p = pending.get(msg[2]);
        if (!p) return;
        pending.delete(msg[2]);
        p.reject(new Error(`${p.method}: ${msg[4]}`));
      }
    };
  });

  const call = (method, kwargs = {}, callTimeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no answer in time`));
      }, callTimeoutMs);
      pending.set(id, {
        method,
        resolve: (raw) => {
          clearTimeout(timer);
          let env = raw;
          if (typeof raw === "string") {
            try {
              env = JSON.parse(raw);
            } catch {
              return reject(new Error(`${method}: the reply is not JSON`));
            }
          }
          if (!env || env.success !== true) return reject(new Error(`${method}: ${env && env.message ? env.message : "failed"}`));
          resolve(env.result);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify([CALL, id, {}, `${method}${SUFFIX}`, [], { ...kwargs, dontLogError: true }]));
    });

  try {
    await opened;
    return await fn(call);
  } finally {
    try {
      ws.send(JSON.stringify([GOODBYE, {}, "wamp.close.system_shutdown"]));
      ws.close(1000);
    } catch {
      // already closed
    }
  }
}

/**
 * Geth's EXTRA_OPTS with "debug" added to the --http.api list (or a list added).
 * Returns null when debug is already there. Older installs may still use --rpcapi
 * (the Geth package's start script turns it into --http.api).
 */
export function gethOptsWithDebug(extraOpts) {
  const opts = String(extraOpts ?? "");
  const re = /(--(?:http\.api|rpcapi)(?:=|\s+))("?)([A-Za-z0-9_,]+)\2/;
  const m = re.exec(opts);
  if (m) {
    const list = m[3].split(",").filter(Boolean);
    if (list.map((x) => x.toLowerCase()).includes("debug")) return null;
    return opts.replace(re, `${m[1]}${m[2]}${[...list, "debug"].join(",")}${m[2]}`);
  }
  // Geth's own default list when --http.api is not given is eth,net,web3
  return `${opts.trim()} --http.api eth,net,web3,txpool,debug`.trim();
}

/** Adds "debug" to Geth's RPC list and restarts Geth. Returns what was changed. */
export async function enableGethTracing(options = {}) {
  return withDappmanager(async (call) => {
    const list = await call("listPackages", {}, 90000);
    const geth = Array.isArray(list) ? list.find((p) => p && p.name === GETH_PACKAGE) : null;
    if (!geth) throw Object.assign(new Error("Geth is not installed on this AVADO"), { status: 400 });
    const before = (geth.envs && geth.envs.EXTRA_OPTS) || "";
    const after = gethOptsWithDebug(before);
    if (after === null) return { changed: false, before };
    await call("updatePackageEnv", { id: GETH_PACKAGE, envs: { EXTRA_OPTS: after }, restart: true }, 180000);
    return { changed: true, before, after };
  }, options);
}
