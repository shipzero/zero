#!/usr/bin/env bash
set -euo pipefail

# ── zero CLI Installer ──────────────────────────────────────────────────────
# Usage: curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/cli/install.sh | bash

REPO="shipzero/zero"
INSTALL_DIR="${HOME}/.zero/bin"

log() { echo -e "\033[1;34m[zero]\033[0m $1"; }
err() { echo -e "\033[1;31m[zero]\033[0m $1" >&2; exit 1; }

case "$(uname -s)" in
  Linux*)  BINARY="zero-linux" ;;
  Darwin*) BINARY="zero-macos" ;;
  *)       err "unsupported OS: $(uname -s)" ;;
esac

LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d '"' -f 4)
if [ -z "$LATEST" ]; then
  err "could not determine latest release. check https://github.com/${REPO}/releases"
fi

log "installing zero ${LATEST} (${BINARY})..."

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
curl -fsSL "$DOWNLOAD_URL" -o /tmp/zero || err "download failed. does the release exist?"
chmod +x /tmp/zero

mkdir -p "$INSTALL_DIR"
mv /tmp/zero "$INSTALL_DIR/zero"

log "installed zero ${LATEST} to ${INSTALL_DIR}/zero"

# Add to PATH if not already there
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  SHELL_NAME=$(basename "$SHELL")
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    *)    RC_FILE="" ;;
  esac

  if [ -n "$RC_FILE" ]; then
    if ! grep -q '.zero/bin' "$RC_FILE" 2>/dev/null; then
      echo 'export PATH="$HOME/.zero/bin:$PATH"' >> "$RC_FILE"
      log "added ~/.zero/bin to PATH in ${RC_FILE}"
    fi
  fi

  echo ""
  echo "  run this to use zero in the current shell:"
  echo "    export PATH=\"\$HOME/.zero/bin:\$PATH\""
  echo ""
fi

echo "  get started:"
echo "    zero login http://<your-server> <token>"
echo "    zero ls"
echo ""
