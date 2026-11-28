# The gateway image (decision 0002 §2). Protected core (L-0001).
# Built only by src/images/images.ts, which passes the pinned base from images/images.toml
# and places src/gateway and src/util (without tests) in the build context. Distroless:
# no shell and no package manager, and nothing is installed.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY src/ /app/src/
# The root filesystem is read-only at runtime, so Bun must not try to cache transpiled code.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/bun", "/app/src/gateway/main.ts"]
