#!/usr/bin/env bash
# wipe.sh — Completely wipe the Paperclip default instance for a fresh start
# Usage: ./scripts/wipe.sh [--keep-backup]
#   --keep-backup   Skip the pre-wipe backup (dangerous, but faster)

set -euo pipefail

INSTANCE_DIR="$HOME/.paperclip/instances/default"
BACKUP_ROOT="$HOME/.paperclip/backups"
KEEP_BACKUP=false

# Parse args
for arg in "$@"; do
  case "$arg" in
    --keep-backup) KEEP_BACKUP=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

echo "=== Paperclip Full Wipe ==="
echo ""

# Check if instance exists
if [ ! -d "$INSTANCE_DIR" ]; then
  echo "No Paperclip instance found at $INSTANCE_DIR — nothing to wipe."
  echo "Run 'npx paperclipai onboard' to create a fresh instance."
  exit 0
fi

# Pre-wipe backup (unless skipped)
if [ "$KEEP_BACKUP" = false ]; then
  echo "[1/3] Creating pre-wipe backup..."
  bash "$(dirname "$0")/backup.sh" || {
    echo "ERROR: Backup failed. Aborting wipe."
    exit 1
  }
  STEP=2
else
  echo "[!] Skipping pre-wipe backup (--keep-backup flag set)"
  STEP=1
fi

# Kill any leftover embedded PostgreSQL processes
echo "[$STEP/3] Stopping embedded PostgreSQL..."
powershell.exe -Command "Get-Process postgres* -ErrorAction SilentlyContinue | Stop-Process -Force" 2>/dev/null || true
sleep 2
STEP=$((STEP + 1))

# Wipe the instance
echo "[$STEP/3] Deleting instance directory: $INSTANCE_DIR"
rm -rf "$INSTANCE_DIR"
echo "  ✓ Instance wiped"

echo ""
echo "✓ Wipe complete."
echo ""
echo "To start fresh:"
echo "  npx paperclipai onboard --yes --run"
