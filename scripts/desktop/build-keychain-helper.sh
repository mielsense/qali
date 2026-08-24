#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/../.." && pwd)"
source_file="${repository_root}/apps/desktop/native/keychain-helper/main.swift"
output_directory="${repository_root}/apps/desktop/resources/bin"
output_file="${output_directory}/keychain-helper"
temporary_build_directory="$(mktemp -d "${TMPDIR:-/tmp}/qali-keychain-helper.XXXXXX")"
trap 'rm -rf "${temporary_build_directory}"' EXIT

mkdir -p "${output_directory}"
CLANG_MODULE_CACHE_PATH="${temporary_build_directory}/clang-module-cache" \
SWIFT_MODULECACHE_PATH="${temporary_build_directory}/swift-module-cache" \
/usr/bin/xcrun swiftc \
  -target arm64-apple-macosx13.0 \
  -module-cache-path "${temporary_build_directory}/module-cache" \
  -framework Security \
  -O \
  "${source_file}" \
  -o "${output_file}"
chmod 0755 "${output_file}"

architecture="$(/usr/bin/file "${output_file}")"
if [[ "${architecture}" != *"arm64"* ]]; then
  echo "Keychain helper is not an arm64 Mach-O: ${architecture}" >&2
  exit 1
fi

echo "Built ${output_file} (${architecture})"
