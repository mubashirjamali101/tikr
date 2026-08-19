#!/usr/bin/env bash
# Install tikr for macOS / Linux in one step.
#
#   curl -fsSL https://raw.githubusercontent.com/mubashirjamali101/tikr/main/install.sh | bash
#   ./install.sh
#
# Press Enter at the prompt to install, or Ctrl-C to cancel.
# Env: PREFIX, TIKR_REPO, TIKR_DOWNLOAD_BASE, TIKR_VERSION, YES=1
set -euo pipefail

REPO="${TIKR_REPO:-mubashirjamali101/tikr}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) plat="macos" ;;
  Linux)  plat="linux" ;;
  *) echo "Unsupported OS: $os (on Windows use install.ps1)"; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) a="arm64" ;;
  x86_64|amd64)  a="x64" ;;
  *) echo "Unsupported arch: $arch"; exit 1 ;;
esac
bin="tikr-${plat}-${a}"

choose_dir() {
  if [ -n "${PREFIX:-}" ]; then echo "$PREFIX"; return; fi
  if [ -w /usr/local/bin ] 2>/dev/null; then echo /usr/local/bin; return; fi
  if command -v sudo >/dev/null 2>&1 && [ -d /usr/local/bin ]; then echo /usr/local/bin; return; fi
  echo "$HOME/.local/bin"
}
dest_dir="$(choose_dir)"
dest="$dest_dir/tikr"

if [ -z "${YES:-}" ] && [ -t 0 ]; then
  echo "Install tikr → $dest"
  printf "Press Enter to continue (Ctrl-C to cancel)… "
  read -r _
elif [ -z "${YES:-}" ]; then
  echo "Install tikr → $dest"
fi

mkdir -p "$dest_dir" 2>/dev/null || true

# Replacing a running binary is SIGKILL'd on macOS; stop first so start can launch the new one.
if [ -x "$dest" ]; then
  "$dest" stop >/dev/null 2>&1 || true
fi

tmp=""
src=""
if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/release/$bin" ]; then
  src="$REPO_DIR/release/$bin"
elif [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/dist/$bin" ]; then
  # legacy path if someone still has an old local build
  src="$REPO_DIR/dist/$bin"
else
  base="${TIKR_DOWNLOAD_BASE:-}"
  if [ -z "$base" ]; then
    if [ -n "${TIKR_VERSION:-}" ]; then
      base="https://github.com/${REPO}/releases/download/${TIKR_VERSION}"
    else
      base="https://github.com/${REPO}/releases/latest/download"
    fi
  fi
  tmp="$(mktemp)"
  url="${base%/}/$bin"
  echo "Downloading $url …"
  curl -fsSL "$url" -o "$tmp"
  src="$tmp"
fi

install_cmd() { cp "$src" "$dest" && chmod +x "$dest"; }
if ! install_cmd 2>/dev/null; then
  echo "Need elevated permissions for $dest_dir — using sudo."
  sudo cp "$src" "$dest" && sudo chmod +x "$dest"
fi
[ -n "$tmp" ] && rm -f "$tmp"

echo "Installed: $dest"
case ":$PATH:" in
  *":$dest_dir:"*) ;;
  *) echo "NOTE: add to your shell profile:  export PATH=\"$dest_dir:\$PATH\"" ;;
esac

"$dest" --version 2>/dev/null || true

if [ -z "${TIKR_SKIP_START:-}" ]; then
  echo "Setting up installed tools…"
  if ! "$dest" start; then
    echo "NOTE: the binary is installed; run  tikr start  to finish setup."
  fi
else
  echo "Skipped start (TIKR_SKIP_START=1). Run:  tikr start"
fi
