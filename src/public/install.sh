#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}  ╔═══════════════════════════════════════╗${RESET}"
echo -e "${CYAN}${BOLD}  ║       Installing Agora CLI...         ║${RESET}"
echo -e "${CYAN}${BOLD}  ╚═══════════════════════════════════════╝${RESET}"
echo ""

# ─── Detect OS / reject native Windows ────────────────────────────────────────
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo -e "${RED}Error: Native Windows is not supported.${RESET}"
    echo "Please use WSL (Windows Subsystem for Linux) or run:"
    echo "  npx github:eugene-the-owl-coder/agora-local-client init"
    exit 1
    ;;
  Darwin)
    echo -e "${CYAN}Detected: macOS${RESET}"
    ;;
  Linux)
    echo -e "${CYAN}Detected: Linux${RESET}"
    ;;
  *)
    echo -e "${YELLOW}Warning: Unrecognized OS '$(uname -s)'. Proceeding anyway...${RESET}"
    ;;
esac

# ─── Check for Node.js >= 18 ─────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}Error: Node.js is not installed.${RESET}"
  echo "Agora CLI requires Node.js 18 or later."
  echo "Install it from: https://nodejs.org/"
  exit 1
fi

NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"

if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${RED}Error: Node.js v${NODE_VERSION} is too old.${RESET}"
  echo "Agora CLI requires Node.js 18 or later."
  echo "Install it from: https://nodejs.org/"
  exit 1
fi

echo -e "  Node.js v${NODE_VERSION} ${GREEN}✓${RESET}"

# ─── Check for git ────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  echo -e "${RED}Error: git is not installed.${RESET}"
  echo "Install git from: https://git-scm.com/"
  exit 1
fi

echo -e "  git $(git --version | awk '{print $3}') ${GREEN}✓${RESET}"

# ─── Set install directories ─────────────────────────────────────────────────
AGORA_HOME="${HOME}/.agora"
INSTALL_DIR="${AGORA_HOME}/local-client"
REPO_URL="https://github.com/eugene-the-owl-coder/agora-local-client.git"

mkdir -p "$AGORA_HOME"

# ─── Clone or pull ────────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ""
  echo "Updating existing installation..."
  git -C "$INSTALL_DIR" pull
else
  echo ""
  echo "Cloning agora-local-client..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ─── Install dependencies & build ────────────────────────────────────────────
echo ""
echo "Installing dependencies and building..."
cd "$INSTALL_DIR" && npm install && npm run build

# ─── Make the binary executable ───────────────────────────────────────────────
chmod +x "$INSTALL_DIR/dist/index.js"

# ─── Symlink the binary ──────────────────────────────────────────────────────
BINARY_SOURCE="$INSTALL_DIR/dist/index.js"
SYMLINK_TARGET="/usr/local/bin/agora"

if ln -sf "$BINARY_SOURCE" "$SYMLINK_TARGET" 2>/dev/null; then
  echo -e "  Linked to ${SYMLINK_TARGET} ${GREEN}✓${RESET}"
else
  # Fall back to ~/.local/bin
  FALLBACK_DIR="${HOME}/.local/bin"
  mkdir -p "$FALLBACK_DIR"
  ln -sf "$BINARY_SOURCE" "${FALLBACK_DIR}/agora"
  echo -e "  Linked to ${FALLBACK_DIR}/agora ${GREEN}✓${RESET}"

  if [[ ":$PATH:" != *":${FALLBACK_DIR}:"* ]]; then
    echo ""
    echo -e "${YELLOW}Warning: ${FALLBACK_DIR} is not in your PATH.${RESET}"
    echo "Add it by appending this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
  fi
fi

# ─── Success ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔═══════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}  ║       Agora CLI installed!            ║${RESET}"
echo -e "${GREEN}${BOLD}  ╚═══════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Next step: Run ${BOLD}agora init${RESET} to set up your agent."
echo ""
