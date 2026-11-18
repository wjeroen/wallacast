#!/usr/bin/env bash
# Builds the two Android apps without Gradle: android/watch (the Wear OS remote) and
# android/link (the phone helper that pauses and plays Spotify with Wallacast).
#
# Needs: aapt2, d8, apksigner, javac (JDK 17 or later), python3, and android.jar of API 35.
#   Termux:  pkg install aapt2 d8 apksigner openjdk-21 python
#            then the platform zip from Google, see android/README.md
#   Elsewhere: the Android SDK's build-tools and platforms/android-35/android.jar
#
# Usage: android/build.sh [watch|link]   (both when no app is named)
# Output: android/build/wallacast-watch.apk and android/build/wallacast-link.apk
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
# Every commit raises the version, so an update always installs over the old app
VERSION_CODE="$(git -C "$HERE" rev-list --count HEAD 2>/dev/null || echo 1)"

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
  local app="$1" min_sdk="$2"
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
    --out "$HERE/build/wallacast-$app.apk" "$out/unsigned.apk"
  rm -f "$HERE/build/wallacast-$app.apk.idsig"
  echo "  -> android/build/wallacast-$app.apk"
}

case "${1:-all}" in
  watch) build_app watch 30 ;;
  link) build_app link 26 ;;
  all) build_app watch 30; build_app link 26 ;;
  *) echo "Usage: $0 [watch|link]"; exit 1 ;;
esac
