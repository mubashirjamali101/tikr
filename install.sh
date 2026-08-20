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
# Piped `curl | bash` has no real script path; do not treat cwd as the repo.
self=""
if [ -n "${BASH_SOURCE+x}" ] && [ -n "${BASH_SOURCE[0]:-}" ]; then
  self="${BASH_SOURCE[0]}"
elif [ -n "${0:-}" ] && [ "$0" != "bash" ] && [ "$0" != "sh" ]; then
  self="$0"
fi
REPO_DIR=""
if [ -n "$self" ] && [ -f "$self" ]; then
  REPO_DIR="$(cd "$(dirname "$self")" 2>/dev/null && pwd || echo "")"
fi

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

linux_libc() {
  # A glibc binary on musl (Alpine, Void) fails with "No such file or directory"
  # because the dynamic linker path is missing. Pick the musl build there.
  if [ -f /etc/alpine-release ]; then echo musl; return; fi
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then echo musl; return; fi
  if command -v ldd >/dev/null 2>&1 && ldd /bin/sh 2>&1 | grep -qi musl; then echo musl; return; fi
  echo gnu
}

bin="tikr-${plat}-${a}"
if [ "$plat" = linux ] && [ "$(linux_libc)" = musl ]; then
  bin="tikr-linux-${a}-musl"
fi

choose_dir() {
  if [ -n "${PREFIX:-}" ]; then echo "$PREFIX"; return; fi
  if [ -w /usr/local/bin ] 2>/dev/null; then echo /usr/local/bin; return; fi
  # sudo needs a TTY for a password. `curl | bash` has none, so do not pick a
  # root-owned directory we cannot actually write to.
  if [ -t 0 ] && command -v sudo >/dev/null 2>&1 && [ -d /usr/local/bin ]; then
    echo /usr/local/bin
    return
  fi
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
  if ! curl -fsSL "$url" -o "$tmp"; then
    echo "Failed to download $url" >&2
    echo "See https://github.com/${REPO}/releases for a $bin build." >&2
    exit 1
  fi
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

if ! "$dest" --version; then
  echo "The installed binary could not run ($dest)." >&2
  exit 1
fi

if [ -z "${TIKR_SKIP_START:-}" ]; then
  echo "Setting up installed tools…"
  if ! "$dest" start; then
    echo "NOTE: the binary is installed; run  tikr start  to finish setup."
  fi
else
  echo "Skipped start (TIKR_SKIP_START=1). Run:  tikr start"
fi
