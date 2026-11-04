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
  noTracing: "The Ethereum node does not show the transaction details (“traces”) Aztec reads. Nethermind on this AVADO shows them unless its settings were changed.",
  lowEth: "The sequencer address is running out of ETH for fees. Send it about 0.01 ETH.",
  diskFull: "The disk is full. Free up space on your AVADO.",
  noHistoricalLogs: "The Ethereum node does not hand out the older Ethereum records Aztec reads. Use Nethermind on this AVADO, fully synced (a rented or public Ethereum address usually does not work).",
};

// Sync time of a new Nethermind, said plainly wherever the page has to wait for it.
const NETHERMIND_WAIT = "A new Nethermind usually needs about a day to catch up, longer on a slow internet connection.";

function pct(st) {
  return st && st.progress ? `, ${Math.floor(st.progress * 100)}% done` : "";
}

function l1Text(part, kind) {
  if (!part.using) return kind === "el" ? "Nethermind not installed" : "None found";
  if (part.using.id === "custom") return part.custom || "Not set";
  const st = part.state;
  if (!st || !st.installed) return `${part.using.title} (not installed)`;
  if (!st.answering) return `${part.using.title} (not answering)`;
  if (kind === "el" && st.mainnet === false) return `${part.using.title} (not on Ethereum mainnet)`;
  if (st.synced === false) return `${part.using.title} (catching up${pct(st)})`;
  if (kind === "el" && st.tracing === false) return `${part.using.title} (no transaction details)`;
  return `${part.using.title} (up to date)`;
}

function nodeText(s) {
  const n = s.node;
  switch (n.state) {
    case "needEthereumAndBeacon":
    case "needEthereum": return "Waiting for Nethermind";
    case "needBeacon": return "Waiting for a beacon node";
    case "needTracing": return "Waiting for transaction details from Ethereum";
    case "waitingForEthereum": {
      const e = s.ethereum.state;
      return e && !(e.answering && e.synced) ? "Waiting for Nethermind" : "Waiting for the beacon node";
    }
    case "starting": return "Starting";
    case "syncing": return n.block != null ? `Catching up (block ${n.block.toLocaleString()})` : "Catching up";
    case "synced": return n.block != null ? `Up to date (block ${n.block.toLocaleString()})` : "Up to date";
    default: return n.state;
  }
}

/** True while the Aztec node cannot run because a node is missing or not ready yet. */
function nodeBlocked(s) {
  return /^need|^waiting/.test(s.node.state);
}

function seqText(s) {
  const q = s.sequencer;
  if (q.state === "notSetUp") return "Not set up";
  if (q.state === "checking") {
    if (/^needEthereum/.test(s.node.state)) return "Keys ready, waiting for Nethermind";
    if (nodeBlocked(s)) return "Keys ready, waiting for the Aztec node to start";
    return "Keys ready, reading its status from Ethereum…";
  }
  return STATUS_TEXT[q.state] || q.state;
}

/** Which part keeps the Aztec node waiting: the Ethereum node or the beacon node. */
function waitingText(s) {
  const e = s.ethereum.state;
  const c = s.beacon.state;
  const custom = s.ethereum.using && s.ethereum.using.id === "custom";
  if (!custom && e && !e.answering) {
    return ["warning", "Nethermind does not answer", "It may be starting or stopped: check it in the Admin. If you removed it, install it again from the AVADO store.", "", ["act-nethermind-page", "act-nethermind"]];
  }
  if (!custom && e && e.mainnet === false) {
    return ["warning", "Nethermind is not on Ethereum mainnet", "Aztec runs on Ethereum mainnet. Set Nethermind back to mainnet in the Admin.", "", ["act-nethermind-page"]];
  }
  if (e && e.synced === false) {
    const done = e.progress ? ` (${Math.floor(e.progress * 100)}%)` : "";
    return ["unknown", `${s.ethereum.using.title} is catching up with Ethereum${done}`, `${custom ? "" : NETHERMIND_WAIT + " "}The Aztec node then starts by itself.`, "", []];
  }
  if (c && !c.answering) {
    return ["warning", `${s.beacon.using.title} is not answering`, "Your beacon node may be starting or stopped. Check it in the Admin.", "", []];
  }
  if (c && c.synced === false) {
    return ["unknown", "Your beacon node is catching up", "The Aztec node starts by itself when it is up to date.", "", []];
  }
  return ["unknown", "Waiting for your Ethereum node", "The Aztec node starts when the Ethereum node and the beacon node are up to date.", "", []];
}

function otherTitles(s) {
  const o = (s.ethereum.others || []).map((x) => x.title);
  return o.length ? o.join(" and ") : null;
}

