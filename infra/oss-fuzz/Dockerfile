# OSS-Fuzz builder image for AegisLink (JavaScript / Jazzer.js).
# Mirror of projects/aegislink/Dockerfile in google/oss-fuzz.
FROM gcr.io/oss-fuzz-base/base-builder-javascript

# Shallow clone — the build only needs the current tree, not history.
RUN git clone --depth 1 https://github.com/gabinotech22-cmyk/AegisLink.git aegislink
WORKDIR $SRC/aegislink

# build.sh is copied next to the checkout by the OSS-Fuzz infra convention.
COPY build.sh $SRC/
