/**
 * Expo config plugin — embedded Tor F1+F2 (iOS). docs/FASE4-TOR-IOS-DESIGN.md.
 *
 * Mirrors plugins/withTorEmbedded.js (Android) so mobile/src/net/tor.ts and
 * TorSioSocket work identically on both platforms with zero JS changes:
 *   F1: Tor lifecycle (start/getStatus/stop, "AegisTorStatus" event) via
 *       Tor.framework (TORThread/TORConfiguration/TORController).
 *   F2: a DUMB, reusable socket.io-over-SOCKS pipe (sioConnect/sioEmit/
 *       sioDisconnect, "AegisTorSio" event). The Fase 4 F2 spike
 *       (feat/ios-tor-socks-spike, 2026-07-13) confirmed on a real iPhone
 *       that URLSessionConfiguration.connectionProxyDictionary DOES route a
 *       URLSessionWebSocketTask through a SOCKS5 proxy on iOS — so this
 *       hand-rolls the (small) engine.io v4 / socket.io v5 wire protocol on
 *       top of that PROVEN primitive, deliberately NOT using
 *       socket.io-client-swift: that library's WebSocket engine runs on
 *       Starscream, not URLSessionWebSocketTask, and its `enableSOCKSProxy`
 *       option takes no host/port/credentials (it toggles Starscream's own
 *       stream-level SOCKS handling, which historically reads the SYSTEM
 *       proxy config, not a proxy we specify programmatically) — i.e. it
 *       would NOT reliably point at Tor's own local SOCKS port. All protocol
 *       parsing here is a dumb pipe like Android's: no message content is
 *       interpreted beyond the socket.io envelope (event name + JSON args);
 *       the audited crypto stays in JS.
 *
 * Tor.framework calls are isolated in an Objective-C wrapper
 * (AegisTorBridge.h/.m) using the EXACT documented ObjC selectors, with
 * NS_SWIFT_NAME on every method so the Swift-visible signature is authored
 * explicitly rather than relying on the Clang importer's inference — there
 * is no local Mac to compile-check this, so removing that class of risk
 * matters more than it would on a normal iOS project.
 *
 * F4 (ntfy httpSubscribe over Tor) is NOT included here — fast-follow, see
 * docs/FASE4-TOR-IOS-DESIGN.md §6.
 *
 * Known gap (documented, not silently assumed away): no automatic
 * reconnection on drop — a dropped sio socket forwards "disconnect" and
 * stops; Android's socket.io-client-java reconnects transparently
 * (`opts.reconnection = true`). Close before this is treated as
 * production-parity with Android; tracked as iOS F2.1.
 */
const {
  withPodfile,
  withXcodeProject,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ── 1. Podfile: add the Tor pod ───────────────────────────────────────────
function withTorPod(config) {
  return withPodfile(config, (config) => {
    // GeoIP subspec (pulls in Tor/CTor transitively) - not just Tor/CTor
    // alone. The pod maintainer's own reference integration (TorManager)
    // always sets geoipFile/geoip6File; our first attempt omitted both the
    // subspec and the config properties, and Tor's thread never opened its
    // control port at all.
    // IPtProxy (Tor Browser's lyrebird + snowflake, the pluggable transports
    // Onion Browser uses) rides along: bridges, mobile/src/net/torBridges.ts.
    // A Podfile from an older prebuild already has Tor but not IPtProxy.
    if (config.modResults.contents.includes("pod 'Tor/GeoIP'")) {
      if (!config.modResults.contents.includes("pod 'IPtProxy'")) {
        config.modResults.contents = config.modResults.contents.replace(
          "pod 'Tor/GeoIP'",
          "pod 'Tor/GeoIP'\n  pod 'IPtProxy', '5.5.1'",
        );
      }
      return config;
    }
    // Insert right after the first `target '<name>' do` line (the app
    // target), matching the common community pattern for config-plugin
    // Podfile edits since @expo/config-plugins has no addPod() helper.
    const targetRe = /target ['"][^'"]+['"] do\n/;
    if (!targetRe.test(config.modResults.contents)) {
      throw new Error('[withTorEmbeddedIOS] could not find the app target block in the Podfile.');
    }
    config.modResults.contents = config.modResults.contents.replace(
      targetRe,
      (match) => `${match}  # AegisLink: embedded Tor (injected by withTorEmbeddedIOS.js)\n  pod 'Tor/GeoIP'\n  pod 'IPtProxy', '5.5.1'\n`,
    );
    return config;
  });
}

// ── 2. Bridging header: React + our own ObjC wrapper visible to Swift ────
// NOTE: no RCTEventEmitter.h import here on purpose. This project's prebuilt
// React-Core XCFramework's umbrella header does NOT include RCTEventEmitter.h
// (confirmed: build fa12407e failed with "cannot find type 'RCTEventEmitter'
// in scope" despite the header physically existing and other .mm files in
// the same build successfully using headers from the same family) - Swift's
// Clang-importer needs the type in the MODULE's umbrella, not just importable
// textually, and this prebuilt framework's umbrella excludes it. So the
// RCTEventEmitter subclass lives in Objective-C (AegisTor.m) instead, which
// only needs a textual #import and compiles fine; it forwards to the plain-
// NSObject Swift logic class below via the AegisTorEventSink protocol.
const BRIDGING_IMPORTS = ['#import <React/RCTBridgeModule.h>', '#import "AegisTorBridge.h"'];

function withTorBridgingHeaderFile(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName;
      if (!projectName) {
        throw new Error('[withTorEmbeddedIOS] could not resolve iOS projectName for the bridging header.');
      }
      const headerPath = path.join(
        config.modRequest.platformProjectRoot,
        projectName,
        `${projectName}-Bridging-Header.h`,
      );
      let contents = fs.existsSync(headerPath) ? fs.readFileSync(headerPath, 'utf8') : '';
      for (const line of BRIDGING_IMPORTS) {
        if (!contents.includes(line)) {
          const prefix = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
          contents += `${prefix}${line}\n`;
        }
      }
      fs.writeFileSync(headerPath, contents);
      return config;
    },
  ]);
}

function withTorBridgingHeaderSetting(config) {
  return withXcodeProject(config, (config) => {
    const projectName = config.modRequest.projectName;
    if (!projectName) {
      throw new Error('[withTorEmbeddedIOS] could not resolve iOS projectName for the bridging header build setting.');
    }
    const xcodeProject = config.modResults;
    const headerRelative = `"${projectName}/${projectName}-Bridging-Header.h"`;
    const firstTarget = xcodeProject.getFirstTarget().firstTarget;
    const configList = xcodeProject.pbxXCConfigurationList()[firstTarget.buildConfigurationList];
    const buildConfigs = xcodeProject.pbxXCBuildConfigurationSection();
    let touched = 0;
    for (const ref of configList.buildConfigurations) {
      const buildSettings = buildConfigs[ref.value] && buildConfigs[ref.value].buildSettings;
      if (!buildSettings) continue;
      buildSettings.SWIFT_OBJC_BRIDGING_HEADER = headerRelative;
      touched += 1;
    }
    if (touched === 0) {
      throw new Error('[withTorEmbeddedIOS] failed to set SWIFT_OBJC_BRIDGING_HEADER: no build configurations found.');
    }
    return config;
  });
}

// ── 3. Native sources ──────────────────────────────────────────────────────

