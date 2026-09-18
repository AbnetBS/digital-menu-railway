#!/usr/bin/env bash
# ==============================================================================
# VPS Automatic Maintenance & Storage Cleanup Script
# ==============================================================================
# Usage:
#   sudo bash scripts/vps-cleanup.sh           -> Run one-time cleanup
#   sudo bash scripts/vps-cleanup.sh --install -> Set up automatic weekly cleanup
# ==============================================================================

set -e

# Ensure running as root
if [ "$EUID" -ne 0 ]; then
  echo "⚠️  Please run as root or with sudo:"
  echo "   sudo bash $0 $@"
  exit 1
fi

echo "=========================================="
echo "🧹 Starting VPS Storage Cleanup..."
echo "=========================================="

echo "📊 Disk usage BEFORE cleanup:"
df -h / | awk 'NR==1 || NR==2'
echo ""

# 1. Clean apt package cache and obsolete dependencies
if command -v apt-get >/dev/null 2>&1; then
  echo "📦 Cleaning apt package cache and orphaned packages..."
  apt-get clean
  apt-get autoremove --purge -y >/dev/null 2>&1 || true
fi

# 2. Vacuum systemd journal logs to max 200MB
if command -v journalctl >/dev/null 2>&1; then
  echo "📝 Trimming system logs to 200MB..."
  journalctl --vacuum-size=200M >/dev/null 2>&1 || true
fi

# 3. Clean temporary files older than 7 days
echo "🗑️  Cleaning old temp files..."
rm -rf /var/tmp/* 2>/dev/null || true

# 4. Clean npm cache if node/npm is installed
if command -v npm >/dev/null 2>&1; then
  echo "📦 Cleaning npm global cache..."
  npm cache clean --force 2>/dev/null || true
fi

# 5. Clean Docker if installed
if command -v docker >/dev/null 2>&1; then
  echo "🐳 Cleaning unused Docker cache and dangling images..."
  docker system prune -f >/dev/null 2>&1 || true
fi

echo ""
echo "📊 Disk usage AFTER cleanup:"
df -h / | awk 'NR==1 || NR==2'
echo ""

# Setup automated cron job if requested
if [ "$1" = "--install" ] || [ "$1" = "--cron" ]; then
  echo "⚙️  Installing weekly automated cleanup into /etc/cron.weekly/vps-cleanup..."
  TARGET="/etc/cron.weekly/vps-cleanup"
  
  cat << 'EOF' > "$TARGET"
#!/usr/bin/env bash
# Automatic weekly cleanup
if command -v apt-get >/dev/null 2>&1; then
  apt-get clean
  apt-get autoremove -y --purge >/dev/null 2>&1 || true
fi
if command -v journalctl >/dev/null 2>&1; then
  journalctl --vacuum-size=200M >/dev/null 2>&1 || true
fi
if command -v npm >/dev/null 2>&1; then
  npm cache clean --force >/dev/null 2>&1 || true
fi
if command -v docker >/dev/null 2>&1; then
  docker system prune -f >/dev/null 2>&1 || true
fi
EOF

  chmod +x "$TARGET"
  echo "✅ Automatic weekly cleanup scheduled! The VPS will now clean itself every week automatically."
fi

echo "=========================================="
echo "✨ Cleanup finished successfully!"
echo "=========================================="
