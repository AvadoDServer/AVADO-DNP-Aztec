# AVADO Aztec Sequencer

`aztec.avado.dnp.dappnode.eth`: an Aztec mainnet node and, once the owner sets it up, an Aztec
sequencer, with a plain-language page at http://aztec.my.ava.do.

## What it does

- Runs the official Aztec node (`azteclabs/aztec:6.0.0`, the version the mainnet sequencer guide on
  docs.aztec.network names on 2026-11-04) with `aztec start --network mainnet --node`, and with
  `--sequencer` added once keys exist. The node downloads Aztec's own snapshot on first start (small,
  minutes) and then follows Ethereum.
- Uses the **Ethereum node and beacon node on the same AVADO** (Geth, Nethermind or Reth; Teku,
  Nimbus, Lighthouse or Prysm), found automatically over the AVADO network, or addresses the owner
  enters (advanced). It starts only when both are synced. Blobs the beacon node does not keep come
  from the free Blobscan API.
- **Traces**: Aztec needs `debug_traceTransaction` or `trace_transaction` on the Ethereum node.
  Nethermind offers `trace_*` by default. AVADO's Geth package runs with
  `--http.api eth,net,web3,txpool`, so the page detects this and offers one button that adds `debug`
  to Geth's `EXTRA_OPTS` through the DAPPMANAGER (`updatePackageEnv`, restarts Geth, about a minute).
- **Keys**: one click makes a 24-word recovery phrase on the box (viem, BIP-39, 256 bits) and runs
  `aztec validator-keys new` for mainnet (GSE `0xa92ecFD0E70c9cd5E5cd76c50Af0F7Da93567a4f`,
  `--l1-chain-id 1`, `--bls-key-derivation-v6`, optional reward address as coinbase). The words are
  shown once and never stored. The keystore (attester Ethereum key + BLS key) is kept in the package
  volume, mode 600; the public staking file is kept next to it (outside the keystore folder, which
  the node reads in full) and can be downloaded for stake.aztec.network. Owners who already have
  keys can type their words or upload a plain `key1.json`. The stake and the withdrawal right stay
  with the owner's own wallet on the staking website; the box never sees that wallet.
- Shows: node state and block, Ethereum and beacon node state (including "traces are off"),
  sequencer address, its ETH balance for L1 fees, its status read from the rollup contract
  (`getStatus`: not registered / active / below minimum / exiting), recently missed votes from the
  node's own validator stats, the reward address (changeable), free disk space, and the node log with
  keys, recovery phrases and the one-time admin API key hidden.

## Network and ports

Host ports: 40400 TCP and UDP (Aztec peer-to-peer; the page tells owners to forward it in their
router for better connectivity, it also works without). The node finds the public IP itself
(`P2P_QUERY_FOR_IP`). On the AVADO network only: 80 (page), 8080 (Aztec node RPC), 8880 (admin API,
protected by the key the node generates; never shown). The page API has the same guards as the
other AVADO pages (Host allow-list, same-origin check and custom header on every change).

## Requirements

- A synced Ethereum node and beacon node on the same AVADO (the node also needs the Ethereum node to
  return the rollup contract's historical logs, which a full local node does and free public
  endpoints do not).
- Aztec's guide asks for 8 cores, 8 GB RAM and a 1 TB SSD (shared with the Ethereum node).
- Docker 20.10.10 or newer on the host (Ubuntu 24.04 base image).

## Build and test

`docker-compose.yml` builds `build/Dockerfile` from the repository root. The image build runs the
unit tests and a check that the image's viem and Aztec tool are where the service expects them.

    docker buildx build --platform linux/amd64 --load -f build/Dockerfile -t aztec-test .

The Aztec node needs a real x86-64 CPU: under QEMU emulation (Apple Silicon) its world-state process
stops with SIGILL, so run tests of the node itself on an AVADO.

## Licence and credits

GPL-3.0 (see LICENSE). The Aztec node image is Apache-2.0, by Aztec Labs, used unmodified (see
build/NOTICE). Dappnode's `DAppNodePackage-aztec-generic` (Apache-2.0) was read as a reference for
the node's settings (endpoints, ports, Blobscan fallback, keystore folder); no code was copied. Page
styles come from the AVADO Admin, Care, AI Connect and Starknet Validator pages.
