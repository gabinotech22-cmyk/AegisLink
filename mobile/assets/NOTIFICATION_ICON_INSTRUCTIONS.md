# Notification Icon — Production Replacement Required

## Current state

`notification-icon.png` is a copy of `icon-tinted.png` used as a placeholder.
This is acceptable for development builds but MUST be replaced before a production release.

## Android requirements for notification icons

- Format: PNG with **white pixels on a transparent background** (monochrome)
- Size: **96×96 px** (xxxhdpi) — also provide 72×72 (xxhdpi), 48×48 (xhdpi), 36×36 (hdpi), 24×24 (mdpi) if targeting legacy densities
- Content: silhouette/shape only — no color fill, no gradients
- Android ignores color information in the icon bitmap; only the alpha channel is used.
  The tint color (#5bf2b9) is applied by the system from `android.notification.color` in app.json.

## How to replace

1. Export the AegisLink shield logo as a white-on-transparent PNG at 96×96 px from your design tool (Figma, Illustrator, etc.).
2. Overwrite `mobile/assets/notification-icon.png` with the new file.
3. Rebuild the app via EAS Build or `npx expo run:android`.

## Reference

- Android docs: https://developer.android.com/develop/ui/views/notifications#icon
- Expo docs: https://docs.expo.dev/versions/v54.0.0/config/app/#notification
