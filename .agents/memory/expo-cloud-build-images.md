---
name: Expo cloud build image pins
description: Why Rider App production cloud builds explicitly pin Node and Xcode versions.
---

Keep the Rider App's production Expo cloud builds pinned to Node 20.19.4, the Android SDK 54 image, and the macOS Sequoia 15.6 / Xcode 16.4 image while it remains on Expo SDK 54 and React Native 0.81.

**Why:** Expo's selected Android builder used Node 18.18 and Java 11, causing Metro to crash because `Array.prototype.toReversed()` was unavailable and Gradle to fail because the Android Gradle plugin requires Java 17. Its selected iOS builder used Xcode 15.4, while React Native 0.81 requires Xcode 16.1 or newer.

**How to apply:** Preserve both production build pins when changing Expo build settings. Re-evaluate them only when upgrading Expo SDK or React Native, using Expo's current infrastructure compatibility table.