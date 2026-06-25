#!/bin/bash -eu
# ClusterFuzzLite build entry point for AegisLink.
#
# Single source of truth: the actual build logic lives in
# infra/oss-fuzz/build.sh and is shared verbatim with the OSS-Fuzz integration.
# ClusterFuzzLite copies *this* file to $SRC/build.sh, while the full repo
# (including infra/oss-fuzz/build.sh) lands at $SRC/aegislink, so we just hand
# off to it. -eu is re-passed explicitly because invoking via `bash <file>`
# ignores the delegate's own shebang flags.
exec bash -eu "$SRC/aegislink/infra/oss-fuzz/build.sh"
