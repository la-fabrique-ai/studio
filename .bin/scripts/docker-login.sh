#!/usr/bin/env bash
set -euo pipefail

registry_user="${GHCR_USERNAME:-}"
registry_token="${GHCR_TOKEN:-}"
if [[ -z "$registry_user" ]]; then
  read -r -p "GitHub username: " registry_user
fi
if [[ -z "$registry_token" ]]; then
  read -r -s -p "GHCR token (write:packages): " registry_token
  printf '\n'
fi
if [[ -z "$registry_user" || -z "$registry_token" ]]; then
  echo "A GitHub username and GHCR token are required." >&2
  exit 1
fi
printf '%s' "$registry_token" | docker login ghcr.io --username "$registry_user" --password-stdin
unset registry_token
