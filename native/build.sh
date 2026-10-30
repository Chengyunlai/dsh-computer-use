#!/bin/sh
# Build the macOS Computer Use helper (requires Xcode Command Line Tools).
set -e
cd "$(dirname "$0")"
xcrun swiftc -O macos-helper.swift -o macos-helper
echo "built: $(pwd)/macos-helper"
