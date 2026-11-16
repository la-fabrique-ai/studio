#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
version="${1:?Usage: build-images.sh <version> <load|push|print> [app|migrate]}"
mode="${2:?Choose load, push or print}"
shift 2

# SemVer without build metadata: '+' is not valid in Docker tags.
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ || ${#version} -gt 128 ]]; then
  echo "Use X.Y.Z or X.Y.Z-prerelease (no v prefix or +build metadata)." >&2
  exit 1
fi
if [[ "$version" == *-* ]]; then
  IFS='.' read -r -a identifiers <<< "${version#*-}"
  for identifier in "${identifiers[@]}"; do
    if [[ "$identifier" =~ ^0[0-9]+$ ]]; then
      echo "Numeric SemVer prerelease identifiers cannot have leading zeroes." >&2
      exit 1
    fi
  done
fi
case "$mode" in load|push|print) ;; *) echo "Choose load, push or print." >&2; exit 1 ;; esac
package_version=$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")
if [[ "${version%%-*}" != "$package_version" ]]; then
  echo "Version base must match package.json ($package_version)." >&2
  exit 1
fi
if [[ $# -eq 0 ]]; then set -- app migrate; fi
for target in "$@"; do
  case "$target" in app|migrate) ;; *) echo "Unknown target: $target (use app or migrate)." >&2; exit 1 ;; esac
done

export VERSION="$version"
REVISION=$(git rev-parse HEAD)
export REVISION
SOURCE_DIRTY=false
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then SOURCE_DIRTY=true; fi
export SOURCE_DIRTY
export PLATFORM="${PLATFORM:-linux/amd64}"

# Branch tests may include uncommitted work, but must never look like stable releases.
if [[ "$mode" == push && "$version" != *-* ]]; then
  echo "Local publishing requires a prerelease tag, e.g. 0.1.0-local.1. Use CI for stable releases." >&2
  exit 1
fi

printf 'Studio images: %s (%s, %s, local changes: %s)\n' "$VERSION" "$mode" "$PLATFORM" "$SOURCE_DIRTY" >&2
docker buildx bake --file "$ROOT_DIR/docker-bake.json" "--$mode" "$@"
