# The sandbox image (decision 0002 §1). Protected core (L-0001).
# Built only by src/images/images.ts, which passes the pins from images/images.toml.
ARG BASE_IMAGE
ARG TARGETARCH

# The omp binary for each architecture, refused by BuildKit unless its SHA-256 matches the pin.
FROM scratch AS omp-amd64
ARG OMP_VERSION
ARG OMP_SHA256_AMD64
ADD --checksum=sha256:${OMP_SHA256_AMD64} https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64 /omp

FROM scratch AS omp-arm64
ARG OMP_VERSION
ARG OMP_SHA256_ARM64
ADD --checksum=sha256:${OMP_SHA256_ARM64} https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-arm64 /omp

FROM omp-${TARGETARCH} AS omp

FROM ${BASE_IMAGE}
ARG DEBIAN_SNAPSHOT
ARG GIT_VERSION
USER root
# Every Debian package comes from snapshot.debian.org at the pinned time. The build fails
# if a source line names anywhere else, and again if apt fetched an index from anywhere
# else, which also catches sources configured outside the usual files.
RUN sed -i \
      -e "s#http://deb.debian.org/debian-security#https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#http://deb.debian.org/debian#https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources \
 && if cat /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null | grep -v '^[[:space:]]*#' \
      | grep -oE '[a-z+]+://[^[:space:]]+' | grep -v "^https://snapshot\.debian\.org/archive/[a-z-]*/${DEBIAN_SNAPSHOT}\$"; then \
      echo "apt source outside the pinned snapshot" >&2; exit 1; \
    fi \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && for list in /var/lib/apt/lists/*; do \
      case "${list##*/}" in \
        lock|partial|auxfiles|"snapshot.debian.org_archive_"*"_${DEBIAN_SNAPSHOT}_"*) ;; \
        *) echo "apt index from outside the pinned snapshot: ${list}" >&2; exit 1 ;; \
      esac; \
    done \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "git=${GIT_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

COPY --from=omp --chmod=0755 /omp /usr/local/bin/omp
# omp extracts a native addon from its own binary at startup and loads it with dlopen. At
# runtime HOME is on a noexec tmpfs, so the addon is extracted here instead, next to the
# binary, which is the next place omp looks for it.
RUN HOME=/tmp/omp-natives omp --help >/dev/null \
 && cp /tmp/omp-natives/.omp/natives/*/*/pi_natives.linux-*.node /usr/local/bin/ \
 && rm -rf /tmp/omp-natives

USER bun
WORKDIR /workspace
