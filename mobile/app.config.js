const baseConfig = require("./app.json");

// The canonical EAS project is app.json's owner/projectId (aegislinkspejo3
// since 2026-07-14 — see docs: the original `aegislink` account and the
// aegislink2026 mirror both exhausted their free-tier build quotas, and
// account access to the original was lost; Apple-side credentials are
// account-independent so nothing else moved).
//
// EAS_MIRROR_OWNER + EAS_MIRROR_PROJECT_ID remain as an emergency escape
// hatch: set both to build against any other EAS project with no code
// change (e.g. if this account's quota runs out too). The old numbered
// EAS_MIRROR=1/2 selector is gone — 2 IS now the default, and 1
// (aegislink2026) has no quota left.
const OVERRIDE = {
  owner: process.env.EAS_MIRROR_OWNER,
  projectId: process.env.EAS_MIRROR_PROJECT_ID,
};

module.exports = ({ config }) => {
  const expo = config.expo ?? baseConfig.expo;

  if (!OVERRIDE.owner && !OVERRIDE.projectId) {
    return { expo };
  }
  if (!OVERRIDE.owner || !OVERRIDE.projectId) {
    throw new Error(
      "[app.config.js] EAS_MIRROR_OWNER and EAS_MIRROR_PROJECT_ID must be set together."
    );
  }

  return {
    expo: {
      ...expo,
      owner: OVERRIDE.owner,
      extra: {
        ...expo.extra,
        eas: {
          ...expo.extra?.eas,
          projectId: OVERRIDE.projectId,
        },
      },
      updates: {
        ...expo.updates,
        url: `https://u.expo.dev/${OVERRIDE.projectId}`,
      },
    },
  };
};
