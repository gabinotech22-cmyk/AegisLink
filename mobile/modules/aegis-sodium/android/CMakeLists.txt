cmake_minimum_required(VERSION 3.22)
project(aegis_sodium C)

include("${CMAKE_CURRENT_LIST_DIR}/../cmake/libsodium.cmake")

add_library(aegis_sodium SHARED "${CMAKE_CURRENT_LIST_DIR}/src/main/cpp/aegis_sodium_jni.c")
target_compile_options(aegis_sodium PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
target_link_libraries(aegis_sodium PRIVATE aegis_sodium_core)
# 16 KB pages (Android 15+). The NDK default build-id is a content hash, so the
# output stays reproducible (docs/REPRODUCIBLE-BUILDS.md).
target_link_options(aegis_sodium PRIVATE "-Wl,-z,max-page-size=16384")
