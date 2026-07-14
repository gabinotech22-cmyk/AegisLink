const baseConfig = require("./app.json");

// EAS_MIRROR=1 builds/publishes against a free-tier mirror EAS project
// instead of the primary one (used whenever the currently-active account has
// hit its monthly build quota - this has happened more than once, hence the
// generic override instead of a single hardcoded mirror). The mirror
// project(s) have no APNs credentials configured — see docs before relying
// on push/VoIP wake in a mirror build.
//
// Which mirror: EAS_MIRROR_OWNER/EAS_MIRROR_PROJECT_ID override the built-in
// MIRRORS table below, so switching to a brand-new account (e.g. after this
// one also runs out) needs no code change - just set those two env vars in
// the build .bat. Once a new mirror has proven itself, add it to MIRRORS so
// EAS_MIRROR=<n> can select it by number without the env-var overrides.
const useMirror = process.env.EAS_MIRROR === "1" || process.env.EAS_MIRROR === "2";

const MIRRORS = {
  1: {
    owner: "aegislink2026",
    projectId: "5540f1e5-c21a-4047-9ab7-7128fabb1ee0",
  },
  2: {
    owner: "aegislinkspejo3",
    projectId: "599be334-3b85-4ecb-b954-a194b0ab303f",
  },
};

const MIRROR = {
  owner: process.env.EAS_MIRROR_OWNER || MIRRORS[process.env.EAS_MIRROR]?.owner,
  projectId: process.env.EAS_MIRROR_PROJECT_ID || MIRRORS[process.env.EAS_MIRROR]?.projectId,
};

module.exports = ({ config }) => {
  const expo = config.expo ?? baseConfig.expo;

  if (!useMirror && !process.env.EAS_MIRROR_OWNER) {
    return { expo };
  }
  if (!MIRROR.owner || !MIRROR.projectId) {
    throw new Error(
      "[app.config.js] EAS_MIRROR set but no owner/projectId resolved - " +
      "set EAS_MIRROR_OWNER + EAS_MIRROR_PROJECT_ID, or add this mirror number to MIRRORS."
    );
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