const BRIDGE_H = `#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Thin Objective-C wrapper around Tor.framework (TORThread/TORConfiguration/
 * TORController). Isolated here so every call site uses the framework's
 * EXACT documented Objective-C selectors — no Swift Clang-importer name
 * inference to get wrong sight-unseen. AegisTor.swift only talks to this
 * class, via names this header pins with NS_SWIFT_NAME.
 */
@interface AegisTorBridge : NSObject

@property (nonatomic, readonly) BOOL isRunning;

/**
 * Starts Tor bound to 127.0.0.1:socksPort and resolves once a circuit is
 * established (fully bootstrapped). Resolves immediately when already
 * running. Safe to re-call after a FAILED/timed-out attempt: it re-attaches
 * to the in-process Tor that is still bootstrapping natively - C-Tor cannot
 * restart in-process, and allocating a second TORThread aborts the whole app
 * (SIGABRT) - so this class never creates more than one thread per process.
 * Concurrent calls are not supported (the Swift layer coalesces them); a
 * second call while one is in flight fails fast with a typed error.
 */
/**
 * \`progress\` fires repeatedly with Tor's own control-port BOOTSTRAP status
 * events (0-100, plus Tor's summary string e.g. "Loading relay descriptors")
 * while starting - the only way to see WHERE a slow or stuck bootstrap is
 * actually spending its time instead of just waiting on a black-box promise.
 */
- (void)startWithSocksPort:(NSInteger)socksPort
                   progress:(void (^)(NSInteger percent, NSString * _Nullable summary))progress
                 completion:(void (^)(BOOL success, NSInteger socksPort, NSError * _Nullable error))completion
    NS_SWIFT_NAME(start(socksPort:progress:completion:));

/**
 * Best-effort stop. Tor.framework/tor does not support a fully clean,
 * restartable in-process shutdown (known upstream limitation - embedded tor
 * is designed to run for the process lifetime); this disconnects the
 * control channel and cancels the Tor thread, but the SOCKS listener may
 * linger until the app actually exits. Always calls completion.
 */
- (void)stopWithCompletion:(void (^)(void))completion
    NS_SWIFT_NAME(stop(completion:));

/**
 * Bridge torrc lines ("Key value", built by torBridges.ts torrcFor and
 * re-checked in Swift). Applied live when the control connection is
 * authenticated, or right after it authenticates on a cold start, with Tor
 * Browser's pattern: DisableNetwork 1, swap the bridge config, DisableNetwork 0.
 * That restarts a bootstrap stuck on the old transport. The network is always
 * re-enabled.
 */
- (void)applyConfLines:(NSArray<NSString *> *)lines
            completion:(void (^)(BOOL success, NSError * _Nullable error))completion
    NS_SWIFT_NAME(applyConf(lines:completion:));

@end

NS_ASSUME_NONNULL_END
`;

