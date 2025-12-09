#!/bin/bash

# Script: Update thermal printer bridge
# Tujuan: Pull update terbaru dari repository dan restart service
# Usage: ./update-thermal-bridge.sh [auto|manual]

set -e

BRIDGE_DIR="${HOME}/thermal-printer-bridge"
BRIDGE_SERVICE="thermal-bridge"
UPDATE_MODE="${1:-manual}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if bridge directory exists
if [ ! -d "$BRIDGE_DIR" ]; then
    log_error "Bridge directory not found: $BRIDGE_DIR"
    exit 1
fi

if [ ! -d "$BRIDGE_DIR/.git" ]; then
    log_error "Not a git repository: $BRIDGE_DIR"
    exit 1
fi

cd "$BRIDGE_DIR"

log_info "Checking for updates in $BRIDGE_DIR..."

# Fetch latest from remote
log_info "Fetching latest changes..."
git fetch origin

# Check if there are updates available
UPSTREAM="${1:-origin/main}"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    log_info "✓ Bridge is already up to date."
    exit 0
fi

log_info "Updates available. Current: $LOCAL, Remote: $REMOTE"

# Pull latest changes
log_info "Pulling latest changes from repository..."
git pull origin main

# Install/update dependencies
if [ -f "package.json" ]; then
    log_info "Installing/updating npm dependencies..."
    npm install --production
fi

# Restart the service if it's running via PM2 or systemd
if command -v pm2 &> /dev/null; then
    if pm2 list | grep -q "$BRIDGE_SERVICE"; then
        log_info "Restarting PM2 service: $BRIDGE_SERVICE"
        pm2 restart "$BRIDGE_SERVICE"
    fi
elif systemctl is-active --quiet "$BRIDGE_SERVICE" 2>/dev/null; then
    log_info "Restarting systemd service: $BRIDGE_SERVICE"
    sudo systemctl restart "$BRIDGE_SERVICE"
else
    log_warn "Service is not running. Please start it manually:"
    log_warn "  PM2: pm2 start server.js --name '$BRIDGE_SERVICE'"
    log_warn "  Systemd: sudo systemctl start $BRIDGE_SERVICE"
fi

log_info "✓ Bridge update completed successfully!"
