// AVADO Aztec Sequencer page. Reads /api/status every 5 seconds and shows it in plain words.
"use strict";

const $ = (id) => document.getElementById(id);
let last = null;
let showingWords = false;

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json", "x-avado-request": "1" },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The box answered ${res.status}`);
  return data;
}

function show(id, on) {
  $(id).hidden = !on;
}

function gb(bytes) {
  return bytes == null ? "…" : `${(bytes / 1e9).toFixed(bytes > 1e11 ? 0 : 1)} GB`;
}

function eth(n) {
  return n == null ? "…" : `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`;
}

const STATUS_TEXT = {
  notRegistered: "Not active yet (not staked, or waiting in the queue)",
  validating: "Active",
  zombie: "Stake below the minimum after a penalty: it no longer takes part",
  exiting: "Leaving: the stake is being taken out",
};

const PROBLEMS = {
  noTracing: "The Ethereum node does not offer transaction traces, which Aztec needs. See the card above.",
  lowEth: "The sequencer address is running out of ETH for fees. Send it about 0.01 ETH.",
  diskFull: "The disk is full. Free up space on your AVADO.",
  noHistoricalLogs: "The Ethereum node does not hand out the older Ethereum records Aztec reads. Use Nethermind or Geth on this AVADO, fully synced (a rented or public Ethereum address usually does not work).",
};

function l1Text(part, kind) {
  if (!part.using) return "None found";
  if (part.using.id === "custom") return part.custom || "Not set";
  const st = part.state;
  if (!st || !st.installed) return `${part.using.title} (not installed)`;
  if (!st.answering) return `${part.using.title} (not answering)`;
  if (kind === "el" && st.mainnet === false) return `${part.using.title} (not on Ethereum mainnet)`;
  if (st.synced === false) return `${part.using.title} (still syncing${st.progress ? `, ${Math.floor(st.progress * 100)}%` : ""})`;
  if (kind === "el" && st.tracing === false) return `${part.using.title} (traces are off)`;
  return part.using.title;
}

function nodeText(s) {
  const n = s.node;
  switch (n.state) {
    case "needEthereumAndBeacon":
    case "needEthereum":
    case "needBeacon": return "Waiting for an Ethereum node";
    case "needTracing": return "Waiting for traces on the Ethereum node";
    case "waitingForEthereum": return "Waiting until the Ethereum node is up to date";
    case "starting": return "Starting";
    case "syncing": return n.block != null ? `Catching up (block ${n.block.toLocaleString()})` : "Catching up";
    case "synced": return n.block != null ? `Up to date (block ${n.block.toLocaleString()})` : "Up to date";
    default: return n.state;
  }
}

function seqText(s) {
  const q = s.sequencer;
  if (q.state === "notSetUp") return "Not set up";
  if (q.state === "checking") return "Keys set up, checking Ethereum";
  return STATUS_TEXT[q.state] || q.state;
}

function verdict(s) {
  const n = s.node.state;
  const q = s.sequencer;
  const a = q.attesters[0];
  if (n === "needEthereumAndBeacon" || n === "needEthereum" || n === "needBeacon") return ["warning", "Install an Ethereum node first", "Your Aztec node needs the Ethereum node and the beacon node on this AVADO."];
  if (n === "needTracing") return ["warning", "One setting to change", "Aztec needs to read Ethereum transaction details. See below."];
  if (n === "waitingForEthereum") return ["unknown", "Waiting for your Ethereum node", "The Aztec node starts when the Ethereum node and the beacon node are up to date."];
  if (q.problem && PROBLEMS[q.problem]) return ["warning", "Your Aztec node needs attention", PROBLEMS[q.problem]];
  if (n !== "synced") return ["unknown", "Your Aztec node is catching up", "This can take a few hours. You can already set up your sequencer below."];
  if (q.state === "notSetUp") return ["ok", "Your Aztec node is up to date", "Set up your sequencer below."];
  if (a && a.eth !== null && a.eth < 0.002) return ["warning", "Send ETH to your sequencer", "Its address needs about 0.01 ETH to pay the Ethereum fees."];
  if (q.state === "validating") return ["ok", "Your sequencer is active", "It builds blocks and votes when its turn comes."];
  if (q.state === "zombie") return ["warning", "Your sequencer no longer takes part", STATUS_TEXT.zombie];
  if (q.state === "exiting") return ["unknown", "Your stake is being taken out", ""];
  return ["unknown", "Your sequencer is not active yet", "Stake on stake.aztec.network (step 3). After that it waits in a queue."];
}

