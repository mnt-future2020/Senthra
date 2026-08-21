const { AndroidConfig, withAndroidManifest } = require("@expo/config-plugins");

/**
 * Declare, in the main Android manifest, that this app does not send personal data in the clear.
 *
 * ## What was here before
 *
 * `app.json` carried `android.usesCleartextTraffic: true`. On Expo 56 that key is INERT — nothing in
 * the installed toolchain reads it. Verified two ways: no `@expo/*` or `expo/*` package consumes the
 * app-config key (only `Manifest.d.ts` types the XML attribute), and `expo config --type introspect`
 * produced an `<application>` node with no `android:usesCleartextTraffic` attribute at all. So the
 * app was neither allowing nor denying cleartext by that key; it read as a permissive declaration
 * while doing nothing.
 *
 * ## What actually governs it, and why this is safe for local development
 *
 * Release builds fell through to the platform default. With `targetSdkVersion` 35 (Expo's default)
 * that default is "deny", so releases were already blocked — implicitly, and only for as long as
 * nothing lowers the target SDK or merges in a permissive value from a library manifest. This plugin
 * makes the deny EXPLICIT so it stops depending on a default.
 *
 * Debug builds are unaffected. The Expo/React Native template generates
 * `android/app/src/debug/AndroidManifest.xml` containing:
 *
 *   <application android:usesCleartextTraffic="true" tools:replace="android:usesCleartextTraffic" />
 *
 * `tools:replace` means the debug variant OVERRIDES this value at manifest-merge time, by design.
 * (Confirmed by generating the native project with `expo prebuild` and reading both manifests; the
 * `debugOptimized` variant carries the same override.) So `expo start`, a dev client, and an
 * emulator talking to `http://10.0.2.2:8000` or `http://localhost:8000` keep working exactly as
 * before — the development EAS profile, which is the only one without an HTTPS API URL, is a debug
 * build.
 *
 * Nothing here touches API URLs, authentication, or any runtime behaviour.
 */
const withAndroidCleartextPolicy = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    application.$["android:usesCleartextTraffic"] = "false";
    return cfg;
  });

module.exports = withAndroidCleartextPolicy;
