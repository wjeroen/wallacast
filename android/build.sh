#!/usr/bin/env bash
# Builds the two Android apps without Gradle: android/watch (the Wallacast remote for a Wear OS
# watch) and android/player-link (Player Link, pauses and plays the players you link together).
#
# Needs: aapt2, d8, apksigner, javac (JDK 17 or later), python3, and android.jar of API 35.
#   Termux:  pkg install aapt2 d8 apksigner openjdk-21 python
#            then the platform zip from Google, see android/README.md
#   Elsewhere: the Android SDK's build-tools and platforms/android-35/android.jar
#
# Usage: android/build.sh [watch|player-link]   (both when no app is named)
# Output: android/build/wallacast-watch.apk and android/build/player-link.apk
#
# Signing: the key in $WALLACAST_KEYSTORE (default ~/.android-keys/wallacast.jks) with its
# password in the file $WALLACAST_KEYSTORE_PASS (default ~/.android-keys/wallacast.pass).
# An update must carry the same key as the installed app, so keep that key safe. When it
# does not exist yet, the script makes one.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ANDROID_JAR="${ANDROID_JAR:-$HOME/.android-build/android-35.jar}"
KEYSTORE="${WALLACAST_KEYSTORE:-$HOME/.android-keys/wallacast.jks}"
KEYPASS="${WALLACAST_KEYSTORE_PASS:-$HOME/.android-keys/wallacast.pass}"
VERSION_NAME="1.0"
# Every commit raises the version, so an update always installs over the old app. A test build
# can set VERSION_CODE lower, for example to try the Update button on an emulator.
VERSION_CODE="${VERSION_CODE:-$(git -C "$HERE" rev-list --count HEAD 2>/dev/null || echo 1)}"

[ -f "$ANDROID_JAR" ] || { echo "android.jar not found at $ANDROID_JAR (see android/README.md)"; exit 1; }

if [ ! -f "$KEYSTORE" ]; then
  echo "No signing key yet: making one at $KEYSTORE"
  mkdir -p "$(dirname "$KEYSTORE")"
  chmod 700 "$(dirname "$KEYSTORE")"
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$KEYPASS"
  chmod 600 "$KEYPASS"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass:file "$KEYPASS" -keypass:file "$KEYPASS" \
    -alias wallacast -keyalg RSA -keysize 3072 -validity 20000 -dname "CN=Wallacast" >/dev/null
  chmod 600 "$KEYSTORE"
fi

build_app() {
  local app="$1" min_sdk="$2" apk="$3"
  local src="$HERE/$app" out="$HERE/build/$app"
  echo "Building $app (version $VERSION_NAME, code $VERSION_CODE)"
  rm -rf "$out"
  mkdir -p "$out/gen" "$out/classes" "$out/dex"
  aapt2 compile --dir "$src/res" -o "$out/res.zip"
  aapt2 link -o "$out/base.apk" -I "$ANDROID_JAR" --manifest "$src/AndroidManifest.xml" \
    --java "$out/gen" --min-sdk-version "$min_sdk" --target-sdk-version 35 \
    --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" "$out/res.zip"
  javac --release 8 -classpath "$ANDROID_JAR" -Xlint:-options -encoding UTF-8 \
    -d "$out/classes" $(find "$src/src" "$out/gen" -name '*.java')
  d8 --release --min-api "$min_sdk" --lib "$ANDROID_JAR" --output "$out/dex" $(find "$out/classes" -name '*.class')
  python3 "$HERE/tools/apkpack.py" "$out/base.apk" "$out/dex/classes.dex" "$out/unsigned.apk"
  apksigner sign --ks "$KEYSTORE" --ks-pass "file:$KEYPASS" --ks-key-alias wallacast \
    --out "$HERE/build/$apk" "$out/unsigned.apk"
  rm -f "$HERE/build/$apk.idsig"
  echo "  -> android/build/$apk"
}

case "${1:-all}" in
  watch) build_app watch 30 wallacast-watch.apk ;;
  player-link) build_app player-link 26 player-link.apk ;;
  all) build_app watch 30 wallacast-watch.apk; build_app player-link 26 player-link.apk ;;
  *) echo "Usage: $0 [watch|player-link]"; exit 1 ;;
esac