const BRIDGE_M = `#import "AegisTorBridge.h"
// No umbrella "Tor/Tor.h" - it doesn't exist. At pod version 409.11.1 (branch
// pure_pod, confirmed against the actual repo tree) TORThread/TORConfiguration/
// TORController are plain Objective-C SOURCE FILES the "Tor" pod compiles
// directly (Tor/Classes/Core/**, Tor/Classes/CTor/**), not headers inside the
// vendored tor.xcframework (that xcframework is just the low-level C-Tor
// binary those classes link against internally) - each class gets its own
// CocoaPods-generated public header, imported individually below. Confirmed
// build fa12407e/9ddde5c7: "'Tor/Tor.h' file not found... Did not find header
// 'Tor.h' in framework 'Tor' (loaded from '.../XCFrameworkIntermediates/Tor/CTor')".
#import <Tor/TORThread.h>
#import <Tor/TORConfiguration.h>
#import <Tor/TORController.h>

@interface AegisTorBridge ()
@property (nonatomic, strong, nullable) TORThread *torThread;
@property (nonatomic, strong, nullable) TORController *torController;
@property (nonatomic, strong, nullable) TORConfiguration *torConfiguration;
@property (nonatomic, assign) BOOL running;
// True once AUTHENTICATE succeeded on the current control connection - a
// re-attach attempt must NOT re-AUTHENTICATE (tor rejects a second one on the
// same connection) and skips straight to waiting on the circuit observer.
@property (nonatomic, assign) BOOL controllerAuthed;
@property (nonatomic, copy, nullable) NSArray<NSString *> *pendingConfLines;
// SETEVENTS observers are per control connection and must be registered once.
@property (nonatomic, assign) BOOL observersAdded;
@property (nonatomic, assign) NSInteger boundSocksPort;
// Monotonic id of the CURRENT start attempt. Async callbacks (watchdogs,
// retry/poll loops) capture the generation that armed them and become inert
// when a newer attempt supersedes them - so a stale 60s watchdog from an
// abandoned attempt can never fail a later, healthy one.
@property (nonatomic, assign) NSInteger attemptGeneration;
@property (nonatomic, copy, nullable) void (^progressBlock)(NSInteger, NSString * _Nullable);
// The in-flight attempt's completion. One-shot: consumed via settleWithSuccess.
@property (nonatomic, copy, nullable) void (^pendingCompletion)(BOOL, NSInteger, NSError * _Nullable);
@end

@implementation AegisTorBridge

- (BOOL)isRunning {
  return self.running;
}

/// GeoIP.bundle comes from the "Tor/GeoIP" podspec subspec (Podfile). Not
/// strictly documented as required, but the pod maintainer's own reference
/// integration (github.com/tladesignz/TorManager) always sets it, and
/// omitting it was one of several differences from that reference when our
/// own first attempt never got Tor to open its control port at all.
- (nullable NSURL *)geoipFileNamed:(NSString *)name {
  NSString *bundlePath = [[NSBundle mainBundle] pathForResource:@"GeoIP" ofType:@"bundle"];
  if (!bundlePath) return nil;
  NSBundle *geoBundle = [NSBundle bundleWithPath:bundlePath];
  NSString *filePath = [geoBundle pathForResource:name ofType:nil];
  return filePath ? [NSURL fileURLWithPath:filePath] : nil;
}

/**
 * One-shot resolution of the in-flight start attempt. \`generation\` guards
 * stale async callbacks (watchdogs, retry loops) of an ABANDONED attempt from
 * settling a LATER one: only callbacks armed by the current attempt may
 * settle it. Pass 0 to bypass the guard (circuit observer, stop()): whatever
 * attempt is pending when Tor actually comes up deserves the resolution.
 */
- (void)settleWithSuccess:(BOOL)success error:(NSError * _Nullable)error generation:(NSInteger)generation {
  if (generation != 0 && generation != self.attemptGeneration) return;
  void (^completion)(BOOL, NSInteger, NSError * _Nullable) = self.pendingCompletion;
  if (!completion) return;
  self.pendingCompletion = nil;
  completion(success, success ? self.boundSocksPort : 0, error);
}

- (void)startWithSocksPort:(NSInteger)socksPort
                   progress:(void (^)(NSInteger, NSString * _Nullable))progress
                 completion:(void (^)(BOOL, NSInteger, NSError * _Nullable))completion
{
  if (self.running) {
    completion(YES, socksPort, nil);
    return;
  }
  if (self.pendingCompletion) {
    // One attempt at a time. The Swift layer already coalesces concurrent JS
    // callers into a single bridge call; this guard is belt-and-braces so a
    // second in-flight attempt can never race the first one's state machine.
    completion(NO, 0, [NSError errorWithDomain:@"AegisTor" code:10
      userInfo:@{NSLocalizedDescriptionKey: @"a Tor start attempt is already in flight"}]);
    return;
  }
  self.boundSocksPort = socksPort;
  self.progressBlock = progress;
  self.pendingCompletion = completion;
  self.attemptGeneration += 1;
  NSInteger gen = self.attemptGeneration;

  // C-Tor runs ONCE per process (upstream limitation: embedded tor has no
  // clean in-process restart). Allocating a SECOND TORThread while one exists
  // aborts the whole app: tor's global state is not re-entrant, so instance
  // #2 hits a fatal assertion / data-directory lock and calls abort() -
  // confirmed in a production .ips (SIGABRT, TWO "Tor" threads, ~90s after
  // launch: the JS bootstrap timeout triggered a retry while the first
  // bootstrap was still in flight and running was still NO). If a thread
  // already exists we RE-ATTACH to it - fresh control-port poll, connect/auth
  // only if not already done - and NEVER create another thread.
  if (self.torThread) {
    [self pollForControlPortFile:self.torConfiguration socksPort:socksPort generation:gen attempt:0];
    return;
  }

  TORConfiguration *configuration = [TORConfiguration new];
  configuration.ignoreMissingTorrc = YES;
  configuration.cookieAuthentication = YES;
  // Let Tor pick and announce its own control port (writes it to
  // controlPortFile once its control listener is up), instead of us dictating
  // a controlSocket path - matches the pod maintainer's own TorManager
  // reference, which is what actually gets Tor to open a control port.
  configuration.autoControlPort = YES;
  // avoidDiskWrites=YES + a tmp-dir dataDirectory means Tor can NEVER cache
  // the consensus/descriptors it downloads, so every single launch pays the
  // full cold-bootstrap cost (fetch consensus + enough relay descriptors to
  // build a circuit) from scratch. On mobile networks that routinely exceeds
  // the JS-side 45s timeout (tor.ts BOOTSTRAP_TIMEOUT_MS) - "tor bootstrap
  // timed out" is that timer firing, not a hang. Persist the cache instead:
  // this is Tor's own public network directory data (same for every client
  // on earth), not user metadata, so caching it doesn't touch the
  // cero-metadatos rule.
  configuration.avoidDiskWrites = NO;
  configuration.geoipFile = [self geoipFileNamed:@"geoip"];
  configuration.geoip6File = [self geoipFileNamed:@"geoip6"];
  NSArray<NSURL *> *appSupportDirs = [[NSFileManager defaultManager]
    URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask];
  NSURL *dataDir = [appSupportDirs.firstObject URLByAppendingPathComponent:@"aegistor"];
  NSError *dirError = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtURL:dataDir
                                 withIntermediateDirectories:YES
                                                  attributes:nil
                                                       error:&dirError]) {
    [self settleWithSuccess:NO error:dirError generation:gen];
    return;
  }
  // Non-user data (Tor's public network cache), regenerable, and can be
  // sizeable (several MB) - exclude it from iCloud/iTunes device backups.
  NSError *excludeError = nil;
  [dataDir setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&excludeError];
  configuration.dataDirectory = dataDir;
  configuration.socksURL = [NSURL URLWithString:
    [NSString stringWithFormat:@"socks5://127.0.0.1:%ld", (long)socksPort]];
  self.torConfiguration = configuration;

  // Making dataDirectory persistent (for the consensus cache) had a nasty
  // side effect confirmed on-device (build d90a2da, "Connection refused"
  // after all 8 connect retries): controlPortFile and control_auth_cookie
  // ALSO live inside dataDirectory (TORConfiguration.m hardcodes
  // dataDirectory/controlport and dataDirectory/control_auth_cookie), so a
  // STALE controlport file from the previous app launch survives - our
  // non-empty-content poll then "finds" it instantly and we dial the OLD
  // process's port, where nothing is listening anymore. Delete both before
  // starting the new Tor thread so the only controlport file we can ever
  // read is the one THIS Tor instance writes. (The consensus cache lives in
  // other files - cached-microdescs etc. - and is untouched.)
  [[NSFileManager defaultManager] removeItemAtURL:configuration.controlPortFile error:nil];
  [[NSFileManager defaultManager]
    removeItemAtURL:[dataDir URLByAppendingPathComponent:@"control_auth_cookie"] error:nil];

  TORThread *thread = [[TORThread alloc] initWithConfiguration:configuration];
  self.torThread = thread;
  [thread start];

  // controlPortFile only has real content once Tor's thread has bootstrapped
  // far enough to open its control listener - poll briefly rather than
  // guessing a fixed sleep.
  [self pollForControlPortFile:configuration socksPort:socksPort generation:gen attempt:0];
}

- (void)pollForControlPortFile:(TORConfiguration *)configuration
                      socksPort:(NSInteger)socksPort
                     generation:(NSInteger)gen
                        attempt:(NSInteger)attempt
{
  if (gen != self.attemptGeneration) return; // attempt superseded or stopped
  NSURL *cpf = configuration.controlPortFile;
  // Require non-empty content, not just existence: Tor may create the file
  // before it has finished writing "PORT=host:port" to it, and reading an
  // empty/partial file here was very likely the cause of the "Connection
  // refused" we saw next - initWithControlPortFile: would parse garbage/no
  // address and connect: would (correctly) fail against nothing listening.
  NSDictionary<NSFileAttributeKey, id> *attrs = cpf ? [[NSFileManager defaultManager] attributesOfItemAtPath:cpf.path error:nil] : nil;
  NSNumber *fileSize = attrs[NSFileSize];
  if (fileSize && fileSize.unsignedLongLongValue > 0) {
    [self connectAndAuthenticate:configuration socksPort:socksPort generation:gen connectAttempt:0];
    return;
  }
  if (attempt > 60) { // ~15s at 250ms
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:1
      userInfo:@{NSLocalizedDescriptionKey: @"control port file did not appear (Tor thread failed to start?)"}];
    [self settleWithSuccess:NO error:error generation:gen];
    return;
  }
  __weak typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakSelf pollForControlPortFile:configuration socksPort:socksPort generation:gen attempt:attempt + 1];
  });
}

/**
 * Parses "PORT=host:port" ourselves instead of trusting
 * -[TORController initWithControlPortFile:] to do it: that method validates
 * its own file read with NSAssert, which is compiled to a no-op in Release
 * builds (this one is) - if ITS internal read ever silently failed, it
 * would fall through to a nil host with no crash and no signal, landing
 * connect: on the "no host/port configured" branch, which returns NO
 * without ever populating *error* - exactly the symptom we saw (connect:
 * failing 8/8 retries with error=nil, despite the file content being
 * perfectly well-formed when WE read it independently for diagnostics).
 */
- (nullable TORController *)controllerFromControlPortFile:(NSURL *)file error:(NSError **)error {
  NSString *content = [NSString stringWithContentsOfURL:file encoding:NSUTF8StringEncoding error:error];
  if (!content) return nil;
  NSString *afterEquals = [content componentsSeparatedByString:@"="].lastObject;
  NSString *trimmed = [afterEquals stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSArray<NSString *> *parts = [trimmed componentsSeparatedByString:@":"];
  NSString *host = parts.firstObject;
  NSString *portStr = parts.count > 1 ? parts.lastObject : nil;
  if (host.length == 0 || portStr.length == 0) {
    if (error) {
      *error = [NSError errorWithDomain:@"AegisTor" code:6 userInfo:@{NSLocalizedDescriptionKey:
        [NSString stringWithFormat:@"could not parse control port file content: %@", content]}];
    }
    return nil;
  }
  return [[TORController alloc] initWithSocketHost:host port:(in_port_t)portStr.integerValue];
}

- (void)connectAndAuthenticate:(TORConfiguration *)configuration
                      socksPort:(NSInteger)socksPort
                     generation:(NSInteger)gen
                 connectAttempt:(NSInteger)connectAttempt
{
  if (gen != self.attemptGeneration) return; // attempt superseded or stopped
  // Reuse the same controller across retries (built once on attempt 0) -
  // -initWithSocketHost:port:'s own internal connect attempt already fired
  // when it was constructed, so re-parsing the file and re-constructing on
  // every retry would just repeat that same first, possibly-too-early
  // attempt instead of giving Tor's listener more time to come up.
  TORController *controller = self.torController;
  if (!controller) {
    NSError *parseError = nil;
    controller = [self controllerFromControlPortFile:configuration.controlPortFile error:&parseError];
    if (!controller) {
      [self settleWithSuccess:NO error:parseError generation:gen];
      return;
    }
    self.torController = controller;
  }

  if (!controller.isConnected) {
    // Confirmed on-device (build 5df035c): this branch DOES fire - the
    // control-port-file can have valid, well-formed content before Tor's
    // control listener is actually accept()-ready, so the very first
    // connect() attempt (the one -initWithSocketHost:port: fired internally,
    // silently, with error:nil) can lose that race and fail. It is safe to
    // call connect: again HERE, unlike calling it a second time right after
    // construction: connect: opens with "if (_channel) return NO;", and
    // _channel is still nil (that first internal attempt failed) - so this
    // is a genuine retry, not a no-op collision with an already-successful
    // channel. It also finally gives us Tor's own real NSError instead of a
    // fabricated one, once retries are exhausted.
    NSError *connectError = nil;
    if (![controller connect:&connectError]) {
      if (connectAttempt < 8) { // ~2s at 250ms
        __weak typeof(self) weakSelf = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
          [weakSelf connectAndAuthenticate:configuration socksPort:socksPort generation:gen
                             connectAttempt:connectAttempt + 1];
        });
        return;
      }
      NSError *finalError = connectError ?: [NSError errorWithDomain:@"AegisTor" code:7 userInfo:@{NSLocalizedDescriptionKey:
        @"control socket failed to connect after 8 retries (connect() or dispatch_io_create failed "
        @"inside TORController.m connect:) - Tor.framework returned no further error detail"}];
      [self settleWithSuccess:NO error:finalError generation:gen];
      return;
    }
  }

  if (self.controllerAuthed) {
    // Re-attach fast path: a previous attempt already authenticated this
    // control connection (tor rejects a second AUTHENTICATE) and registered
    // the observers. The circuit-established observer settles the pending
    // attempt the moment Tor is usable - just re-arm the bounded wait.
    [self armCircuitWatchdogForGeneration:gen];
    return;
  }

  NSData *cookie = configuration.cookie;
  if (!cookie) {
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:2
      userInfo:@{NSLocalizedDescriptionKey: @"no Tor control-port auth cookie (configuration.cookie was nil)"}];
    [self settleWithSuccess:NO error:error generation:gen];
    return;
  }
  if (cookie.length != 32) {
    // Tor's control-auth-cookie is always exactly 32 bytes - a different
    // length means we read the file mid-write (same class of race as the
    // control-port-file one, just for the cookie file this time).
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:4
      userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:
        @"auth cookie has wrong length: %lu bytes (expected 32) - read mid-write?", (unsigned long)cookie.length]}];
    [self settleWithSuccess:NO error:error generation:gen];
    return;
  }

  // Per-stage watchdogs, ported from Onion Browser's own hand-rolled
  // control-port client (github.com/OnionBrowser/OnionBrowser - the only
  // shipping iOS app that embeds Tor directly and treats it as reliable
  // enough for production): it NEVER trusts a single async completion
  // callback to fire, wrapping every stage (connect/authenticate/bootstrap-
  // poll/heartbeat) in its own short NSTimer that assumes failure and
  // force-retries/reports if the expected response doesn't arrive. We
  // already hit exactly this failure class once (sendCommand:'s silent
  // "if (!_channel) { return; }" no-op leaving authenticateWithData:'s
  // completion block never called) - the isConnected check above covers
  // ONE way into that hang, but not every way a Tor.framework callback
  // could go silent. settleWithSuccess is one-shot and generation-guarded,
  // so a watchdog firing late (or a real callback arriving after its
  // watchdog) is inert instead of double-completing.
  __weak typeof(self) weakSelf = self;

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    typeof(self) strongSelf = weakSelf;
    if (!strongSelf) return;
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:8 userInfo:@{NSLocalizedDescriptionKey:
      @"authenticateWithData: watchdog: no completion callback within 15s (Tor.framework went silent - "
      @"see the Onion Browser control-port watchdog pattern this guards against)"}];
    [strongSelf settleWithSuccess:NO error:error generation:gen];
  });

  [controller authenticateWithData:cookie completion:^(BOOL success, NSError * _Nullable error) {
    typeof(self) strongSelf = weakSelf;
    if (!strongSelf) return;
    if (!success) {
      NSError *finalError = error ?: [NSError errorWithDomain:@"AegisTor" code:5
        userInfo:@{NSLocalizedDescriptionKey: @"authenticateWithData: failed (Tor.framework returned no error detail)"}];
      [strongSelf settleWithSuccess:NO error:finalError generation:gen];
      return;
    }
    // Record the auth UNCONDITIONALLY - even when the watchdog above already
    // failed this attempt, the control connection IS authenticated now, and
    // the next start() must take the re-attach fast path instead of sending
    // a second AUTHENTICATE (which tor rejects).
    strongSelf.controllerAuthed = YES;
    [strongSelf sendPendingConfWithCompletion:nil];
    [strongSelf registerControlObservers];
    [strongSelf armCircuitWatchdogForGeneration:gen];
  }];
}

/**
 * SETEVENTS observers, registered ONCE per control connection: the bootstrap
 * progress forwarder, and the circuit-established observer - the ONLY place
 * \`running\` flips YES. The old code set \`running\` behind the per-attempt
 * watchdog guard, so a circuit that established AFTER the 60s watchdog left
 * \`running\` NO forever - and the next start() call, seeing !running, would
 * allocate the second TORThread that aborts the process. Here the flip is
 * unconditional, and the settle is one-shot: whatever attempt is pending
 * when the circuit lands gets the success (generation 0 = bypass).
 */
- (void)registerControlObservers {
  if (self.observersAdded || !self.torController) return;
  self.observersAdded = YES;
  __weak typeof(self) weakSelf = self;
  // Only an AUTHENTICATE'd control connection is allowed to SETEVENTS - the
  // caller invokes this right after authenticateWithData: succeeds. This is
  // our only window into WHERE a slow/stuck bootstrap is spending its time
  // (0%? stuck fetching consensus? stuck building circuits at 100%?).
  [self.torController addObserverForStatusEvents:
    ^BOOL(NSString * _Nonnull type, NSString * _Nonnull severity,
          NSString * _Nonnull action, NSDictionary<NSString *, NSString *> * _Nonnull arguments) {
    typeof(self) strongSelf = weakSelf;
    if ([type isEqualToString:@"STATUS_CLIENT"] && [action isEqualToString:@"BOOTSTRAP"]) {
      NSInteger percent = [arguments[@"PROGRESS"] integerValue];
      NSString *summary = arguments[@"SUMMARY"] ?: @"";
      NSLog(@"[AegisTor] bootstrap %ld%% - %@", (long)percent, summary);
      if (strongSelf && strongSelf.progressBlock) strongSelf.progressBlock(percent, summary);
    } else {
      NSLog(@"[AegisTor] status type=%@ severity=%@ action=%@ args=%@", type, severity, action, arguments);
    }
    return YES;
  }];

  [self.torController addObserverForCircuitEstablished:^(BOOL established) {
    if (!established) return;
    typeof(self) strongSelf = weakSelf;
    if (!strongSelf) return;
    strongSelf.running = YES; // ALWAYS - see method doc above
    [strongSelf settleWithSuccess:YES error:nil generation:0];
  }];
}

/** Bounded wait for the circuit observer to settle the current attempt. */
- (void)armCircuitWatchdogForGeneration:(NSInteger)gen {
  __weak typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    typeof(self) strongSelf = weakSelf;
    if (!strongSelf || strongSelf.running) return;
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:9 userInfo:@{NSLocalizedDescriptionKey:
      @"no circuit established within 60s - Tor keeps bootstrapping natively; "
      @"the next start() re-attaches to the same in-process Tor instead of spawning a second one"}];
    [strongSelf settleWithSuccess:NO error:error generation:gen];
  });
}

- (void)applyConfLines:(NSArray<NSString *> *)lines
            completion:(void (^)(BOOL, NSError * _Nullable))completion
{
  self.pendingConfLines = lines;
  if (!self.controllerAuthed || !self.torController) {
    completion(YES, nil); // applied right after AUTHENTICATE (connectAndAuthenticate)
    return;
  }
  [self sendPendingConfWithCompletion:completion];
}

- (void)sendPendingConfWithCompletion:(nullable void (^)(BOOL, NSError * _Nullable))completion
{
  NSArray<NSString *> *lines = self.pendingConfLines;
  TORController *ctl = self.torController;
  if (lines.count == 0 || !ctl) {
    if (completion) completion(YES, nil);
    return;
  }
  // Tor.framework's setConfs sends values verbatim: the caller quotes them. The
  // lines were validated to contain no quote/backslash/control character, so
  // wrapping them in quotes (0x22) is safe.
  NSMutableArray<NSDictionary<NSString *, NSString *> *> *confs = [NSMutableArray array];
  for (NSString *line in lines) {
    NSRange sp = [line rangeOfString:@" "];
    if (sp.location == NSNotFound) continue;
    NSString *value = [NSString stringWithFormat:@"%C%@%C", (unichar)0x22, [line substringFromIndex:sp.location + 1], (unichar)0x22];
    [confs addObject:@{@"key": [line substringToIndex:sp.location], @"value": value}];
  }
  [confs addObject:@{@"key": @"DisableNetwork", @"value": @"0"}];
  [ctl setConfs:@[@{@"key": @"DisableNetwork", @"value": @"1"}] completion:^(BOOL pausedOk, NSError * _Nullable pauseError) {
    [ctl setConfs:confs completion:^(BOOL ok, NSError * _Nullable error) {
      if (!ok) {
        // Never leave the network paused.
        [ctl setConfs:@[@{@"key": @"DisableNetwork", @"value": @"0"}] completion:nil];
      }
      if (completion) completion(ok, error ?: pauseError);
    }];
  }];
}

- (void)stopWithCompletion:(void (^)(void))completion
{
  // Abandon any in-flight attempt: bump the generation so its async
  // callbacks turn inert, and fail its caller now (generation 0 = bypass).
  self.attemptGeneration += 1;
  [self settleWithSuccess:NO error:[NSError errorWithDomain:@"AegisTor" code:11
    userInfo:@{NSLocalizedDescriptionKey: @"stopped"}] generation:0];
  [self.torController disconnect];
  [self.torThread cancel];
  self.torController = nil;
  self.controllerAuthed = NO;
  self.observersAdded = NO;
  self.running = NO;
  // self.torThread is DELIBERATELY kept: C-Tor cannot restart in-process
  // (header doc), and nil-ing the pointer would let a later start() allocate
  // the second TORThread that aborts the app.
  completion();
}

@end
`;

