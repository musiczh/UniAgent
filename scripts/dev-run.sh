#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_home="$HOME/.uniagent-dev"
chromium_home="$HOME/Library/Application Support/uniagent-dev"
capability_home="$app_home/capability-home"
capability_data="$capability_home/.uniagent/capability-sync"

mkdir -p "$app_home" "$chromium_home" "$capability_home" "$capability_data"
exec env UA_DISABLE_GPU=1 UNIAGENT_USER_DATA="$app_home" \
  UNIAGENT_CAPABILITY_HOME="$capability_home" UNIAGENT_CAPABILITY_DATA="$capability_data" \
  "$repo_root/release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent" \
  --user-data-dir="$chromium_home" --remote-debugging-port=9222 --ua-e2e