const GETH_NOTE = "Nethermind runs next to your current Ethereum node and needs about 1 TB of disk space. Your staking keeps using the node it uses now: moving it to Nethermind is a separate step, and Aztec does not need it.";

/** [level, headline, subline, note, [action ids]] */
function verdict(s) {
  const n = s.node.state;
  const q = s.sequencer;
  const a = q.attesters[0];
  const other = otherTitles(s);
  if (n === "needEthereumAndBeacon") {
    return other
      ? ["warning", "Aztec needs Nethermind and a beacon node", `Your AVADO runs ${other}, but Aztec only works with Nethermind: it shows Aztec the Ethereum transaction details it reads. Aztec also needs a beacon node. Install both from the AVADO store.`, GETH_NOTE, ["act-nethermind", "act-beacon"]]
      : ["warning", "Install Nethermind and a beacon node", "Aztec reads Ethereum through Nethermind and a beacon node (Teku, Nimbus, Lighthouse or Prysm) on this AVADO. Install both from the AVADO store.", `${NETHERMIND_WAIT} The Aztec node then starts by itself.`, ["act-nethermind", "act-beacon"]];
  }
  if (n === "needEthereum") {
    return other
      ? ["warning", "Aztec needs Nethermind", `Your AVADO runs ${other}, but Aztec only works with Nethermind: it shows Aztec the Ethereum transaction details it reads. Install Nethermind from the AVADO store.`, GETH_NOTE, ["act-nethermind"]]
      : ["warning", "Install Nethermind", "Aztec reads Ethereum through Nethermind, the Ethereum node on this AVADO that shows the transaction details Aztec needs. Install it from the AVADO store.", `${NETHERMIND_WAIT} The Aztec node then starts by itself.`, ["act-nethermind"]];
  }
  if (n === "needBeacon") return ["warning", "Install a beacon node", "Aztec also needs a beacon node (Teku, Nimbus, Lighthouse or Prysm) on this AVADO. If you stake ETH on this box, it already has one.", "", ["act-beacon"]];
  if (n === "needTracing") {
    return s.ethereum.using && s.ethereum.using.id === "custom"
      ? ["warning", "That Ethereum node does not show transaction details", "Aztec reads Ethereum transaction details (“traces”). The Ethereum node entered under More options does not offer them. Use Nethermind on this AVADO instead.", "", []]
      : ["warning", "Nethermind does not show transaction details", "Aztec reads Ethereum transaction details (“traces”). Nethermind on this AVADO shows them unless its settings were changed: undo that change in the Admin.", "", ["act-nethermind-page"]];
  }
  if (n === "waitingForEthereum") return waitingText(s);
  if (q.problem && PROBLEMS[q.problem]) return ["warning", "Your Aztec node needs attention", PROBLEMS[q.problem], "", []];
  if (n !== "synced") return ["unknown", "Your Aztec node is catching up", q.keys ? "This can take a few hours. Your sequencer takes part once it is up to date." : "This can take a few hours. You can already set up your sequencer below.", "", []];
  if (q.state === "notSetUp") return ["ok", "Your Aztec node is up to date", "Set up your sequencer below.", "", []];
  if (a && a.eth !== null && a.eth < 0.002) return ["warning", "Send ETH to your sequencer", "Its address needs about 0.01 ETH to pay the Ethereum fees. See “Your sequencer” below.", "", []];
  if (q.state === "validating") return ["ok", "Your sequencer is active", "It builds blocks and votes when its turn comes.", "", []];
  if (q.state === "zombie") return ["warning", "Your sequencer no longer takes part", STATUS_TEXT.zombie, "", []];
  if (q.state === "exiting") return ["unknown", "Your stake is being taken out", "", "", []];
  return ["unknown", "Your sequencer is not active yet", "Stake on stake.aztec.network (step 3). After that it waits in a queue.", "", []];
}

const ACTIONS = ["act-nethermind", "act-beacon", "act-nethermind-page"];