const SWIFT_SOURCE = `import Foundation
import CFNetwork
import IPtProxy

/// Pluggable-transport events (IPtProxy). Nothing is logged: transport logs
/// would be connection metadata.
final class AegisPtEvents: NSObject, IPtProxyOnTransportEventsProtocol {
  func stopped(_ name: String?, error: (any Error)?) {}
  func connected(_ name: String?) {}
  func error(_ name: String?, error: (any Error)?) {}
}

/**
 * ObjC-visible sink AegisTor.m (the real RCTEventEmitter subclass) conforms
 * to, so this plain-NSObject Swift class can emit RN events without itself
 * needing to see RCTEventEmitter (see the plugin file's bridging-header
 * comment for why that type isn't visible to Swift in this project).
 */
@objc protocol AegisTorEventSink: AnyObject {
  func aegisTorEmit(_ name: String, body: Any)
}

/**
 * AegisTorLogic — embedded Tor (Fase 4 Tier 2, iOS) business logic. Same
 * public surface as the Android Kotlin module (AegisTorModule.kt via
 * withTorEmbedded.js) so mobile/src/net/tor.ts drives both platforms
 * unchanged - AegisTor.m (Objective-C) is the actual RN native module and
 * RCTEventEmitter subclass; every RN-facing method here is called by that
 * thin ObjC forwarder. See docs/FASE4-TOR-IOS-DESIGN.md.
 *
 *   F1: Tor lifecycle, delegated to AegisTorBridge (Tor.framework).
 *   F2: a DUMB socket.io-over-SOCKS pipe, hand-rolled on top of
 *       URLSessionWebSocketTask + connectionProxyDictionary (proven to route
 *       through a SOCKS5 proxy by the F2 spike) — see the plugin file's
 *       top-of-file comment for why this doesn't use socket.io-client-swift.
 *       Protocol: engine.io v4 (open=0/close=1/ping=2/pong=3/message=4) +
 *       socket.io v5 (CONNECT=0/DISCONNECT=1/EVENT=2/ACK=3/CONNECT_ERROR=4),
 *       default namespace "/" only (no namespace prefix on the wire).
 */
@objc(AegisTorLogic)
class AegisTorLogic: NSObject {

  @objc weak var eventSink: AegisTorEventSink?

  private let bridge = AegisTorBridge()
  private var state: String = "off"
  // Tor.framework doesn't report back which port it actually bound (we tell
  // it which one to use) - fixed, unlikely to collide since it's inside this
  // app's own sandboxed process.
  private let socksPort = 39_050
  private var hasListeners = false
  private var pendingStartResolvers: [(RCTPromiseResolveBlock, RCTPromiseRejectBlock)] = []

  // ── F2 per-socket state, keyed by the JS-supplied id ──────────────────────
  private var sessions: [String: URLSession] = [:]
  private var tasks: [String: URLSessionWebSocketTask] = [:]
  private var forwardEvents: [String: Set<String>] = [:]
  private var authPayloads: [String: String] = [:]
  private var ackCounters: [String: Int] = [:]
  // wire numeric ack id -> the JS-supplied ack id string (mirrors Android's
  // use of the JS ackId only to route the callback, not as the wire number).
  private var pendingAcks: [String: [Int: String]] = [:]

  @objc(setHasListeners:)
  func setHasListeners(_ value: Bool) { hasListeners = value }

  private func emitStatus() {
    guard hasListeners else { return }
    eventSink?.aegisTorEmit("AegisTorStatus", body: ["state": state, "socksPort": state == "on" ? socksPort : 0])
  }

  private func emitBootstrapProgress(_ percent: Int, _ summary: String?) {
    guard hasListeners else { return }
    eventSink?.aegisTorEmit("AegisTorBootstrapProgress", body: ["progress": percent, "summary": summary ?? ""])
  }

  private func makeStatus() -> [String: Any] {
    return ["state": state, "socksPort": state == "on" ? socksPort : 0]
  }

  // ── Bridges / pluggable transports (mobile/src/net/torBridges.ts) ──────
  private let ptEvents = AegisPtEvents()
  private lazy var ptController: IPtProxyController? = {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first!.appendingPathComponent("pt_state")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return IPtProxyController(dir.path, enableLogging: false, unsafeLogging: false,
                              logLevel: "ERROR", transportEvents: ptEvents)
  }()
  private let allowedPts: Set<String> = ["obfs4", "webtunnel", "snowflake", "meek_lite"]
  private let allowedConfKeys: Set<String> = ["UseBridges", "Bridge", "ClientTransportPlugin"]

  /// Start the listed transports (idempotent); resolves {pt: localSocksPort}.
  @objc(startTransports:resolver:rejecter:)
  func startTransports(_ ptsJson: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let data = ptsJson.data(using: .utf8),
          let names = (try? JSONSerialization.jsonObject(with: data)) as? [String] else {
      reject("E_PT", "invalid transport list", nil)
      return
    }
    guard let c = ptController else {
      reject("E_PT", "pluggable transports unavailable", nil)
      return
    }
    var out: [String: Int] = [:]
    for name in names {
      guard allowedPts.contains(name) else { reject("E_PT", "unsupported transport", nil); return }
      do { try c.start(name, proxy: nil) } catch { reject("E_PT", error.localizedDescription, error); return }
      let port = c.port(name)
      guard port > 0 else { reject("E_PT", "transport did not start", nil); return }
      out[name] = port
    }
    resolve(out)
  }

  /// A line is applied only if it is one of the three bridge keys and cannot
  /// break out of a torrc value (same allow-list as Android).
  private func isSafeConfLine(_ l: String) -> Bool {
    if l.count > 1600 { return false }
    for u in l.unicodeScalars where u.value < 0x20 || u.value == 0x7f || u.value == 0x22 || u.value == 0x23 || u.value == 0x5c {
      return false
    }
    guard let sp = l.firstIndex(of: " ") else { return false }
    return allowedConfKeys.contains(String(l[l.startIndex..<sp]))
  }

  /// Use these torrc lines for bridges (applied live, or right after the
  /// control connection authenticates on a cold start).
  @objc(setTorConfig:resolver:rejecter:)
  func setTorConfig(_ linesJson: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let data = linesJson.data(using: .utf8),
          let lines = (try? JSONSerialization.jsonObject(with: data)) as? [String],
          lines.allSatisfy({ isSafeConfLine($0) }) else {
      reject("E_TOR_CONFIG", "rejected torrc line", nil)
      return
    }
    bridge.applyConf(lines: lines) { ok, error in
      if ok { resolve(true) } else { reject("E_TOR_CONFIG", error?.localizedDescription ?? "setconf failed", error) }
    }
  }

  // ── F1: lifecycle ──────────────────────────────────────────────────────

  @objc(start:rejecter:)
  func start(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if state == "on" {
      resolve(makeStatus())
      return
    }
    pendingStartResolvers.append((resolve, reject))
    if state == "starting" { return }
    state = "starting"
    emitStatus()

    bridge.start(socksPort: socksPort, progress: { [weak self] percent, summary in
      DispatchQueue.main.async { self?.emitBootstrapProgress(percent, summary) }
    }) { [weak self] success, port, error in
      guard let self = self else { return }
      DispatchQueue.main.async {
        let resolvers = self.pendingStartResolvers
        self.pendingStartResolvers = []
        if success {
          self.state = "on"
          self.emitStatus()
          for (res, _) in resolvers { res(self.makeStatus()) }
        } else {
          self.state = "off"
          self.emitStatus()
          let message = error?.localizedDescription ?? "Tor failed to start"
          for (_, rej) in resolvers { rej("E_TOR_START", message, error) }
        }
      }
    }
  }

  @objc(getStatus:rejecter:)
  func getStatus(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(makeStatus())
  }

  @objc(stop:rejecter:)
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    for id in Array(tasks.keys) { closeSocket(id, reason: "tor stopping") }
    bridge.stop { [weak self] in
      guard let self = self else { return }
      DispatchQueue.main.async {
        self.state = "off"
        self.emitStatus()
        resolve(true)
      }
    }
  }

  // ── F2: socket.io-over-SOCKS dumb pipe ─────────────────────────────────

  /// Circuit isolation (Tor always-on). The control lane (aegisId identity
  /// socket, relay HTTP) and the mailbox lane (mailbox socket, /mailbox/* HTTP)
  /// must never share a Tor circuit. Otherwise a relay operator can join them
  /// through the onion service (HiddenServiceExportCircuitID) and relink the
  /// opaque mailbox id to the aegisId. Tor's SocksPort isolates streams by SOCKS
  /// credentials by default (IsolateSOCKSAuth), so each lane authenticates with
  /// its own username/password. These are not secrets: Tor accepts any value and
  /// uses them only to pick circuits. Desktop does the same with two listeners;
  /// Android with two SocksPorts (withTorEmbedded.js).
  private func torSessionConfiguration(lane: String) -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = [
      kCFStreamPropertySOCKSProxyHost as String: "127.0.0.1",
      kCFStreamPropertySOCKSProxyPort as String: socksPort,
      kCFStreamPropertySOCKSVersion as String: kCFStreamSocketSOCKSVersion5,
      kCFStreamPropertySOCKSUser as String: "aegis-" + lane,
      kCFStreamPropertySOCKSPassword as String: lane,
    ]
    return config
  }

  /// Socket lane from the JS bridge id: identity sockets are "ctl-…" (net/tor.ts).
  private func laneForSocket(_ id: String) -> String {
    return id.hasPrefix("ctl-") ? "control" : "mailbox"
  }

  /// HTTP lane from the URL: /mailbox/* (stateless drain, challenges) is the
  /// mailbox lane; everything else the control lane.
  private func laneForUrl(_ u: URL) -> String {
    return u.path.hasPrefix("/mailbox/") ? "mailbox" : "control"
  }

  /// http(s):// base URL -> the engine.io v4 WebSocket endpoint socket.io
  /// clients connect to (matches what socket.io-client-java/swift build
  /// internally, and what the F2 spike validated manually).
  private func webSocketURL(from baseUrl: String) -> URL? {
    guard var components = URLComponents(string: baseUrl) else { return nil }
    switch components.scheme {
    case "http": components.scheme = "ws"
    case "https": components.scheme = "wss"
    default: break // already ws/wss, or unknown - leave as-is
    }
    let existingPath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
    components.path = existingPath + "/socket.io/"
    components.query = "EIO=4&transport=websocket"
    return components.url
  }

  @objc(sioConnect:url:authJson:eventsJson:resolver:rejecter:)
  func sioConnect(
    _ id: String, url: String, authJson: String, eventsJson: String,
    resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard state == "on" else {
      reject("E_TOR_NOT_READY", "Tor is not on (state=\\(state))", nil)
      return
    }
    guard let wsUrl = webSocketURL(from: url) else {
      reject("E_SIO_CONNECT", "invalid url: \\(url)", nil)
      return
    }
    let eventNames: Set<String>
    if let data = eventsJson.data(using: .utf8),
       let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
      eventNames = Set(arr)
    } else {
      eventNames = []
    }

    let session = URLSession(configuration: torSessionConfiguration(lane: laneForSocket(id)))
    let task = session.webSocketTask(with: wsUrl)
    sessions[id] = session
    tasks[id] = task
    forwardEvents[id] = eventNames
    authPayloads[id] = authJson
    ackCounters[id] = 0
    pendingAcks[id] = [:]

    receiveLoop(id)
    task.resume()
    resolve(true)
  }

  private func receiveLoop(_ id: String) {
    guard let task = tasks[id] else { return }
    task.receive { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text):
          self.handleEngineIOFrame(id, text)
        case .data:
          break // engine.io text protocol only - the mailbox wire never sends binary frames
        @unknown default:
          break
        }
        self.receiveLoop(id) // keep listening
      case .failure(let error):
        self.forward(id, "connect_error", "[\\\"\\(self.jsonEscape(error.localizedDescription))\\\"]")
        self.closeSocket(id, reason: "receive failed")
      }
    }
  }

  private func jsonEscape(_ s: String) -> String {
    return s.replacingOccurrences(of: "\\\\", with: "\\\\\\\\").replacingOccurrences(of: "\\\"", with: "\\\\\\\"")
  }

  private func sendRaw(_ id: String, _ text: String) {
    tasks[id]?.send(.string(text)) { _ in /* best-effort, mirrors Android's fire-and-forget emit */ }
  }

  private func handleEngineIOFrame(_ id: String, _ text: String) {
    guard let first = text.first else { return }
    let rest = String(text.dropFirst())
    switch first {
    case "0": // open: {"sid":...,"pingInterval":...,"pingTimeout":...}
      sendRaw(id, "40" + (authPayloads[id] ?? "{}"))
    case "1": // close
      closeSocket(id, reason: "server closed (engine.io)")
    case "2": // ping from server -> pong back immediately
      sendRaw(id, "3")
    case "4": // message -> socket.io packet
      handleSocketIOPacket(id, rest)
    default:
      break // "3" pong / "5" upgrade / "6" noop - nothing to do
    }
  }

  private func splitLeadingDigits(_ s: Substring) -> (String, Substring) {
    var idx = s.startIndex
    while idx < s.endIndex, s[idx].isNumber { idx = s.index(after: idx) }
    return (String(s[s.startIndex..<idx]), s[idx...])
  }

  private func handleSocketIOPacket(_ id: String, _ text: String) {
    guard let first = text.first else { return }
    let rest = text.dropFirst()
    switch first {
    case "0": // CONNECT ack: {"sid":"..."}
      forward(id, "connect", "[]")
    case "1": // DISCONNECT
      forward(id, "disconnect", "[]")
      closeSocket(id, reason: "server disconnect (socket.io)")
    case "2": // EVENT: [ackId digits]["name", ...args]
      let (_, jsonPart) = splitLeadingDigits(rest)
      guard let data = jsonPart.data(using: .utf8),
            let arr = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [Any],
            let eventName = arr.first as? String else { return }
      guard forwardEvents[id]?.contains(eventName) == true else { return }
      let args = Array(arr.dropFirst())
      let argsJson = (try? JSONSerialization.data(withJSONObject: args, options: [.fragmentsAllowed]))
        .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
      forward(id, eventName, argsJson)
    case "3": // ACK reply to an event WE sent with an ackId
      let (ackIdStr, jsonPart) = splitLeadingDigits(rest)
      guard let wireAckId = Int(ackIdStr), let jsAckId = pendingAcks[id]?[wireAckId] else { return }
      pendingAcks[id]?.removeValue(forKey: wireAckId)
      let argsJson = String(jsonPart).isEmpty ? "[]" : String(jsonPart)
      forward(id, "__ack:\\(jsAckId)", argsJson)
    case "4": // CONNECT_ERROR
      forward(id, "connect_error", "[\\\"\\(jsonEscape(String(rest)))\\\"]")
    default:
      break
    }
  }

  private func forward(_ id: String, _ event: String, _ argsJson: String) {
    guard hasListeners else { return }
    eventSink?.aegisTorEmit("AegisTorSio", body: ["id": id, "event": event, "args": argsJson])
  }

  @objc(sioEmit:event:payloadJson:ackId:resolver:rejecter:)
  func sioEmit(
    _ id: String, event: String, payloadJson: String, ackId: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard tasks[id] != nil else {
      reject("E_SIO_NO_SOCKET", "no socket: \\(id)", nil)
      return
    }
    let payloadValue: Any
    if let data = payloadJson.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
      payloadValue = parsed
    } else {
      payloadValue = payloadJson
    }
    var ackPrefix = ""
    if let ackId = ackId {
      let wireId = (ackCounters[id] ?? 0)
      ackCounters[id] = wireId + 1
      pendingAcks[id, default: [:]][wireId] = ackId
      ackPrefix = "\\(wireId)"
    }
    let packetArray: [Any] = [event, payloadValue]
    guard let data = try? JSONSerialization.data(withJSONObject: packetArray, options: [.fragmentsAllowed]),
          let json = String(data: data, encoding: .utf8) else {
      reject("E_SIO_EMIT", "failed to encode payload", nil)
      return
    }
    sendRaw(id, "42" + ackPrefix + json)
    resolve(true)
  }

  @objc(sioDisconnect:resolver:rejecter:)
  func sioDisconnect(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    closeSocket(id, reason: "js requested disconnect")
    resolve(true)
  }

  // ── Slice 6 + federation F2: one-shot HTTP over Tor ─────────────────────────
  // Declared on the JS side (net/tor.ts) since #391 but never implemented here.
  // Same SOCKS-proxied URLSession the socket bridge uses. Resolves a JSON string
  // {"status":<int>,"body":"…"}; only a transport failure rejects.
  @objc
  func httpRequest(
    _ url: String, method: String, headersJson: String, body: String,
    resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard state == "on" else {
      reject("E_TOR_NOT_READY", "Tor is not on (state=\\(state))", nil)
      return
    }
    guard let u = URL(string: url) else {
      reject("E_HTTP_REQUEST", "invalid url: \\(url)", nil)
      return
    }
    var req = URLRequest(url: u)
    req.httpMethod = method.uppercased()
    req.timeoutInterval = 30
    var hasContentType = false
    if let data = headersJson.data(using: .utf8),
       let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
      for (k, v) in dict {
        if k.lowercased() == "content-type" { hasContentType = true }
        req.setValue(v, forHTTPHeaderField: k)
      }
    }
    // F5: a self-hosted home relay is reached ONLY this way — every verb the
    // relay API uses carries its (possibly empty) body except GET/HEAD.
    if req.httpMethod != "GET" && req.httpMethod != "HEAD" {
      if !hasContentType { req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type") }
      req.httpBody = body.data(using: .utf8)
    }
    let session = URLSession(configuration: torSessionConfiguration(lane: laneForUrl(u)))
    let task = session.dataTask(with: req) { data, response, error in
      defer { session.finishTasksAndInvalidate() }
      if let error = error {
        reject("E_HTTP_REQUEST", error.localizedDescription, error)
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      // Cap what we hand to JS — control-plane responses are small; blobs use httpDownload.
      let capped = (data ?? Data()).prefix(1024 * 1024)
      let text = String(data: capped, encoding: .utf8) ?? ""
      let out: [String: Any] = ["status": status, "body": text]
      if let json = try? JSONSerialization.data(withJSONObject: out),
         let str = String(data: json, encoding: .utf8) {
        resolve(str)
      } else {
        reject("E_HTTP_REQUEST", "encode failure", nil)
      }
    }
    task.resume()
  }

  // Federation F5: upload a file (E2EE blob ciphertext) over Tor to OUR
  // self-hosted relay — FileSystem.uploadAsync has no route to a .onion.
  // Resolves {"status":<int>,"body":"…"}; only a transport failure rejects.
  @objc
  func httpUpload(
    _ url: String, filePath: String, headersJson: String,
    resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard state == "on" else {
      reject("E_TOR_NOT_READY", "Tor is not on (state=\\(state))", nil)
      return
    }
    guard let u = URL(string: url) else {
      reject("E_HTTP_UPLOAD", "invalid url: \\(url)", nil)
      return
    }
    let src = URL(fileURLWithPath: filePath.hasPrefix("file://") ? String(filePath.dropFirst(7)) : filePath)
    guard FileManager.default.isReadableFile(atPath: src.path) else {
      reject("E_HTTP_UPLOAD", "file not found", nil)
      return
    }
    var req = URLRequest(url: u)
    req.httpMethod = "POST"
    req.timeoutInterval = 120
    var hasContentType = false
    if let data = headersJson.data(using: .utf8),
       let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
      for (k, v) in dict {
        if k.lowercased() == "content-type" { hasContentType = true }
        req.setValue(v, forHTTPHeaderField: k)
      }
    }
    if !hasContentType { req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type") }
    let session = URLSession(configuration: torSessionConfiguration(lane: laneForUrl(u)))
    let task = session.uploadTask(with: req, fromFile: src) { data, response, error in
      defer { session.finishTasksAndInvalidate() }
      if let error = error {
        reject("E_HTTP_UPLOAD", error.localizedDescription, error)
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let capped = (data ?? Data()).prefix(64 * 1024)
      let text = String(data: capped, encoding: .utf8) ?? ""
      let out: [String: Any] = ["status": status, "body": text]
      if let json = try? JSONSerialization.data(withJSONObject: out),
         let str = String(data: json, encoding: .utf8) {
        resolve(str)
      } else {
        reject("E_HTTP_UPLOAD", "encode failure", nil)
      }
    }
    task.resume()
  }

  // Federation F2: download a binary blob over Tor straight to a file (E2EE
  // attachments hosted on a contact's relay). Resolves {"status":<int>}; the
  // file exists only on 200.
  @objc
  func httpDownload(
    _ url: String, destPath: String, headersJson: String,
    resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard state == "on" else {
      reject("E_TOR_NOT_READY", "Tor is not on (state=\\(state))", nil)
      return
    }
    guard let u = URL(string: url) else {
      reject("E_HTTP_DOWNLOAD", "invalid url: \\(url)", nil)
      return
    }
    var req = URLRequest(url: u)
    req.httpMethod = "GET"
    req.timeoutInterval = 60
    if let data = headersJson.data(using: .utf8),
       let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
      for (k, v) in dict { req.setValue(v, forHTTPHeaderField: k) }
    }
    let dest = URL(fileURLWithPath: destPath.hasPrefix("file://") ? String(destPath.dropFirst(7)) : destPath)
    let session = URLSession(configuration: torSessionConfiguration(lane: laneForUrl(u)))
    let task = session.downloadTask(with: req) { tmp, response, error in
      defer { session.finishTasksAndInvalidate() }
      if let error = error {
        reject("E_HTTP_DOWNLOAD", error.localizedDescription, error)
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let fm = FileManager.default
      try? fm.removeItem(at: dest)
      if status == 200, let tmp = tmp {
        try? fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        do { try fm.moveItem(at: tmp, to: dest) } catch {
          reject("E_HTTP_DOWNLOAD", error.localizedDescription, error)
          return
        }
      }
      resolve("{\\"status\\":\\(status)}")
    }
    task.resume()
  }

  private func closeSocket(_ id: String, reason: String) {
    tasks[id]?.cancel(with: .goingAway, reason: nil)
    sessions[id]?.invalidateAndCancel()
    tasks.removeValue(forKey: id)
    sessions.removeValue(forKey: id)
    forwardEvents.removeValue(forKey: id)
    authPayloads.removeValue(forKey: id)
    ackCounters.removeValue(forKey: id)
    pendingAcks.removeValue(forKey: id)
  }
}
`;

