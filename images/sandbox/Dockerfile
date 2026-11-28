# The sandbox image (decision 0002 §1). Protected core (L-0001).
# Built only by src/sandbox/image.ts, which passes the pins from images/images.toml.
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
# Every Debian package comes from snapshot.debian.org at the pinned time; the build fails
# if any source still points at the live mirror.
RUN sed -i \
      -e "s#http://deb.debian.org/debian-security#https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#http://deb.debian.org/debian#https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources \
 && ! grep -rq 'deb.debian.org' /etc/apt/sources.list.d/ \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "git=${GIT_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

COPY --from=omp --chmod=0755 /omp /usr/local/bin/omp

USER bun
WORKDIR /workspace
