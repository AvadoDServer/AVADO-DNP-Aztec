// Runs the Aztec node in this container (as a full node, or as a sequencer
// once keys are set up), points it at the Ethereum execution and beacon nodes
// on this AVADO, and works out the plain-language status the page shows.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Supervised } from "./lib/proc.mjs";
import { CONSENSUS_CLIENTS, NETHERMIND, jsonRpc, otherExecutionClients, pick, probeConsensus, probeExecution } from "./lib/l1.mjs";
import { diskSpace, readJsonFile, writeJsonFile } from "./lib/files.mjs";
import { AZTEC_CLI, ETH_ADDRESS, KeyStore, addressOf, makeKeys, newWords, normaliseWords, parseKeystore, withCoinbase } from "./keys.mjs";

export const AZTEC_PORT = 8080;
export const P2P_PORT = 40400;
const NODE_RPC = `http://127.0.0.1:${AZTEC_PORT}`;
// keccak("getStatus(address)")[0:4] on the Aztec rollup contract
const SELECTOR_GET_STATUS = "0x30ccebb5";
export const ATTESTER_STATUS = ["notRegistered", "validating", "zombie", "exiting"];
// Free blob archive used when the beacon node does not keep every blob (Dappnode's Aztec package does the same).
const BLOB_ARCHIVE = "https://api.blobscan.com";
// el: "auto" = Nethermind on this AVADO, "custom" = an address the owner entered (advanced)
const DEFAULT_SETTINGS = { el: "auto", elCustom: "", cl: "auto", clCustom: "" };
const HTTP_URL = /^https?:\/\/[^\s,]+$/;

/** Space separated extra options from the package settings, without any shell parsing. */
export function splitOptions(value) {
  return String(value || "").split(/\s+/).filter(Boolean);
}

/** Turns an Aztec log line into a known problem, or null. */
export function explainLine(line) {
  const l = line.toLowerCase();
  if (l.includes("trace_transaction") && l.includes("debug_tracetransaction") && (l.includes("refus") || l.includes("support"))) return "noTracing";
  if (l.includes("insufficient funds") || (l.includes("balance") && l.includes("publisher") && l.includes("low"))) return "lowEth";
  if (l.includes("no space left on device")) return "diskFull";
  if (l.includes("does not return historical logs")) return "noHistoricalLogs";
  return null;
}

