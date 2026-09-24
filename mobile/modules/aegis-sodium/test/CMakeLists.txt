# Host build of the aegis_sodium C core + vendored libsodium, for the
# differential test (test/differential.mjs). Not shipped: the app builds the
# same sources through android/CMakeLists.txt and ios/AegisSodium.podspec.
cmake_minimum_required(VERSION 3.22)
project(aegis_sodium_host C)
include("${CMAKE_CURRENT_LIST_DIR}/../cmake/libsodium.cmake")
add_executable(aegis_sodium_cli "${CMAKE_CURRENT_LIST_DIR}/cli.c")
target_compile_options(aegis_sodium_cli PRIVATE -Wall -Wextra -Werror)
target_link_libraries(aegis_sodium_cli PRIVATE aegis_sodium_core)
