# ClusterFuzzLite builder image for AegisLink (JavaScript / Jazzer.js).
#
# Same base image and build logic as the OSS-Fuzz integration
# (infra/oss-fuzz/), with one difference: ClusterFuzzLite fuzzes the code in the
# *current* PR/commit, so we COPY the local checkout the CI action mounts
# instead of git-cloning a fixed ref.
FROM gcr.io/oss-fuzz-base/base-builder-javascript

# ClusterFuzzLite mounts the repository being fuzzed; copy it into $SRC.
COPY . $SRC/aegislink
WORKDIR $SRC/aegislink

# build.sh is copied next to the checkout by the ClusterFuzzLite convention.
# It is a thin wrapper that delegates to infra/oss-fuzz/build.sh so the two
# fuzzing integrations never drift.
COPY .clusterfuzzlite/build.sh $SRC/
