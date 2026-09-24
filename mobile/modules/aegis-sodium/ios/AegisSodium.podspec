# F-1 B2: native libsodium for the mobile crypto facade (iOS). Compiles the
# vendored, signature-verified libsodium sources and the aegis_sodium C core
# from source — no prebuilt binaries. The defines mirror ../cmake/libsodium.cmake
# (the Android/host build); keep the two lists in sync.
Pod::Spec.new do |s|
  s.name           = 'AegisSodium'
  s.version        = '1.0.0'
  s.summary        = 'AegisLink native libsodium binding'
  s.description    = 'libsodium (vendored, built from source) behind the AegisLink crypto facade'
  s.license        = 'GPL-3.0'
  s.author         = 'AegisLink'
  s.homepage       = 'https://github.com/gabinotech22-cmyk/AegisLink'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/gabinotech22-cmyk/AegisLink.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  sodium = 'vendor/libsodium/src/libsodium'
  s.source_files = [
    'ios/**/*.swift',
    'cpp/aegis_sodium.{h,c}',
    "#{sodium}/**/*.{c,h}",
  ]
  # No public headers: Swift reaches the C core only through cpp/module.modulemap
  # (`import AegisSodiumC`), so the header is not exported by two modules.
  s.private_header_files = ['cpp/*.h', "#{sodium}/**/*.h"]
  s.preserve_paths = ['cpp/module.modulemap', "#{sodium}/include/**/*.h"]

  defines = %w[
    SODIUM_STATIC=1 CONFIGURED=1 _GNU_SOURCE=1 NATIVE_LITTLE_ENDIAN=1
    HAVE_STDINT_H=1 HAVE_INTTYPES_H=1 HAVE_INLINE_ASM=1 HAVE_ATOMIC_OPS=1
    HAVE_C11_MEMORY_FENCES=1 HAVE_GCC_MEMORY_FENCES=1 TLS=_Thread_local
    HAVE_MMAP=1 HAVE_MLOCK=1 HAVE_MADVISE=1 HAVE_MPROTECT=1 HAVE_SYS_MMAN_H=1
    HAVE_SYSCONF=1 HAVE_POSIX_MEMALIGN=1 HAVE_WEAK_SYMBOLS=1
    HAVE_TI_MODE=1 HAVE_SAFE_ARC4RANDOM=1
  ]
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'GCC_PREPROCESSOR_DEFINITIONS' => "$(inherited) #{defines.join(' ')}",
    # libsodium includes "private/..." and "sodium/..." relative to these; header
    # maps are off because several libsodium headers share a basename.
    'HEADER_SEARCH_PATHS' => "$(inherited) \"$(PODS_TARGET_SRCROOT)/#{sodium}/include\" \"$(PODS_TARGET_SRCROOT)/#{sodium}/include/sodium\" \"$(PODS_TARGET_SRCROOT)/cpp\"",
    'USE_HEADERMAP' => 'NO',
    'SWIFT_INCLUDE_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/cpp"',
    'OTHER_CFLAGS' => '$(inherited) -fno-strict-aliasing -fwrapv -w',
  }
end