function render(s) {
  last = s;
  $("version").textContent = s.packageVersion ? `version ${s.packageVersion}` : "";
  const [level, head, sub] = verdict(s);
  $("verdict").dataset.level = level;
  $("headline").textContent = head;
  $("subline").textContent = sub;

  $("f-node").textContent = nodeText(s);
  $("f-eth").textContent = l1Text(s.ethereum, "el");
  $("f-beacon").textContent = l1Text(s.beacon, "cl");
  $("f-seq").textContent = seqText(s);
  $("f-disk").textContent = s.disk ? `${gb(s.disk.free)} of ${gb(s.disk.total)}` : "…";
  $("aztec-version").textContent = s.node.version ? `Aztec ${s.node.version}.` : "";

  const n = s.node.state;
  const needL1 = n === "needEthereumAndBeacon" || n === "needEthereum" || n === "needBeacon";
  show("need-l1", needL1);
  if (needL1) {
    $("need-l1-title").textContent = n === "needBeacon" ? "Install a beacon node first" : "Install an Ethereum node first";
    $("need-l1-text").textContent =
      n === "needBeacon"
        ? "Install Teku, Nimbus, Lighthouse or Prysm from the AVADO store (if you stake ETH on this box, you already have one). The Aztec node starts by itself as soon as it finds it."
        : n === "needEthereum"
          ? "Install Nethermind or Geth from the AVADO store (if you stake ETH on this box, you already have one). The Aztec node starts by itself as soon as it finds it."
          : "Install an Ethereum node (Nethermind or Geth) and a beacon node (Teku, Nimbus, Lighthouse or Prysm) from the AVADO store. If you stake ETH on this box, you already have both.";
  }
  const st = s.ethereum.state;
  const tracingOff = !!(st && st.answering && st.tracing === false);
  show("need-tracing", tracingOff);
  if (tracingOff) {
    const isGeth = s.ethereum.using && s.ethereum.using.id === "geth";
    $("tracing-client").textContent = s.ethereum.using ? s.ethereum.using.title : "Your Ethereum node";
    show("tracing-geth", isGeth);
    show("tracing-other", !isGeth);
  }

  const q = s.sequencer;
  show("s-setup", !q.keys && !showingWords);
  show("s-running", q.keys && !showingWords);
  if (q.keys) {
    const a = q.attesters[0];
    $("s-addr").textContent = a ? a.address : "…";
    $("s-status").textContent = a && a.status ? STATUS_TEXT[a.status] : "Checked when the Aztec node is running";
    $("s-eth").textContent = a ? eth(a.eth) : "…";
    $("s-coinbase").textContent = a ? a.coinbase : "…";
    const m = a && a.missedAttestations;
    $("s-missed").textContent = m && m.total ? `${m.count} of ${m.total}` : "None counted yet";
    if (a) $("s-dashtec").href = `https://dashtec.xyz/validators/${a.address}`;
    show("s-download", q.stakerFile);
    const problem = q.problem && PROBLEMS[q.problem];
    show("s-problem", !!problem);
    if (problem) $("s-problem").textContent = problem;
  }

  for (const [kind, part] of [["el", s.ethereum], ["cl", s.beacon]]) {
    const choice = $(`${kind}-choice`);
    if (document.activeElement !== choice && !choice.dataset.touched) {
      choice.value = part.choice;
      $(`${kind}-custom`).value = part.custom || "";
      show(`${kind}-custom-field`, choice.value === "custom");
    }
  }
}

async function refresh() {
  try {
    render(await api("/api/status"));
    show("page-error", false);
  } catch (err) {
    $("page-error").textContent = `Cannot reach the box: ${err.message}`;
    show("page-error", true);
  }
}

function on(id, event, fn) {
  $(id).addEventListener(event, fn);
}

