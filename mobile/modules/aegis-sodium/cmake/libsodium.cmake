# libsodium, compiled from the vendored, signature-verified sources
# (vendor/libsodium, see scripts/vendor-libsodium.mjs), plus the aegis_sodium C
# core. Shared by the Android build (android/CMakeLists.txt) and the host test
# harness (test/CMakeLists.txt) so both compile exactly the same thing.
#
# No ./configure: the defines below are what configure detects on the targets
# we build for (Android arm64/armv7/x86/x86_64, Linux/macOS hosts). Portable C
# only — no assembly, no SIMD-specific code paths — so every ABI runs the same
# reference implementations libsodium tests on all platforms.
#
# Randomness: randombytes_sysrandom reads /dev/urandom (after one poll of
# /dev/random at init). getrandom(2) is not used because Android's minSdk (24)
# predates it in bionic (API 28) — the same choice libsodium's own Android
# build makes for those API levels.

set(AEGIS_SODIUM_ROOT "${CMAKE_CURRENT_LIST_DIR}/..")
set(AEGIS_LIBSODIUM_SRC "${AEGIS_SODIUM_ROOT}/vendor/libsodium/src/libsodium")

file(GLOB_RECURSE AEGIS_LIBSODIUM_SOURCES CONFIGURE_DEPENDS "${AEGIS_LIBSODIUM_SRC}/*.c")
# Deterministic object order: reproducible builds (docs/REPRODUCIBLE-BUILDS.md).
list(SORT AEGIS_LIBSODIUM_SOURCES)

add_library(aegis_libsodium STATIC ${AEGIS_LIBSODIUM_SOURCES})
set_target_properties(aegis_libsodium PROPERTIES POSITION_INDEPENDENT_CODE ON C_STANDARD 99)
target_include_directories(aegis_libsodium
  PUBLIC "${AEGIS_LIBSODIUM_SRC}/include"
  PRIVATE "${AEGIS_LIBSODIUM_SRC}/include/sodium")
target_compile_options(aegis_libsodium PRIVATE -fvisibility=hidden -fno-strict-aliasing -fwrapv -w)
target_compile_definitions(aegis_libsodium
  PUBLIC SODIUM_STATIC=1
  PRIVATE
    CONFIGURED=1
    _GNU_SOURCE=1
    NATIVE_LITTLE_ENDIAN=1
    HAVE_STDINT_H=1
    HAVE_INTTYPES_H=1
    HAVE_INLINE_ASM=1
    HAVE_ATOMIC_OPS=1
    HAVE_C11_MEMORY_FENCES=1
    HAVE_GCC_MEMORY_FENCES=1
    TLS=_Thread_local
    HAVE_MMAP=1
    HAVE_MLOCK=1
    HAVE_MADVISE=1
    HAVE_MPROTECT=1
    HAVE_SYS_MMAN_H=1
    HAVE_SYSCONF=1
    HAVE_POSIX_MEMALIGN=1
    HAVE_WEAK_SYMBOLS=1)
# 128-bit integers (faster, still constant-time field arithmetic) exist on 64-bit targets only.
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  target_compile_definitions(aegis_libsodium PRIVATE HAVE_TI_MODE=1)
endif()
if(APPLE)
  target_compile_definitions(aegis_libsodium PRIVATE HAVE_SAFE_ARC4RANDOM=1)
endif()
include(TestBigEndian)
test_big_endian(AEGIS_BIG_ENDIAN)
if(AEGIS_BIG_ENDIAN)
  message(FATAL_ERROR "aegis-sodium: big-endian targets are not supported")
endif()

add_library(aegis_sodium_core STATIC "${AEGIS_SODIUM_ROOT}/cpp/aegis_sodium.c" "${AEGIS_SODIUM_ROOT}/cpp/aegis_vault.c")
set_target_properties(aegis_sodium_core PROPERTIES POSITION_INDEPENDENT_CODE ON C_STANDARD 99)
target_include_directories(aegis_sodium_core PUBLIC "${AEGIS_SODIUM_ROOT}/cpp")
target_compile_options(aegis_sodium_core PRIVATE -Wall -Wextra -Werror)
target_link_libraries(aegis_sodium_core PUBLIC aegis_libsodium)
