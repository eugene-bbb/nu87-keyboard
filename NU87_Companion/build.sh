#!/bin/sh
# Builds build/NU87 Companion.app (menu-bar app; needs the bundle so macOS can ask for Bluetooth permission).
set -e
cd "$(dirname "$0")"
swift build -c release
APP="build/NU87 Companion.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cp .build/release/NU87Companion "$APP/Contents/MacOS/"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --identifier com.nucode.nu87companion -r='designated => identifier "com.nucode.nu87companion"' "$APP"
echo "Built: $APP"
