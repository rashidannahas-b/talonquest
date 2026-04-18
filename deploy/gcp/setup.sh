#!/usr/bin/env bash
# TalonQuest one-shot setup for a fresh Debian 12 / Ubuntu 22.04 GCE VM.
#
# Usage (on the VM, as a user with sudo):
#   curl -fsSL https://raw.githubusercontent.com/<you>/talonquest/<branch>/deploy/gcp/setup.sh | \
#     sudo DOMAIN=example.com REPO=https://github.com/<you>/talonquest.git BRANCH=main bash
#
# Required env vars:
#   DOMAIN  – public DNS name pointing at this VM's external IP
#   REPO    – https URL of the git repo to clone
# Optional:
#   BRANCH  – branch to check out (default: main)
#   PORT    – app port (default: 8000)
#
# What it does:
#   - installs Node 20 and Caddy from the official repos
#   - creates a `talonquest` system user
#   - clones the repo under /opt/talonquest and runs `npm ci --omit=dev`
#   - installs systemd + Caddy units so the game restarts on boot
#   - Caddy terminates TLS for $DOMAIN and proxies to 127.0.0.1:$PORT
#
# The setup is intentionally boring: one VM, one process, flat cost.

set -euo pipefail

: "${DOMAIN:?Set DOMAIN=your.host.name}"
: "${REPO:?Set REPO=https://github.com/you/talonquest.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-8000}"

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

echo "==> Installing Node.js 20 (NodeSource)"
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Creating talonquest system user"
if ! id talonquest &>/dev/null; then
  useradd --system --create-home --home-dir /opt/talonquest --shell /usr/sbin/nologin talonquest
fi

echo "==> Cloning / updating repo"
if [[ ! -d /opt/talonquest/.git ]]; then
  sudo -u talonquest git clone --depth 1 --branch "$BRANCH" "$REPO" /opt/talonquest
else
  sudo -u talonquest git -C /opt/talonquest fetch --depth 1 origin "$BRANCH"
  sudo -u talonquest git -C /opt/talonquest checkout "$BRANCH"
  sudo -u talonquest git -C /opt/talonquest reset --hard "origin/$BRANCH"
fi

echo "==> Installing node_modules"
sudo -u talonquest bash -c "cd /opt/talonquest && npm ci --omit=dev"

echo "==> Writing systemd unit"
install -m 0644 /opt/talonquest/deploy/gcp/talonquest.service /etc/systemd/system/talonquest.service
# Rewrite PORT in the unit to match the requested port.
sed -i "s|Environment=PORT=.*|Environment=PORT=${PORT}|" /etc/systemd/system/talonquest.service

echo "==> Writing Caddyfile"
install -m 0644 /opt/talonquest/deploy/gcp/Caddyfile /etc/caddy/Caddyfile
sed -i "s|__DOMAIN__|${DOMAIN}|g; s|__PORT__|${PORT}|g" /etc/caddy/Caddyfile

echo "==> Configuring firewall (ufw)"
ufw allow OpenSSH || true
ufw allow 80/tcp  || true
ufw allow 443/tcp || true
yes | ufw enable || true

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now talonquest.service
systemctl restart caddy

echo
echo "Done. Game should be reachable at https://${DOMAIN}/ within ~30s (TLS issuance)."
echo "Check logs: journalctl -u talonquest -f   /   journalctl -u caddy -f"
