
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "The macOS Whisper runtime must be built on macOS." >&2; exit 1; }
arch="$(uname -m)"
cache="$PWD/native/bin/macos/whisper-cache"
runtime="$PWD/native/bin/macos/whisper"
mkdir -p "$cache" "$runtime"

verified_download() {
  local output="$1" url="$2" hash="$3"
  if ! printf '%s  %s\n' "$hash" "$output" | shasum -a 256 -c -s; then
    curl --fail --location --silent --show-error --retry 2 "$url" -o "$output.tmp"
    printf '%s  %s\n' "$hash" "$output.tmp" | shasum -a 256 -c -s
    mv "$output.tmp" "$output"
  fi
}

archive="$cache/whisper-b5454.tar.gz"
verified_download "$archive" \
  https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/b5454 \
  9aa617f410d9c7f0dae952eb2b77eafdcfb310c2d622cca1f83633fd89a213bc
verified_download "$runtime/silero-v6.2.0.bin" \
  'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin?download=true' \
  2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987

tar -xzf "$archive" -C "$cache"
source_dir="$cache/whisper.cpp-b5454"
build_dir="$cache/build-$arch"
cmake -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 -DCMAKE_OSX_ARCHITECTURES="$arch" \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$build_dir" --config Release --target whisper-cli --parallel 3
install -m 755 "$build_dir/bin/whisper-cli" "$runtime/whisper-cli"
cp "$source_dir/LICENSE" "$runtime/whisper.cpp-LICENSE.txt"
curl --fail --location --silent --show-error --retry 2 \
  https://raw.githubusercontent.com/snakers4/silero-vad/be95df9152c0d7618fa1edfeb296fc3dae32376f/LICENSE \
  -o "$runtime/silero-vad-LICENSE.txt"
