# AVADO Aztec Sequencer package image.
#
# The Aztec node image (Aztec Labs, Apache-2.0) with a small Node.js service
# added that runs the plain-language page on port 80 and looks after the node.
#
# Build context is the repository root (docker-compose.yml: context ".",
# dockerfile "build/Dockerfile"), so the image can read the package version
# from dappnode_package.json. See /.dockerignore for what is sent.
#
# The upstream image is pinned by its multi-arch index digest; the tag is only
# a label. Update tag and digest together: `docker buildx imagetools inspect
# azteclabs/aztec:<version>` prints the "Digest:" line. Checked 2026-11-04
# against docs.aztec.network (mainnet sequencer guide: azteclabs/aztec:6.0.0).
ARG AZTEC_IMAGE=azteclabs/aztec:6.0.0@sha256:59b10cc8e89bb9226db1f771a5abbe5d5f8d71483c00c7472187e6ddc7adab8d

########## Tests: a failing test fails the image build (uses the image's own Node.js and viem)
FROM --platform=linux/amd64 ${AZTEC_IMAGE} AS test
WORKDIR /usr/src/avado
COPY build/service/ ./
RUN node --test test/*.test.mjs \
    && node --input-type=module -e ' \
        import { newWords, addressOf } from "/usr/src/avado/src/keys.mjs"; \
        const w = await newWords(); \
        if (w.split(" ").length !== 24) throw new Error("words"); \
        const a = await addressOf("0x" + "11".repeat(32)); \
        if (a !== "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A") throw new Error("address " + a);' \
    && test -f /usr/src/yarn-project/aztec/dest/bin/index.js \
    && touch /tested

########## Runtime
FROM --platform=linux/amd64 ${AZTEC_IMAGE}
COPY --from=test /tested /tmp/tested
COPY build/service/src /usr/src/avado/src
COPY build/service/public /usr/src/avado/public
COPY build/service/package.json /usr/src/avado/package.json
COPY build/NOTICE /usr/src/avado/NOTICE

# Package version, read from the manifest so a version bump can never leave it stale.
COPY dappnode_package.json /tmp/dappnode_package.json
RUN node -e 'const v = require("/tmp/dappnode_package.json").version; \
        if (!/^[0-9A-Za-z.+-]+$/.test(v || "")) { console.error("bad package version"); process.exit(1); } \
        require("fs").writeFileSync("/usr/src/avado/package-version", v + "\n");' \
    && rm /tmp/dappnode_package.json /tmp/tested \
    && mkdir -p /data

ENV STATE_DIR=/data \
    HTTP_PORT=80
WORKDIR /usr/src/avado
# 80: the page; 8080: the Aztec node's RPC (AVADO network only); 40400: peer-to-peer (TCP and UDP)
EXPOSE 80 8080 40400 40400/udp
ENTRYPOINT []
CMD ["node", "src/server.mjs"]