const OBJC_BRIDGE_SOURCE = `#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import "AegisLink-Swift.h"

/**
 * AegisTor — the real RN native module (RCTEventEmitter subclass lives here
 * in Objective-C, not Swift: see the plugin file's bridging-header comment
 * for why - this project's prebuilt React-Core XCFramework's umbrella header
 * excludes RCTEventEmitter.h, so Swift can't see the type even with it
 * #imported in the bridging header, while plain ObjC textual import works
 * fine). Every method just forwards to AegisTorLogic (Swift, all the real
 * F1/F2 work), and relays its events via AegisTorEventSink.
 */
@interface AegisTor : RCTEventEmitter <RCTBridgeModule, AegisTorEventSink>
@property (nonatomic, strong) AegisTorLogic *logic;
@end

@implementation AegisTor

RCT_EXPORT_MODULE(AegisTor);

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _logic = [AegisTorLogic new];
    _logic.eventSink = self;
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"AegisTorStatus", @"AegisTorSio", @"AegisTorBootstrapProgress"];
}

- (void)startObserving {
  [self.logic setHasListeners:YES];
}

- (void)stopObserving {
  [self.logic setHasListeners:NO];
}

- (void)aegisTorEmit:(NSString *)name body:(id)body {
  [self sendEventWithName:name body:body];
}

RCT_EXPORT_METHOD(start:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic start:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(getStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic getStatus:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic stop:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(sioConnect:(NSString *)identifier
                  url:(NSString *)url
                  authJson:(NSString *)authJson
                  eventsJson:(NSString *)eventsJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic sioConnect:identifier url:url authJson:authJson eventsJson:eventsJson resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(sioEmit:(NSString *)identifier
                  event:(NSString *)event
                  payloadJson:(NSString *)payloadJson
                  ackId:(NSString *)ackId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic sioEmit:identifier event:event payloadJson:payloadJson ackId:ackId resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(startTransports:(NSString *)ptsJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic startTransports:ptsJson resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(setTorConfig:(NSString *)linesJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic setTorConfig:linesJson resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(sioDisconnect:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic sioDisconnect:identifier resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(httpRequest:(NSString *)url
                  method:(NSString *)method
                  headersJson:(NSString *)headersJson
                  body:(NSString *)body
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic httpRequest:url method:method headersJson:headersJson body:body resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(httpDownload:(NSString *)url
                  destPath:(NSString *)destPath
                  headersJson:(NSString *)headersJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic httpDownload:url destPath:destPath headersJson:headersJson resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(httpUpload:(NSString *)url
                  filePath:(NSString *)filePath
                  headersJson:(NSString *)headersJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic httpUpload:url filePath:filePath headersJson:headersJson resolver:resolve rejecter:reject];
}

@end
`;

