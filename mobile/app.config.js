const baseConfig = require("./app.json");

// EAS_MIRROR=1 builds/publishes against the aegislink2026 mirror project
// (used when the primary aegislink EAS account has hit its build quota).
// The mirror project has no APNs credentials configured — see docs before
// relying on push/VoIP wake in a mirror build.
const useMirror = process.env.EAS_MIRROR === "1";

const MIRROR = {
  owner: "aegislink2026",
  projectId: "5540f1e5-c21a-4047-9ab7-7128fabb1ee0",
};

module.exports = ({ config }) => {
  const expo = config.expo ?? baseConfig.expo;

  if (!useMirror) {
    return { expo };
  }

  return {
    expo: {
      ...expo,
      owner: MIRROR.owner,
      extra: {
        ...expo.extra,
        eas: {
          ...expo.extra?.eas,
          projectId: MIRROR.projectId,
        },
      },
      updates: {
        ...expo.updates,
        url: `https://u.expo.dev/${MIRROR.projectId}`,
      },
    },
  };
};
