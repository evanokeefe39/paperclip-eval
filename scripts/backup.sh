#!/usr/bin/env bash
# backup.sh — Full backup of the Paperclip default instance
# Usage: ./scripts/backup.sh
# Output: ~/.paperclip/backups/paperclip-backup-YYYYMMDD-HHMMSS.zip

set -euo pipefail

INSTANCE_DIR="$HOME/.paperclip/instances/default"
BACKUP_ROOT="$HOME/.paperclip/backups"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_NAME="paperclip-backup-${TIMESTAMP}"
BACKUP_DIR="${BACKUP_ROOT}/${BACKUP_NAME}"
BACKUP_ZIP="${BACKUP_ROOT}/${BACKUP_NAME}.zip"

echo "=== Paperclip Full Instance Backup ==="
echo ""

# Check if instance exists
if [ ! -d "$INSTANCE_DIR" ]; then
  echo "ERROR: No Paperclip instance found at $INSTANCE_DIR"
  echo "Run 'npx paperclipai onboard' first to create one."
  exit 1
fi

# Create backup directory
mkdir -p "$BACKUP_ROOT"

# Run Paperclip's own DB backup first (safe, uses CLI)
echo "[1/3] Backing up database via Paperclip CLI..."
if command -v npx &>/dev/null; then
  npx paperclipai db:backup 2>&1 || echo "  (warning: CLI db backup failed, continuing with file copy)"
else
  echo "  (warning: npx not found, skipping CLI db backup)"
fi

# Copy entire instance to temp backup dir
echo "[2/3] Copying instance files..."
cp -r "$INSTANCE_DIR" "$BACKUP_DIR"

# Zip it up
echo "[3/3] Archiving to $BACKUP_ZIP ..."
# Use PowerShell on Windows, zip on Unix
if command -v powershell.exe &>/dev/null; then
  powershell.exe -Command "Compress-Archive -Path '$BACKUP_DIR' -DestinationPath '$BACKUP_ZIP' -Force"
else
  (cd "$BACKUP_ROOT" && zip -r "${BACKUP_NAME}.zip" "$BACKUP_NAME")
fi

# Clean up the temp directory
rm -rf "$BACKUP_DIR"

echo ""
echo "✓ Backup complete: $BACKUP_ZIP"
echo ""
echo "Contents: config.json, .env, secrets/, data/, db/, logs/"
echo ""
echo "To restore, unzip this archive back to:"
echo "  $INSTANCE_DIR"
