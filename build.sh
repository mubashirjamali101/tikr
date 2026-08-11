#!/usr/bin/env bash
# Compile tikr for every supported platform into dist/.
#
#   ./build.sh            all platforms
#   ./build.sh macos      only targets matching "macos"
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

filter="${1:-}"

targets=(
  "bun-darwin-arm64:tikr-macos-arm64"
  "bun-darwin-x64:tikr-macos-x64"
  "bun-linux-x64:tikr-linux-x64"
  "bun-linux-arm64:tikr-linux-arm64"
  "bun-windows-x64:tikr-windows-x64.exe"
)

mkdir -p dist
if [ -z "$filter" ]; then
  echo "==> Cleaning dist/"
  rm -rf dist && mkdir -p dist
else
  echo "==> Rebuilding only targets matching '$filter'"
fi

for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  output="${entry##*:}"
  if [ -n "$filter" ] && [[ "$output" != *"$filter"* ]]; then
    continue
  fi
  echo "==> $output"
  bun build --compile --target="$target" src/cli.ts --outfile "dist/$output"
done

native="dist/tikr-macos-arm64"
case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) native="dist/tikr-macos-x64" ;;
  Linux-x86_64)  native="dist/tikr-linux-x64" ;;
  Linux-aarch64) native="dist/tikr-linux-arm64" ;;
esac
if [ -x "$native" ]; then
  echo "==> Smoke test: $native --version -> $("$native" --version 2>/dev/null)"
fi

echo "==> Removing bun compile caches"
rm -f .*.bun-build ./*.bun-build

echo "==> Checksums"
(
  cd dist
  files=$(ls | grep -v '^SHA256SUMS$')
  if command -v sha256sum >/dev/null; then sha256sum $files; else shasum -a 256 $files; fi
) > dist/SHA256SUMS

echo
echo "Built into dist/:"
ls -lh dist/
echo
echo "Install on this machine:  ./install.sh"
