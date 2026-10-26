#!/usr/bin/env bash
# Touch AutoBuild prebuild for the Capacitor project. Mirrors the steps of .github/workflows/android.yml
# that run before Gradle. Reviewed with the repository; runs with a minimal environment and no secrets.
set -euo pipefail
npm test
npm install
npx cap add android
python3 -m pip install --user pillow
python3 tools/patch_android.py
npx cap sync android
