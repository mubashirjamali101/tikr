#!/usr/bin/env bash
# Compile tikr for every supported platform into release/ (not dist/ — dist/ is the npm JS build).
#
#   ./build.sh            all platforms
#   ./build.sh macos      only targets matching "macos"
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

filter="${1:-}"
OUT=release

targets=(
  "bun-darwin-arm64:tikr-macos-arm64"
  "bun-darwin-x64:tikr-macos-x64"
  "bun-linux-x64:tikr-linux-x64"
  "bun-linux-arm64:tikr-linux-arm64"
  "bun-windows-x64:tikr-windows-x64.exe"
)

mkdir -p "$OUT"
if [ -z "$filter" ]; then
  echo "==> Cleaning $OUT/"
  rm -rf "$OUT" && mkdir -p "$OUT"
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
  bun build --compile --target="$target" src/cli.ts --outfile "$OUT/$output"
done

native="$OUT/tikr-macos-arm64"
case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) native="$OUT/tikr-macos-x64" ;;
  Linux-x86_64)  native="$OUT/tikr-linux-x64" ;;
  Linux-aarch64) native="$OUT/tikr-linux-arm64" ;;
esac
if [ -x "$native" ]; then
  echo "==> Smoke test: $native --version -> $("$native" --version 2>/dev/null)"
fi

echo "==> Removing bun compile caches"
rm -f .*.bun-build ./*.bun-build

echo "==> Checksums"
(
  cd "$OUT"
  files=$(ls | grep -v '^SHA256SUMS$')
  if command -v sha256sum >/dev/null; then sha256sum $files; else shasum -a 256 $files; fi
) > "$OUT/SHA256SUMS"

echo
echo "Built into $OUT/:"
ls -lh "$OUT/"
echo
echo "Install on this machine:  ./install.sh"
