#!/usr/bin/env bash
# CI helper: install the official circom 2.2.3 Linux binary at ~/.local/bin/circom (where
# circuits/build.sh and circuits/scripts/restore-build.sh look for it), verified by sha256.
set -euo pipefail

version=2.2.3
sha256=85342c7ff332d948df7c0c50ecf201e6129349aef550ce873f3c811b79fe53a3
bin="$HOME/.local/bin/circom"

mkdir -p "$(dirname "$bin")"
curl -fsSL -o "$bin" "https://github.com/iden3/circom/releases/download/v$version/circom-linux-amd64"
echo "$sha256  $bin" | sha256sum -c -
chmod +x "$bin"
"$bin" --version | grep -q "circom compiler $version"
