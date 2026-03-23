#!/usr/bin/env bash
set -euo pipefail

ZERO_IMAGE="${ZERO_IMAGE:-ghcr.io/shipzero/zero:latest}"
INSTALL_DIR="/opt/zero"

log()  { echo -e "\033[1;34m[zero]\033[0m $1"; }
err()  { echo -e "\033[1;31m[zero]\033[0m $1" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root. Use: sudo bash install.sh"
fi

IS_UPGRADE=false
if [ -f "$INSTALL_DIR/.env" ]; then
  IS_UPGRADE=true
  log "Existing installation found — upgrading"
fi

SERVER_IP=$(curl -4 -s https://ifconfig.me || hostname -I | awk '{print $1}')

if [ "$IS_UPGRADE" = false ]; then
  read -rp "Domain for zero (leave empty to use IP $SERVER_IP): " DOMAIN < /dev/tty
  DOMAIN="${DOMAIN:-$SERVER_IP}"

  read -rp "Email for Let's Encrypt certificates (required for HTTPS on app domains): " EMAIL < /dev/tty
  if [ -z "$EMAIL" ]; then
    log "No email — HTTPS will not work for app domains. You can set it later in $INSTALL_DIR/.env"
  fi
else
  # Load existing config
  source "$INSTALL_DIR/.env"
  DOMAIN="${DOMAIN:-$SERVER_IP}"
  EMAIL="${EMAIL:-}"
fi

if command -v docker &>/dev/null; then
  log "Docker already installed: $(docker --version)"
else
  log "Installing Docker..."

  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  . /etc/os-release
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

  log "Docker installed: $(docker --version)"
fi

systemctl enable --now docker

mkdir -p "$INSTALL_DIR" /var/lib/zero/certs /var/lib/zero/compose

if [ "$IS_UPGRADE" = false ]; then
  TOKEN=$(openssl rand -hex 32)
  JWT_SECRET=$(openssl rand -hex 32)

  cat > "$INSTALL_DIR/.env" <<EOF
TOKEN=${TOKEN}
JWT_SECRET=${JWT_SECRET}
DOMAIN=${DOMAIN}
EMAIL=${EMAIL}
EOF
  chmod 600 "$INSTALL_DIR/.env"
else
  # Ensure JWT_SECRET exists for upgrades from older versions
  if ! grep -q '^JWT_SECRET=' "$INSTALL_DIR/.env"; then
    JWT_SECRET=$(openssl rand -hex 32)
    echo "JWT_SECRET=${JWT_SECRET}" >> "$INSTALL_DIR/.env"
    log "Generated JWT_SECRET for existing installation"
  fi
fi

# Compose file is always regenerated (picks up new volumes, settings etc.)
cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
services:
  zero:
    container_name: zero
    image: ${ZERO_IMAGE}
    restart: unless-stopped
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/zero:/opt/zero:ro
      - /var/lib/zero:/var/lib/zero
    env_file:
      - .env
    environment:
      - NODE_ENV=production
EOF

log "Pulling images..."
docker compose -f "$INSTALL_DIR/docker-compose.yml" pull
docker pull docker:cli -q

log "Starting zero..."
docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d

IS_IP_ONLY=false
if echo "$DOMAIN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  IS_IP_ONLY=true
fi

if [ -n "$EMAIL" ] && [ "$IS_IP_ONLY" = false ]; then
  API_URL="https://${DOMAIN}"
else
  API_URL="http://${DOMAIN}"
fi

echo ""
echo "┌──────────┐"
echo "│   zero   │"
echo "└──────────┘"
echo ""
log "Zero is running!"
log "API:    ${API_URL}"
log "CLI:    zero login $(whoami)@${DOMAIN}"
if [ -n "$EMAIL" ] && [ "$IS_IP_ONLY" = false ]; then
  log "TLS:    enabled (Let's Encrypt via ${EMAIL})"
elif [ "$IS_IP_ONLY" = true ]; then
  log "TLS:    disabled (Let's Encrypt requires a domain, not an IP)"
else
  log "TLS:    disabled (set EMAIL in ${INSTALL_DIR}/.env to enable)"
fi
if [ "$IS_IP_ONLY" = false ]; then
  echo ""
  log "DNS:"
  log "  A     ${DOMAIN}            ${SERVER_IP}  (required — makes zero reachable)"
  log "  A     *.${DOMAIN}          ${SERVER_IP}  (recommended — enables automatic app and preview subdomains)"
  echo ""
fi
log "Config: ${INSTALL_DIR}/.env"
log "Logs:   docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f"