function render(s) {
  last = s;
  $("version").textContent = s.packageVersion ? `version ${s.packageVersion}` : "";
  const [level, head, sub, note, actions] = verdict(s);
  $("verdict").dataset.level = level;
  $("headline").textContent = head;
  $("subline").textContent = sub;
  $("verdict-note").textContent = note;
  show("verdict-note", !!note);
  for (const id of ACTIONS) show(id, actions.includes(id));
  show("verdict-actions", actions.length > 0);

  $("f-node").textContent = nodeText(s);
  $("f-eth").textContent = l1Text(s.ethereum, "el");
  $("f-beacon").textContent = l1Text(s.beacon, "cl");
  $("f-seq").textContent = seqText(s);
  $("f-disk").textContent = s.disk ? `${gb(s.disk.free)} of ${gb(s.disk.total)}` : "…";
  $("aztec-version").textContent = s.node.version ? `Aztec ${s.node.version}.` : "";

  const n = s.node.state;
  // one path at a time: the setup steps appear once Nethermind and a beacon node are installed
  const nodeMissing = n === "needEthereumAndBeacon" || n === "needEthereum" || n === "needBeacon";
  const q = s.sequencer;
  show("s-setup", !q.keys && !showingWords && !nodeMissing);
  // the key tool reads Ethereum through the box's Ethereum node: no button that cannot work yet
  const canMake = q.canMakeKeys !== false;
  $("k-create-btn").disabled = !canMake || $("k-msg").textContent === "Working…";
  $("k-restore-btn").disabled = !canMake;
  show("k-wait", !canMake);
  const e = s.ethereum.state;
  $("k-wait").textContent = !e || !e.installed
    ? "You can make the keys once Nethermind is installed and up to date."
    : !e.answering
      ? "You can make the keys once Nethermind answers again."
      : "Making the keys needs Nethermind to be up to date: usually about a day after it is installed.";
  // while the keys cannot be made yet, the page only says what it waits for; the steps follow when the button works
  show("k-steps", canMake);
  show("s-running", q.keys && !showingWords);
  if (q.keys) {
    const a = q.attesters[0];
    $("s-addr").textContent = a ? a.address : "…";
    $("s-status").textContent = a && a.status ? STATUS_TEXT[a.status] : nodeBlocked(s) ? "Shown once the Aztec node runs" : "Reading it from Ethereum…";
    $("s-eth").textContent = a && a.eth != null ? eth(a.eth) : nodeBlocked(s) && !(e && e.synced) ? "Shown once Nethermind is up to date" : "…";
    show("s-eth-nudge", !!(a && a.address && (a.eth == null || a.eth < 0.002)));
    $("s-coinbase").textContent = a ? a.coinbase : "…";
    const m = a && a.missedAttestations;
    $("s-missed").textContent = m && m.total ? `${m.count} of ${m.total}` : "None counted yet";
    if (a) $("s-dashtec").href = `https://dashtec.xyz/validators/${a.address}`;
    show("s-download", q.stakerFile);
    const problem = q.problem && PROBLEMS[q.problem];
    show("s-problem", !!problem);
    if (problem) $("s-problem").textContent = problem;
  }

  const custom = $("el-use-custom");
  if (document.activeElement !== custom && !custom.dataset.touched) {
    custom.checked = s.ethereum.choice === "custom";
    $("el-custom").value = s.ethereum.custom || "";
    show("el-custom-field", custom.checked);
  }
  const choice = $("cl-choice");
  if (document.activeElement !== choice && !choice.dataset.touched) {
    choice.value = s.beacon.choice;
    $("cl-custom").value = s.beacon.custom || "";
    show("cl-custom-field", choice.value === "custom");
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

on("el-use-custom", "change", () => {
  $("el-use-custom").dataset.touched = "1";
  show("el-custom-field", $("el-use-custom").checked);
});

on("cl-choice", "change", () => {
  $("cl-choice").dataset.touched = "1";
  show("cl-custom-field", $("cl-choice").value === "custom");
});

on("eth-form", "submit", (e) => {
  e.preventDefault();
  submit(null, "eth-msg", async () => {
    await api("/api/ethereum", {
      el: $("el-use-custom").checked ? "custom" : "auto",
      elCustom: $("el-custom").value.trim(),
      cl: $("cl-choice").value,
      clCustom: $("cl-custom").value.trim(),
    });
    delete $("el-use-custom").dataset.touched;
    delete $("cl-choice").dataset.touched;
    return "Saved.";
  });
});

on("node-restart", "click", () => {
  submit($("node-restart"), "eth-msg", async () => {
    const r = await api("/api/node/restart", {});
    return r.running === false ? "Not started: the Aztec node starts by itself when the Ethereum node and the beacon node are ready." : "Restarted.";
  });
});

$("log-node").closest("details").addEventListener("toggle", async (e) => {
  if (!e.target.open) return;
  try {
    const { lines } = await api("/api/logs");
    $("log-node").textContent = lines.join("\n") || (last && nodeBlocked(last)
      ? "The Aztec node has not started yet. It starts by itself when the Ethereum node and the beacon node are ready."
      : "Nothing yet.");
  } catch (err) {
    $("log-node").textContent = err.message;
  }
});

refresh();
setInterval(refresh, 5000);