function withTorNativeSources(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName;
      if (!projectName) {
        throw new Error('[withTorEmbeddedIOS] could not resolve iOS projectName for native sources.');
      }
      const dir = path.join(config.modRequest.platformProjectRoot, projectName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'AegisTorBridge.h'), BRIDGE_H);
      fs.writeFileSync(path.join(dir, 'AegisTorBridge.m'), BRIDGE_M);
      fs.writeFileSync(path.join(dir, 'AegisTorLogic.swift'), SWIFT_SOURCE);
      fs.writeFileSync(path.join(dir, 'AegisTor.m'), OBJC_BRIDGE_SOURCE);
      return config;
    },
  ]);
}

// ── 4. Register the new files in project.pbxproj ──────────────────────────
// Writing files to disk (step 3) is NOT enough - Xcode only compiles what's
// listed in the PBXSourcesBuildPhase (learned the hard way on the F2 spike,
// build 55cfc1db: succeeded but the module silently didn't exist at runtime).
function withTorXcodeProjectFiles(config) {
  return withXcodeProject(config, (config) => {
    const projectName = config.modRequest.projectName;
    if (!projectName) {
      throw new Error('[withTorEmbeddedIOS] could not resolve iOS projectName for pbxproj registration.');
    }
    const xcodeProject = config.modResults;
    const groupKey = xcodeProject.findPBXGroupKey({ name: projectName });
    if (!groupKey) {
      throw new Error(`[withTorEmbeddedIOS] could not find the "${projectName}" PBXGroup to attach source files to.`);
    }
    for (const file of ['AegisTorBridge.h', 'AegisTorBridge.m', 'AegisTorLogic.swift', 'AegisTor.m']) {
      const relPath = `${projectName}/${file}`;
      if (xcodeProject.hasFile(relPath)) continue;
      const added = xcodeProject.addSourceFile(relPath, {}, groupKey);
      if (!added) {
        throw new Error(`[withTorEmbeddedIOS] failed to register ${relPath} in project.pbxproj.`);
      }
    }
    return config;
  });
}

module.exports = function withTorEmbeddedIOS(config) {
  config = withTorPod(config);
  config = withTorBridgingHeaderFile(config);
  config = withTorBridgingHeaderSetting(config);
  config = withTorNativeSources(config);
  config = withTorXcodeProjectFiles(config);
  return config;
};
