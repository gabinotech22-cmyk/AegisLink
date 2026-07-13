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
    if (config.modResults.contents.includes("pod 'Tor/GeoIP'")) return config;
    // Insert right after the first `target '<name>' do` line (the app
    // target), matching the common community pattern for config-plugin
    // Podfile edits since @expo/config-plugins has no addPod() helper.
    const targetRe = /target ['"][^'"]+['"] do\n/;
    if (!targetRe.test(config.modResults.contents)) {
      throw new Error('[withTorEmbeddedIOS] could not find the app target block in the Podfile.');
    }
    config.modResults.contents = config.modResults.contents.replace(
      targetRe,
      (match) => `${match}  # AegisLink: embedded Tor (injected by withTorEmbeddedIOS.js)\n  pod 'Tor/GeoIP'\n`,
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
 * established (fully bootstrapped). Safe to call while already
 * running/starting - resolves immediately with the cached result.
 */
- (void)startWithSocksPort:(NSInteger)socksPort
                 completion:(void (^)(BOOL success, NSInteger socksPort, NSError * _Nullable error))completion
    NS_SWIFT_NAME(start(socksPort:completion:));

/**
 * Best-effort stop. Tor.framework/tor does not support a fully clean,
 * restartable in-process shutdown (known upstream limitation - embedded tor
 * is designed to run for the process lifetime); this disconnects the
 * control channel and cancels the Tor thread, but the SOCKS listener may
 * linger until the app actually exits. Always calls completion.
 */
- (void)stopWithCompletion:(void (^)(void))completion
    NS_SWIFT_NAME(stop(completion:));

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

- (void)startWithSocksPort:(NSInteger)socksPort
                 completion:(void (^)(BOOL, NSInteger, NSError * _Nullable))completion
{
  if (self.running) {
    completion(YES, socksPort, nil);
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
  configuration.avoidDiskWrites = YES;
  configuration.geoipFile = [self geoipFileNamed:@"geoip"];
  configuration.geoip6File = [self geoipFileNamed:@"geoip6"];
  NSURL *dataDir = [NSURL fileURLWithPath:
    [NSTemporaryDirectory() stringByAppendingPathComponent:@"aegistor"]];
  NSError *dirError = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtURL:dataDir
                                 withIntermediateDirectories:YES
                                                  attributes:nil
                                                       error:&dirError]) {
    completion(NO, 0, dirError);
    return;
  }
  configuration.dataDirectory = dataDir;
  configuration.socksURL = [NSURL URLWithString:
    [NSString stringWithFormat:@"socks5://127.0.0.1:%ld", (long)socksPort]];
  self.torConfiguration = configuration;

  TORThread *thread = [[TORThread alloc] initWithConfiguration:configuration];
  self.torThread = thread;
  [thread start];

  // controlPortFile only has real content once Tor's thread has bootstrapped
  // far enough to open its control listener - poll briefly rather than
  // guessing a fixed sleep.
  [self pollForControlPortFile:configuration socksPort:socksPort attempt:0 completion:completion];
}

