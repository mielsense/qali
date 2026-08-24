#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/../.." && pwd)"
commit="f4a0132c073eb7c8545dc90ff48abb47f8d7ba73"
source_url="https://github.com/get-convex/convex-backend/archive/${commit}.tar.gz"
source_sha256="766e745254180899f0f4bb104c82703454e1f19d1dcb2966ce4c6282154eb2c9"
toolchain="nightly-2026-06-28"
expected_compiler="rustc 1.98.0-nightly (13f1859f2 2026-06-27)"
expected_output_sha256="48390546579f5ff1274d3c8f513c5a50b76e8f6ab96935c1cbb312cf485f70f2"
wrapper_source="${repository_root}/apps/desktop/native/convex-keygen/generate_key.rs"
expected_wrapper_sha256="044a62217b2558a8fe32b52ed5cead6cf8072aa90633dd06e636a5ab726c0786"
temporary_build_directory="$(mktemp -d "${TMPDIR:-/tmp}/qali-convex-keygen.XXXXXX")"
trap 'rm -rf "${temporary_build_directory}"' EXIT

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The Convex key generator is approved only for darwin-arm64." >&2
  exit 1
fi
if [[ "$(rustup run "${toolchain}" rustc --version)" != "${expected_compiler}" ]]; then
  echo "Pinned compiler mismatch. Expected: ${expected_compiler}" >&2
  exit 1
fi
nightly_rustc="$(rustup which --toolchain "${toolchain}" rustc)"

archive="${temporary_build_directory}/source.tar.gz"
/usr/bin/curl --fail --location --silent --show-error "${source_url}" --output "${archive}"
actual_source_sha256="$(/usr/bin/shasum -a 256 "${archive}" | /usr/bin/awk '{print $1}')"
if [[ "${actual_source_sha256}" != "${source_sha256}" ]]; then
  echo "Pinned Convex source archive hash mismatch." >&2
  exit 1
fi
/usr/bin/tar -xzf "${archive}" -C "${temporary_build_directory}"
source_root="${temporary_build_directory}/convex-backend-${commit}"
actual_wrapper_sha256="$(/usr/bin/shasum -a 256 "${wrapper_source}" | /usr/bin/awk '{print $1}')"
if [[ "${actual_wrapper_sha256}" != "${expected_wrapper_sha256}" ]]; then
  echo "Qali key-generator wrapper hash mismatch." >&2
  exit 1
fi
/bin/cp "${wrapper_source}" "${source_root}/crates/keybroker/src/bin/generate_key.rs"

CARGO_TARGET_DIR="${temporary_build_directory}/target" \
  RUSTC="${nightly_rustc}" \
  rustup run "${toolchain}" cargo build \
    --manifest-path "${source_root}/Cargo.toml" \
    --locked \
    --release \
    --target aarch64-apple-darwin \
    -p keybroker \
    --bin generate_key

output_directory="${repository_root}/apps/desktop/resources/bin"
output_file="${output_directory}/convex-generate-key"
/bin/mkdir -p "${output_directory}"
/bin/cp "${temporary_build_directory}/target/aarch64-apple-darwin/release/generate_key" "${output_file}"
/bin/chmod 0755 "${output_file}"

architecture="$(/usr/bin/file "${output_file}")"
if [[ "${architecture}" != *"Mach-O 64-bit executable arm64"* ]]; then
  echo "Convex key generator is not an arm64 Mach-O: ${architecture}" >&2
  exit 1
fi
actual_output_sha256="$(/usr/bin/shasum -a 256 "${output_file}" | /usr/bin/awk '{print $1}')"
if [[ "${actual_output_sha256}" != "${expected_output_sha256}" ]]; then
  echo "Convex key generator output hash mismatch." >&2
  exit 1
fi
echo "Built ${output_file} with ${expected_compiler}"
echo "SHA-256: ${actual_output_sha256}"
