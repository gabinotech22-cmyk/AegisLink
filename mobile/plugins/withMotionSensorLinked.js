const { withPodfileProperties } = require('expo/config-plugins');

/**
 * expo-sensors' own plugin ties two unrelated things to one flag: whether
 * NSMotionUsageDescription appears in Info.plist (must never — it gates
 * CMPedometer/activity-recognition, which this app does not use and which
 * is on the permanent iOS forbidden list in scripts/audit-permissions.mjs)
 * and whether EXMotionPermissionRequester.m gets compiled at all
 * (ExpoSensors.podspec excludes it when the MOTION_PERMISSION Podfile
 * property is the string 'false', which app.json's `motionPermission: false`
 * sets). DeviceMotionModule.swift references that class unconditionally for
 * raw accelerometer/gyro reads — used by the panic gesture — with or without
 * the Pedometer permission it actually gates, so excluding the file is a
 * broken build (`Undefined symbols ... EXMotionPermissionRequester`), not a
 * privacy improvement: iOS never gates raw motion reads behind any usage
 * string, only step-counting/activity APIs do.
 *
 * Must be listed in app.json BEFORE the "expo-sensors" plugin entry — Expo
 * runs mod actions of the same type in the REVERSE of plugin-list order (the
 * later-registered plugin wraps the earlier one and runs first), so being
 * earlier in the list means this runs later and gets the final say on the
 * Podfile property. It only touches that property; the Info.plist deletion
 * stays entirely on expo-sensors' own `motionPermission: false` handling.
 */
const withMotionSensorLinked = (config) =>
  withPodfileProperties(config, (config) => {
    delete config.modResults.MOTION_PERMISSION;
    return config;
  });

module.exports = withMotionSensorLinked;
