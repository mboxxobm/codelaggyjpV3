#!/bin/zsh
set -euo pipefail

SOURCE="/Users/tools/Documents/codelaggyjp/20260806-restored"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="/Users/tools/Documents/codelaggyjp/backups/20260806-restored-${STAMP}"

mkdir -p "$(dirname "${DEST}")"
ditto "${SOURCE}" "${DEST}"
echo "Backup created: ${DEST}"
