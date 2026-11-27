#!/bin/sh
# Installs the pinned Betterleaks release after checking its SHA-256 (L-0028, L-0038).
# Protected core (L-0001): changing the version or the checksums needs an approver.
#
# Usage: scripts/install-betterleaks.sh [install-dir]    (default: ~/.local/bin)
set -eu

VERSION=1.10.1
DEST=${1:-"$HOME/.local/bin"}

case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) ASSET=darwin_arm64 SHA=ca91eb3b006f15478411f235b5e2712fb15cea74f6701ebadc2364efe0af1403 ;;
	Darwin-x86_64) ASSET=darwin_x64 SHA=1ae2e3885d161918d8ad2e911e205e73f0d9ffba52c85b38126586c52d355ef4 ;;
	Linux-x86_64) ASSET=linux_x64 SHA=c174b42d7aa60caf58c0c3e555c0e4bed01fe6b0d99a412bce777b5af4ce913e ;;
	Linux-aarch64 | Linux-arm64) ASSET=linux_arm64 SHA=62a63199f9f61a6b5e5a6f58f048493db20fbc8c770014f4d903a4d97886e1bf ;;
	*)
		echo "install-betterleaks: unsupported platform $(uname -s)-$(uname -m)" >&2
		exit 1
		;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/betterleaks.tar.gz" \
	"https://github.com/betterleaks/betterleaks/releases/download/v${VERSION}/betterleaks_${VERSION}_${ASSET}.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
	echo "$SHA  $TMP/betterleaks.tar.gz" | sha256sum -c - >/dev/null
else
	echo "$SHA  $TMP/betterleaks.tar.gz" | shasum -a 256 -c - >/dev/null
fi

tar -xzf "$TMP/betterleaks.tar.gz" -C "$TMP" betterleaks
mkdir -p "$DEST"
install -m 0755 "$TMP/betterleaks" "$DEST/betterleaks"
echo "betterleaks $("$DEST/betterleaks" version) installed to $DEST"
