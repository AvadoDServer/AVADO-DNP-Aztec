// Entry point of the Aztec Sequencer package: the page on port 80 and the
// Aztec node it looks after.
import { readFileSync } from "node:fs";
import { createPageServer, HttpError } from "./lib/http.mjs";
import { AztecBox } from "./aztec.mjs";

const DATA_DIR = process.env.STATE_DIR || "/data";
const PUBLIC_DIR = process.env.PUBLIC_DIR || new URL("../public", import.meta.url).pathname;
const PORT = Number(process.env.HTTP_PORT || 80);

let version = process.env.PACKAGE_VERSION || "";
try {
  version = version || readFileSync(new URL("../package-version", import.meta.url), "utf8").trim();
} catch {
  // not in the image
}

const log = (msg) => process.stdout.write(`[page] ${msg}\n`);
const box = new AztecBox({ dataDir: DATA_DIR, env: { ...process.env, PACKAGE_VERSION: version }, log });

/** Turns a thrown error with a status into an HttpError the page shows as is. */
const wrap = (fn) => async (body) => {
  try {
    return await fn(body);
  } catch (err) {
    if (err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
};

const str = (v) => String(v ?? "").trim();

const routes = {
  "GET /api/status": async () => box.status(),
  "GET /api/logs": async () => ({ lines: box.logs() }),
  "GET /api/staker-output": async () => {
    const out = box.stakerOutput();
    if (!out) throw new HttpError(404, "There is no staking file on this box. It is made when the box makes or restores the keys.");
    return out;
  },
  "POST /api/keys/create": wrap((b) => box.createKeys({ coinbase: str(b.coinbase) })),
  "POST /api/keys/restore": wrap((b) => box.restoreKeys({ words: str(b.words), coinbase: str(b.coinbase) })),
  "POST /api/keys/import": wrap((b) => box.importKeystore({ keystore: b.keystore })),
  "POST /api/keys/coinbase": wrap((b) => box.setCoinbase({ coinbase: str(b.coinbase) })),
  "POST /api/keys/remove": wrap(async (b) => {
    if (b.confirm !== "REMOVE") throw new HttpError(400, "Type REMOVE to confirm");
    return box.removeKeys();
  }),
  "POST /api/ethereum": wrap((b) => box.setL1({ el: str(b.el), elCustom: str(b.elCustom), cl: str(b.cl), clCustom: str(b.clCustom) })),
  "POST /api/node/restart": wrap(() => box.restartNode()),
};

const server = createPageServer({
  publicDir: PUBLIC_DIR,
  routes,
  allowedNames: ["aztec.my.ava.do", "aztec.avado.dnp.dappnode.eth", "my.aztec.avado.dnp.dappnode.eth", "dappnodepackage-aztec.avado.dnp.dappnode.eth"],
  log,
});
server.listen(PORT, "0.0.0.0", () => log(`page on port ${PORT}`));
box.begin();

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping the Aztec node`);
    server.close();
    await box.shutdown();
    process.exit(0);
  });
}