- (void)pollForControlPortFile:(TORConfiguration *)configuration
                      socksPort:(NSInteger)socksPort
                        attempt:(NSInteger)attempt
                     completion:(void (^)(BOOL, NSInteger, NSError * _Nullable))completion
{
  NSURL *cpf = configuration.controlPortFile;
  // Require non-empty content, not just existence: Tor may create the file
  // before it has finished writing "PORT=host:port" to it, and reading an
  // empty/partial file here was very likely the cause of the "Connection
  // refused" we saw next - initWithControlPortFile: would parse garbage/no
  // address and connect: would (correctly) fail against nothing listening.
  NSDictionary<NSFileAttributeKey, id> *attrs = cpf ? [[NSFileManager defaultManager] attributesOfItemAtPath:cpf.path error:nil] : nil;
  NSNumber *fileSize = attrs[NSFileSize];
  if (fileSize && fileSize.unsignedLongLongValue > 0) {
    [self connectAndAuthenticate:configuration socksPort:socksPort connectAttempt:0 completion:completion];
    return;
  }
  if (attempt > 60) { // ~15s at 250ms
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:1
      userInfo:@{NSLocalizedDescriptionKey: @"control port file did not appear (Tor thread failed to start?)"}];
    completion(NO, 0, error);
    return;
  }
  __weak typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakSelf pollForControlPortFile:configuration socksPort:socksPort attempt:attempt + 1 completion:completion];
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
                 connectAttempt:(NSInteger)connectAttempt
                     completion:(void (^)(BOOL, NSInteger, NSError * _Nullable))completion
{
  NSError *parseError = nil;
  TORController *controller = [self controllerFromControlPortFile:configuration.controlPortFile error:&parseError];
  if (!controller) {
    completion(NO, 0, parseError);
    return;
  }
  self.torController = controller;

  NSError *connectError = nil;
  if (![controller connect:&connectError]) {
    // Belt-and-suspenders on top of the non-empty-file check above: the
    // file being fully written doesn't strictly guarantee the listener is
    // already accepting connections. Retry connect: itself briefly before
    // surfacing "Connection refused" to the caller.
    if (connectAttempt < 8) { // ~2s at 250ms
      __weak typeof(self) weakSelf = self;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [weakSelf connectAndAuthenticate:configuration socksPort:socksPort connectAttempt:connectAttempt + 1 completion:completion];
      });
      return;
    }
    // Diagnostic (build 7106c97): connect: fails all 8 retries with NO error
    // detail every time (not a plain "Connection refused" - that DID carry a
    // real NSError in an earlier test). That pattern fits a control-port-file
    // that is non-empty (passes our size>0 check) but INCOMPLETE/malformed -
    // Tor may write "PORT=127.0.0.1:" and the port digits in separate writes.
    // Dump the file's actual raw content into the error so we can see
    // exactly what Tor wrote instead of guessing again.
    NSError *readError = nil;
    NSString *rawContent = [NSString stringWithContentsOfURL:configuration.controlPortFile
                                                       encoding:NSUTF8StringEncoding
                                                          error:&readError];
    NSString *contentDesc = rawContent
      ? [NSString stringWithFormat:@"content=%@", rawContent]
      : [NSString stringWithFormat:@"unreadable (%@)", readError.localizedDescription ?: @"?"];
    NSString *baseMessage = connectError.localizedDescription ?: @"Tor.framework returned no error detail";
    NSError *finalError = [NSError errorWithDomain:@"AegisTor" code:3
      userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:
        @"connect: failed after retries: %@ | controlPortFile %@", baseMessage, contentDesc]}];
    completion(NO, 0, finalError);
    return;
  }

  NSData *cookie = configuration.cookie;
  if (!cookie) {
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:2
      userInfo:@{NSLocalizedDescriptionKey: @"no Tor control-port auth cookie (configuration.cookie was nil)"}];
    completion(NO, 0, error);
    return;
  }
  if (cookie.length != 32) {
    // Tor's control-auth-cookie is always exactly 32 bytes - a different
    // length means we read the file mid-write (same class of race as the
    // control-port-file one, just for the cookie file this time).
    NSError *error = [NSError errorWithDomain:@"AegisTor" code:4
      userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:
        @"auth cookie has wrong length: %lu bytes (expected 32) - read mid-write?", (unsigned long)cookie.length]}];
    completion(NO, 0, error);
    return;
  }

  __weak typeof(self) weakSelf = self;
  [controller authenticateWithData:cookie completion:^(BOOL success, NSError * _Nullable error) {
    if (!success) {
      NSError *finalError = error ?: [NSError errorWithDomain:@"AegisTor" code:5
        userInfo:@{NSLocalizedDescriptionKey: @"authenticateWithData: failed (Tor.framework returned no error detail)"}];
      completion(NO, 0, finalError);
      return;
    }
    [controller addObserverForCircuitEstablished:^(BOOL established) {
      if (!established) return;
      typeof(self) strongSelf = weakSelf;
      if (strongSelf) strongSelf.running = YES;
      completion(YES, socksPort, nil);
    }];
  }];
}

- (void)stopWithCompletion:(void (^)(void))completion
{
  [self.torController disconnect];
  [self.torThread cancel];
  self.torController = nil;
  self.running = NO;
  completion();
}

@end
`;

const SWIFT_SOURCE = `import Foundation
import CFNetwork

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

  private func makeStatus() -> [String: Any] {
    return ["state": state, "socksPort": state == "on" ? socksPort : 0]
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

    bridge.start(socksPort: socksPort) { [weak self] success, port, error in
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

  private func torSessionConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = [
      kCFStreamPropertySOCKSProxyHost as String: "127.0.0.1",
      kCFStreamPropertySOCKSProxyPort as String: socksPort,
      kCFStreamPropertySOCKSVersion as String: kCFStreamSocketSOCKSVersion5,
    ]
    return config
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

    let session = URLSession(configuration: torSessionConfiguration())
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
  return @[@"AegisTorStatus", @"AegisTorSio"];
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

RCT_EXPORT_METHOD(sioDisconnect:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.logic sioDisconnect:identifier resolver:resolve rejecter:reject];
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