export class AztecBox {
  constructor({ dataDir, env = process.env, log = console.log, rpc = jsonRpc, probeEl = probeExecution, probeCl = probeConsensus, findOtherEl = otherExecutionClients, keyTools = {} }) {
    this.dataDir = dataDir;
    this.nodeDir = join(dataDir, "node");
    this.settingsPath = join(dataDir, "settings.json");
    this.env = env;
    this.log = log;
    this.rpc = rpc;
    this.probeEl = probeEl;
    this.probeCl = probeCl;
    this.findOtherEl = findOtherEl;
    this.keyTools = { makeKeys, newWords, addressOf, ...keyTools };
    this.keys = new KeyStore(dataDir);
    mkdirSync(dataDir, { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...readJsonFile(this.settingsPath, {}) };
    // settings saved by a test build that still offered Geth and Reth: Aztec uses Nethermind now
    if (this.settings.el !== "custom") this.settings.el = "auto";
    this.el = { client: null, url: null, state: null, others: [] };
    this.cl = { client: null, url: null, state: null, states: [] };
    this.node = { answering: false, ready: false, block: null, proven: null, version: null, rollup: null };
    this.attesters = [];
    this.problem = null;
    this.startedWith = null;
    this.timer = null;
    this.ticking = false;

    this.proc = new Supervised({
      name: "aztec",
      stopTimeoutMs: 90000,
      secrets: () => this.keys.secrets(),
      onLine: (line) => {
        const p = explainLine(line);
        if (p) this.problem = { problem: p, line, at: Date.now() };
      },
      build: () => {
        const spec = this.launchSpec();
        if (!spec) return null;
        this.startedWith = spec.key;
        return spec.run;
      },
    });
  }

  /** What the node should run with now, or null when it cannot start yet. */
  launchSpec() {
    if (!this.el.url || !this.cl.url) return null;
    const sequencer = this.keys.present;
    const args = ["--no-warnings", AZTEC_CLI, "start", "--network", "mainnet", "--node", ...(sequencer ? ["--sequencer"] : []), ...splitOptions(this.env.EXTRA_OPTS)];
    const env = {
      ...this.env,
      LOG_LEVEL: this.env.LOG_LEVEL || "info",
      DATA_DIRECTORY: this.nodeDir,
      ETHEREUM_HOSTS: this.el.url,
      L1_CONSENSUS_HOST_URLS: this.cl.url,
      BLOB_ARCHIVE_API_URL: this.env.BLOB_ARCHIVE_API_URL || BLOB_ARCHIVE,
      AZTEC_PORT: String(AZTEC_PORT),
      P2P_PORT: String(P2P_PORT),
      // the node finds the box's public address itself (P2P_IP can still be set in the package settings)
      P2P_QUERY_FOR_IP: this.env.P2P_IP ? "false" : "true",
      HOME: this.dataDir,
    };
    if (sequencer) env.KEY_STORE_DIRECTORY = this.keys.keysDir;
    else delete env.KEY_STORE_DIRECTORY;
    return {
      key: JSON.stringify([this.el.url, this.cl.url, sequencer, this.keysVersion || 0]),
      run: { cmd: process.execPath, args, env },
    };
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    writeJsonFile(this.settingsPath, this.settings);
  }

  async refreshL1() {
    const s = this.settings;
    if (s.el === "custom") {
      this.el = { client: { id: "custom", title: "Your own Ethereum node" }, url: s.elCustom || null, state: null, others: [] };
    } else {
      const state = await this.probeEl(NETHERMIND);
      const others = state.installed ? [] : await this.findOtherEl();
      this.el = { client: { id: NETHERMIND.id, title: NETHERMIND.title }, url: state.installed ? NETHERMIND.http : null, state, others };
    }
    if (s.cl === "custom") {
      this.cl = { client: { id: "custom", title: "Your own beacon node" }, url: s.clCustom || null, state: null, states: [] };
    } else {
      const { client, states } = await pick(CONSENSUS_CLIENTS, (c) => this.probeCl(c), s.cl);
      const state = client ? states.find((x) => x.id === client.id) : null;
      this.cl = { client: client ? { id: client.id, title: client.title } : null, url: state && state.installed ? client.http : null, state, states };
    }
  }

  /** The node waits for a synced Ethereum node that offers traces, and a synced beacon node. */
  l1Ready() {
    if (!this.el.url || !this.cl.url) return false;
    const e = this.el.state;
    const c = this.cl.state;
    if (e && (!e.answering || e.synced === false || e.tracing === false || e.mainnet === false)) return false;
    if (c && (!c.answering || c.synced === false)) return false;
    return true;
  }

  async refreshNode() {
    if (!this.proc.running) {
      this.node = { ...this.node, answering: false, ready: false };
      return;
    }
    try {
      const tips = await this.rpc(NODE_RPC, "node_getChainTips", [], 5000);
      this.node.answering = true;
      this.node.block = tips && tips.proposed ? Number(tips.proposed.number) : null;
      this.node.proven = tips && tips.proven && tips.proven.block ? Number(tips.proven.block.number) : null;
      this.node.ready = (await this.rpc(NODE_RPC, "node_isReady", [], 5000).catch(() => false)) === true;
      // a problem seen in the log is over once the node is up and ready
      if (this.node.ready) this.problem = null;
      if (!this.node.version || !this.node.rollup) {
        const info = await this.rpc(NODE_RPC, "node_getNodeInfo", [], 5000).catch(() => null);
        if (info) {
          this.node.version = info.nodeVersion || null;
          this.node.rollup = info.l1ContractAddresses ? info.l1ContractAddresses.rollupAddress : null;
        }
      }
    } catch {
      this.node.answering = false;
      this.node.ready = false;
    }
  }

  /** Per sequencer: address, ETH for fees, status on Ethereum, recent performance. Read only. */
  async refreshAttesters() {
    const ks = this.keys.read();
    if (!ks) {
      this.attesters = [];
      return;
    }
    const out = [];
    for (const v of ks.validators) {
      const a = { address: null, coinbase: v.coinbase || null, eth: null, status: null, missedAttestations: null, lastAttestation: null };
      try {
        a.address = await this.keyTools.addressOf(v.attester.eth);
      } catch {
        continue;
      }
      if (!a.coinbase) a.coinbase = a.address;
      if (this.el.url) {
        try {
          a.eth = Number(BigInt(await this.rpc(this.el.url, "eth_getBalance", [a.address, "latest"], 5000))) / 1e18;
        } catch {
          // unknown
        }
        if (this.node.rollup) {
          try {
            const data = SELECTOR_GET_STATUS + a.address.slice(2).toLowerCase().padStart(64, "0");
            const r = await this.rpc(this.el.url, "eth_call", [{ to: this.node.rollup, data }, "latest"], 5000);
            a.status = ATTESTER_STATUS[Number(BigInt(r))] || null;
          } catch {
            // unknown
          }
        }
      }
      if (this.node.answering) {
        try {
          const s = await this.rpc(NODE_RPC, "node_getValidatorStats", [a.address], 5000);
          if (s && s.validator) {
            a.missedAttestations = s.validator.missedAttestations || null;
            a.lastAttestation = s.validator.lastAttestation ? s.validator.lastAttestation.date : null;
          }
        } catch {
          // not known yet
        }
      }
      out.push(a);
    }
    this.attesters = out;
  }

  /** One round of "what should be running now". Called every 20 seconds and after every change. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.refreshL1();
      const spec = this.launchSpec();
      if (this.proc.running && spec && spec.key !== this.startedWith) {
        this.log("settings changed, restarting the Aztec node");
        await this.proc.restart();
      } else if (!this.proc.running && !this.proc.timer && spec && this.l1Ready()) {
        mkdirSync(this.nodeDir, { recursive: true });
        this.proc.start();
      } else if (this.proc.running && !spec) {
        await this.proc.stop();
      }
      await this.refreshNode();
      if (!this.lastAttesterCheck || Date.now() - this.lastAttesterCheck > 60000) {
        this.lastAttesterCheck = Date.now();
        await this.refreshAttesters();
      }
    } catch (err) {
      this.log(`check failed: ${err.message}`);
    } finally {
      this.ticking = false;
    }
  }

  begin() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 20000);
  }

  async shutdown() {
    clearInterval(this.timer);
    await this.proc.stop();
  }

  // ---- actions from the page ----

  keysChanged() {
    this.keysVersion = (this.keysVersion || 0) + 1;
    this.problem = null;
    this.lastAttesterCheck = 0;
    this.tick();
  }

  /**
   * The key tool reads one value from Ethereum, so keys can be made only when the
   * Ethereum node answers and is up to date (a node of your own: assumed ready).
   */
  canMakeKeys() {
    if (!this.el.url) return false;
    const e = this.el.state;
    return !e || (e.answering && e.synced !== false && e.mainnet !== false);
  }

  needEthereumForKeys() {
    if (this.canMakeKeys()) return;
    throw Object.assign(new Error(this.el.url
      ? "Your Ethereum node is not up to date yet. You can make the keys as soon as it is (see “Ethereum node” at the top of this page)."
      : "The keys can be made once Nethermind is installed on this AVADO and up to date."), { status: 409 });
  }

  /** New keys from new words. Returns the words once; they are not kept. */
  async createKeys({ coinbase }) {
    if (this.keys.present) throw Object.assign(new Error("Sequencer keys are already set up. Remove them first."), { status: 409 });
    this.needEthereumForKeys();
    if (coinbase && !ETH_ADDRESS.test(coinbase)) throw Object.assign(new Error("The reward address must be an Ethereum address: 0x followed by 40 characters."), { status: 400 });
    const words = await this.keyTools.newWords();
    const { keystore, stakerOutput } = await this.keyTools.makeKeys({ words, l1RpcUrl: this.el.url, coinbase: coinbase || undefined });
    this.keys.save(keystore, stakerOutput);
    this.keysChanged();
    return { words, attester: stakerOutput && stakerOutput[0] ? stakerOutput[0].attester : null };
  }

  /** The same keys again from the owner's recovery words (made with this package or the Aztec tool with the same settings). */
  async restoreKeys({ words, coinbase }) {
    if (this.keys.present) throw Object.assign(new Error("Sequencer keys are already set up. Remove them first."), { status: 409 });
    if (coinbase && !ETH_ADDRESS.test(coinbase)) throw Object.assign(new Error("The reward address must be an Ethereum address: 0x followed by 40 characters."), { status: 400 });
    const clean = normaliseWords(words);
    this.needEthereumForKeys();
    const { keystore, stakerOutput } = await this.keyTools.makeKeys({ words: clean, l1RpcUrl: this.el.url, coinbase: coinbase || undefined });
    this.keys.save(keystore, stakerOutput);
    this.keysChanged();
    return { attester: stakerOutput && stakerOutput[0] ? stakerOutput[0].attester : null };
  }

  async importKeystore({ keystore }) {
    if (this.keys.present) throw Object.assign(new Error("Sequencer keys are already set up. Remove them first."), { status: 409 });
    const ks = parseKeystore(keystore);
    this.keys.save(ks, null);
    this.keysChanged();
  }

  async setCoinbase({ coinbase }) {
    const ks = this.keys.read();
    if (!ks) throw Object.assign(new Error("Set up the sequencer keys first."), { status: 409 });
    this.keys.save(withCoinbase(ks, coinbase), this.keys.readStakerOutput());
    this.keysChanged();
  }

  async removeKeys() {
    this.keys.remove();
    this.attesters = [];
    this.keysChanged();
  }

  stakerOutput() {
    return this.keys.readStakerOutput();
  }

  async setL1({ el, elCustom, cl, clCustom }) {
    const elAllowed = ["auto", "custom"];
    const clAllowed = ["auto", "custom", ...CONSENSUS_CLIENTS.map((c) => c.id)];
    if (!elAllowed.includes(el) || !clAllowed.includes(cl)) throw Object.assign(new Error("Unknown choice"), { status: 400 });
    if (el === "custom" && !HTTP_URL.test(elCustom || "")) throw Object.assign(new Error("Enter the Ethereum node address, starting with http:// or https://"), { status: 400 });
    if (cl === "custom" && !HTTP_URL.test(clCustom || "")) throw Object.assign(new Error("Enter the beacon node address, starting with http:// or https://"), { status: 400 });
    this.saveSettings({ el, elCustom: el === "custom" ? elCustom : "", cl, clCustom: cl === "custom" ? clCustom : "" });
    await this.tick();
  }

  /** Restarts the node; when it cannot run yet (no Ethereum or beacon node ready) it stays stopped. */
  async restartNode() {
    this.problem = null;
    if (!this.launchSpec() || !this.l1Ready()) {
      await this.proc.stop();
      return { running: false };
    }
    await this.proc.restart();
    return { running: true };
  }

  status() {
    const e = this.el.state;
    const c = this.cl.state;
    let node;
    if (!this.el.url && !this.cl.url) node = "needEthereumAndBeacon";
    else if (!this.el.url) node = "needEthereum";
    else if (!this.cl.url) node = "needBeacon";
    else if (!this.proc.running && e && e.tracing === false) node = "needTracing";
    else if (!this.proc.running && !this.l1Ready()) node = "waitingForEthereum";
    else if (!this.proc.running) node = "starting";
    else if (!this.node.answering) node = "starting";
    else if (this.node.ready) node = "synced";
    else node = "syncing";

    let sequencer;
    const a = this.attesters[0];
    if (!this.keys.present) sequencer = "notSetUp";
    else if (!a || a.status === null) sequencer = "checking";
    else sequencer = a.status;

    return {
      packageVersion: this.env.PACKAGE_VERSION || null,
      node: { state: node, block: this.node.block, proven: this.node.proven, version: this.node.version, restarts: this.proc.restarts },
      ethereum: { choice: this.settings.el, custom: this.settings.elCustom, using: this.el.client, state: e, others: this.el.others },
      beacon: { choice: this.settings.cl, custom: this.settings.clCustom, using: this.cl.client, state: c, clients: this.cl.states },
      sequencer: {
        state: sequencer,
        keys: this.keys.present,
        canMakeKeys: this.canMakeKeys(),
        stakerFile: !!this.keys.readStakerOutput(),
        attesters: this.attesters,
        problem: this.problem ? this.problem.problem : null,
      },
      disk: diskSpace(this.dataDir),
    };
  }

  logs() {
    return this.proc.tail(300);
  }
}