async function submit(button, msgId, work) {
  if (button) button.disabled = true;
  $(msgId).textContent = "Working…";
  try {
    const text = await work();
    $(msgId).textContent = text || "Done.";
    refresh();
  } catch (err) {
    $(msgId).textContent = err.message;
  } finally {
    if (button) button.disabled = false;
  }
}

function showWords(words) {
  showingWords = true;
  $("words").textContent = words;
  $("words-done").checked = false;
  $("words-close").disabled = true;
  show("words-card", true);
  if (last) render(last);
}

on("k-create", "submit", (e) => {
  e.preventDefault();
  submit($("k-create-btn"), "k-msg", async () => {
    const r = await api("/api/keys/create", { coinbase: $("k-coinbase").value.trim() });
    showWords(r.words);
    return "Keys made.";
  });
});

on("k-restore", "submit", (e) => {
  e.preventDefault();
  submit(null, "k-restore-msg", async () => {
    await api("/api/keys/restore", { words: $("k-words").value });
    $("k-words").value = "";
    return "Keys restored.";
  });
});

on("k-import", "submit", (e) => {
  e.preventDefault();
  submit(null, "k-import-msg", async () => {
    const file = $("k-file").files[0];
    if (!file) throw new Error("Choose the keystore file first.");
    if (file.size > 60000) throw new Error("That file is too large to be a keystore.");
    let keystore;
    try {
      keystore = JSON.parse(await file.text());
    } catch {
      throw new Error("That file is not a keystore.");
    }
    await api("/api/keys/import", { keystore });
    $("k-file").value = "";
    return "Keystore saved.";
  });
});

on("words-done", "change", () => {
  $("words-close").disabled = !$("words-done").checked;
});

on("words-close", "click", () => {
  $("words").textContent = "";
  show("words-card", false);
  showingWords = false;
  refresh();
});

on("s-download", "click", async () => {
  try {
    const data = await api("/api/staker-output");
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "aztec-staking-file.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    window.alert(err.message);
  }
});

on("s-coinbase-form", "submit", (e) => {
  e.preventDefault();
  submit(null, "s-coinbase-msg", async () => {
    await api("/api/keys/coinbase", { coinbase: $("s-coinbase-new").value.trim() });
    $("s-coinbase-new").value = "";
    return "Saved. The Aztec node restarts with the new address.";
  });
});

on("s-remove-form", "submit", (e) => {
  e.preventDefault();
  submit(null, "s-remove-msg", async () => {
    await api("/api/keys/remove", { confirm: $("s-remove-confirm").value.trim() });
    $("s-remove-confirm").value = "";
    return "Removed.";
  });
});

on("tracing-enable", "click", () => {
  if (!window.confirm("Geth restarts now and is back in about a minute. Continue?")) return;
  submit($("tracing-enable"), "tracing-msg", async () => {
    const r = await api("/api/ethereum/enable-tracing", {});
    return r.changed ? "Done. Geth is restarting; this card goes away when it is back." : "Geth already offers traces.";
  });
});

for (const kind of ["el", "cl"]) {
  on(`${kind}-choice`, "change", () => {
    $(`${kind}-choice`).dataset.touched = "1";
    show(`${kind}-custom-field`, $(`${kind}-choice`).value === "custom");
  });
}

on("eth-form", "submit", (e) => {
  e.preventDefault();
  submit(null, "eth-msg", async () => {
    await api("/api/ethereum", {
      el: $("el-choice").value,
      elCustom: $("el-custom").value.trim(),
      cl: $("cl-choice").value,
      clCustom: $("cl-custom").value.trim(),
    });
    delete $("el-choice").dataset.touched;
    delete $("cl-choice").dataset.touched;
    return "Saved.";
  });
});

on("node-restart", "click", () => {
  submit($("node-restart"), "eth-msg", async () => {
    await api("/api/node/restart", {});
    return "Restarted.";
  });
});

$("log-node").closest("details").addEventListener("toggle", async (e) => {
  if (!e.target.open) return;
  try {
    const { lines } = await api("/api/logs");
    $("log-node").textContent = lines.join("\n") || "Nothing yet.";
  } catch (err) {
    $("log-node").textContent = err.message;
  }
});

refresh();
setInterval(refresh, 5000);
