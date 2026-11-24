
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "The macOS helper requires Xcode tools on macOS." >&2; exit 1; }
arch="$(uname -m)"
out=native/bin/macos
mkdir -p "$out"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
xcrun --sdk macosx swiftc -sdk "$sdk" -target "$arch-apple-macos14.0" -swift-version 5 \
  -parse-as-library -O native/macos/*.swift -o "$out/pane-native"

icons="$out/Pane.iconset"
mkdir -p "$icons"
for px in 16 32 128 256 512; do
  sips -z "$px" "$px" src/renderer/public/pane.png --out "$icons/icon_$px"x"$px.png" >/dev/null
  retina=$((px * 2))
  sips -z "$retina" "$retina" src/renderer/public/pane.png --out "$icons/icon_$px"x"$px@2x.png" >/dev/null
done
iconutil -c icns "$icons" -o "$out/pane.icns"
