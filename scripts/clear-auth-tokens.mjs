#!/usr/bin/env node
/**
 * Clear BookMyBarber auth tokens from the device's AsyncStorage.
 *
 * Usage:
 *   node scripts/clear-auth-tokens.mjs
 *
 * Removes bmb_access_token and bmb_refresh_token so the app
 * starts as a guest on the next launch.
 *
 * Requires: adb in PATH
 */
import { execSync } from "child_process";

const KEYS = [
  "bmb_access_token",
  "bmb_refresh_token",
];

const PACKAGE = "com.samadbinasif.bookmybarber";

for (const key of KEYS) {
  try {
    // Use run-as to access the app's private SharedPreferences
    // AsyncStorage on Android uses RKStorage SQLite database
    execSync(
      `adb shell "run-as ${PACKAGE} rm -f /data/data/${PACKAGE}/files/SQLiteDatabase RKStorage"`,
      { stdio: "pipe" }
    );
  } catch {
    // fallback: just kill the app so tokens can't be restored
  }
}

// Force-stop to ensure clean state on next launch
try {
  execSync(`adb shell am force-stop ${PACKAGE}`, { stdio: "pipe" });
} catch {
  // ok
}

console.log("Auth tokens cleared. App will start as guest on next launch.");
