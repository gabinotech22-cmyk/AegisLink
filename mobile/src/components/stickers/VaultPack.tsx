/**
 * AegisLink Vault Pack v1 — 16 animated stickers
 *
 * Each sticker is a self-contained React Native Reanimated 3 component
 * that loops automatically. Sent as [sticker:vault_<key>] plain text;
 * both sides render the animation locally — no binary crosses the wire.
 *
 * Keys: sealed · burn · lock · ok · nope · typing · read · online
 *       heart  · zk   · brb  · shhh · keys · paranoid · lol · otr
 */
import { useEffect } from 'react';
import { View, Text, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import Svg, { Path as SvgPath } from 'react-native-svg';

// ── Brand palette (fixed — stickers are brand assets, not theme-aware) ───────
const MINT    = '#5bf2b9';
const MINT_INK = '#06231a';
const RED     = '#ff6b6b';
const INK     = '#e8f0ec';
const INK_DIM = 'rgba(232,240,236,0.55)';

// ── System fonts ─────────────────────────────────────────────────────────────
const FM = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) as string;
const FD = Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }) as string;

// ── Animated SVG path (for strokeDashoffset animations) ──────────────────────
const AnimPath = Animated.createAnimatedComponent(SvgPath);

// ── Easing shortcuts ─────────────────────────────────────────────────────────
const eio  = Easing.inOut(Easing.quad);
const eeo  = Easing.out(Easing.quad);
const elin = Easing.linear;

type SP = { size?: number };

// ─────────────────────────────────────────────────────────────────────────────
// 01 · SEALED — envelope with wax seal dropping in
// ─────────────────────────────────────────────────────────────────────────────
export function StickerSealed({ size = 80 }: SP) {
  const sY  = useSharedValue(-40);
  const sOp = useSharedValue(0);
  const fOp = useSharedValue(1);       // flap opacity (fake "open" by fading)

  useEffect(() => {
    // Wax seal: wait 540ms, drop & bounce in, hold, then reset
    sY.value = withRepeat(withSequence(
      withTiming(-40, { duration: 0 }),
      withDelay(540, withSequence(
        withTiming(0, { duration: 280, easing: eeo }),
        withTiming(-4, { duration: 100 }),
        withTiming(0, { duration: 100 }),
      )),
      withDelay(2000, withTiming(-40, { duration: 0 })),
    ), -1, false);
    sOp.value = withRepeat(withSequence(
      withTiming(0, { duration: 0 }),
      withDelay(540, withTiming(1, { duration: 200 })),
      withDelay(2060, withTiming(0, { duration: 0 })),
    ), -1, false);
    // Flap "opens" (fades to show envelope is open)
    fOp.value = withRepeat(withSequence(
      withTiming(0.9, { duration: 600, easing: eio }),
      withTiming(0.2, { duration: 360, easing: eio }),
      withDelay(1800, withTiming(0.9, { duration: 0 })),
    ), -1, false);
    return () => { cancelAnimation(sY); cancelAnimation(sOp); cancelAnimation(fOp); };
  }, []);

  const sealStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sY.value }],
    opacity: sOp.value,
  }));
  const flapStyle = useAnimatedStyle(() => ({ opacity: fOp.value }));

  const EW = size * 0.7, EH = size * 0.48;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Envelope body */}
      <View style={{ width: EW, height: EH, borderWidth: 2, borderColor: MINT, borderRadius: 4, backgroundColor: '#0a0e0d', position: 'relative', alignItems: 'center', justifyContent: 'center' }}>
        {/* Flap indicator (top triangle visual) */}
        <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: EH * 0.45, borderBottomWidth: 1, borderBottomColor: MINT }, flapStyle]} />
        {/* Wax seal */}
        <Animated.View style={[{
          width: 22, height: 22, borderRadius: 11,
          backgroundColor: MINT,
          alignItems: 'center', justifyContent: 'center',
          position: 'absolute',
        }, sealStyle]}>
          <Text style={{ fontFamily: FD, fontStyle: 'italic', fontSize: 11, color: MINT_INK, fontWeight: '600' }}>V</Text>
        </Animated.View>
      </View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 8, color: MINT, letterSpacing: 2.5 }}>
        END · TO · END
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 02 · BURN — text fading with ember particles
// ─────────────────────────────────────────────────────────────────────────────
function Ember({ delay, left, drift }: { delay: number; left: number; drift: number }) {
  const y   = useSharedValue(0);
  const op  = useSharedValue(0);
  useEffect(() => {
    y.value = withDelay(delay, withRepeat(withSequence(
      withTiming(0, { duration: 0 }),
      withTiming(-60, { duration: 2400, easing: eeo }),
    ), -1, false));
    op.value = withDelay(delay, withRepeat(withSequence(
      withTiming(0, { duration: 0 }),
      withTiming(1, { duration: 480 }),
      withTiming(0, { duration: 1920, easing: eeo }),
    ), -1, false));
    return () => { cancelAnimation(y); cancelAnimation(op); };
  }, []);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }, { translateX: drift }],
    opacity: op.value,
  }));
  return (
    <Animated.View style={[{
      position: 'absolute',
      left, bottom: '40%' as unknown as number,
      width: 3, height: 3, borderRadius: 2,
      backgroundColor: MINT,
    }, style]} />
  );
}

export function StickerBurn({ size = 80 }: SP) {
  const textOp   = useSharedValue(1);
  const textBlur = useSharedValue(0);  // visual only via opacity fade

  useEffect(() => {
    textOp.value = withRepeat(withSequence(
      withTiming(1, { duration: 1200, easing: eio }),
      withTiming(0.1, { duration: 1200, easing: eio }),
      withDelay(600, withTiming(1, { duration: 0 })),
    ), -1, false);
    return () => cancelAnimation(textOp);
  }, []);

  const textStyle = useAnimatedStyle(() => ({ opacity: textOp.value }));

  const embers: Array<{ delay: number; left: number; drift: number }> = [
    { delay: 0,    left: size * 0.32, drift: -6 },
    { delay: 400,  left: size * 0.48, drift: 10 },
    { delay: 900,  left: size * 0.58, drift: -2 },
    { delay: 1300, left: size * 0.44, drift: 14 },
    { delay: 1700, left: size * 0.52, drift: -8 },
  ];

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={textStyle}>
        <Text style={{ fontFamily: FD, fontStyle: 'italic', fontSize: 36, color: INK, fontWeight: '500' }}>
          burn.
        </Text>
      </Animated.View>
      {embers.map((e, i) => <Ember key={i} {...e} />)}
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 8, color: MINT, letterSpacing: 2.5 }}>
        EPHEMERAL · 24H
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 03 · LOCK — padlock snapping shut with pulse ring
// ─────────────────────────────────────────────────────────────────────────────
export function StickerLock({ size = 80 }: SP) {
  const shY      = useSharedValue(-10);
  const ringScale = useSharedValue(1);
  const ringOp   = useSharedValue(0);

  useEffect(() => {
    shY.value = withRepeat(withSequence(
      withTiming(-10, { duration: 450 }),
      withTiming(0, { duration: 450, easing: eeo }),
      withDelay(2100, withTiming(-10, { duration: 0 })),
    ), -1, false);
    ringScale.value = withRepeat(withSequence(
      withTiming(1, { duration: 900 }),
      withTiming(1.8, { duration: 450, easing: eeo }),
      withDelay(1650, withTiming(1, { duration: 0 })),
    ), -1, false);
    ringOp.value = withRepeat(withSequence(
      withTiming(0, { duration: 900 }),
      withTiming(0.6, { duration: 200 }),
      withTiming(0, { duration: 900, easing: eeo }),
    ), -1, false);
    return () => { cancelAnimation(shY); cancelAnimation(ringScale); cancelAnimation(ringOp); };
  }, []);

  const shackleStyle  = useAnimatedStyle(() => ({ transform: [{ translateY: shY.value }] }));
  const ringStyle     = useAnimatedStyle(() => ({ transform: [{ scale: ringScale.value }], opacity: ringOp.value }));

  const BW = size * 0.44, BH = size * 0.38;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Pulse ring */}
      <Animated.View style={[{
        position: 'absolute',
        width: BW + 16, height: BW + 16, borderRadius: (BW + 16) / 2,
        borderWidth: 2, borderColor: MINT,
      }, ringStyle]} />
      {/* Shackle (U shape) */}
      <Animated.View style={[{
        width: BW * 0.6, height: BW * 0.5,
        borderWidth: 5, borderColor: MINT, borderBottomWidth: 0,
        borderTopLeftRadius: BW * 0.3, borderTopRightRadius: BW * 0.3,
        marginBottom: -2,
      }, shackleStyle]} />
      {/* Body */}
      <View style={{
        width: BW, height: BH,
        backgroundColor: MINT, borderRadius: 8,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <View style={{ width: 8, height: 14, backgroundColor: MINT_INK, borderRadius: 2 }} />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 04 · OK — checkmark drawing in
// ─────────────────────────────────────────────────────────────────────────────
export function StickerOK({ size = 80 }: SP) {
  const dashOff = useSharedValue(120);
  const lblOp   = useSharedValue(0);
  const lblY    = useSharedValue(8);

  useEffect(() => {
    dashOff.value = withRepeat(withSequence(
      withTiming(120, { duration: 0 }),
      withDelay(450, withTiming(0, { duration: 1200, easing: eeo })),
      withDelay(1350, withTiming(120, { duration: 0 })),
    ), -1, false);
    lblOp.value = withRepeat(withSequence(
      withTiming(0, { duration: 0 }),
      withDelay(1650, withTiming(1, { duration: 400 })),
      withDelay(950, withTiming(0, { duration: 0 })),
    ), -1, false);
    lblY.value = withRepeat(withSequence(
      withTiming(8, { duration: 0 }),
      withDelay(1650, withTiming(0, { duration: 400, easing: eeo })),
      withDelay(950, withTiming(8, { duration: 0 })),
    ), -1, false);
    return () => { cancelAnimation(dashOff); cancelAnimation(lblOp); cancelAnimation(lblY); };
  }, []);

  const checkProps = useAnimatedProps<{ strokeDashoffset: number }>(
    () => ({ strokeDashoffset: dashOff.value })
  );
  const lblStyle = useAnimatedStyle(() => ({
    opacity: lblOp.value,
    transform: [{ translateY: lblY.value }],
  }));

  const svgSz = size * 0.55;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={svgSz} height={svgSz} viewBox="0 0 100 100">
        <AnimPath
          d="M22 52 L44 74 L80 30"
          stroke={MINT}
          strokeWidth={10}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray="120"
          animatedProps={checkProps}
        />
      </Svg>
      <Animated.View style={[{ position: 'absolute', bottom: 10, left: 0, right: 0, alignItems: 'center' }, lblStyle]}>
        <Text style={{ fontFamily: FM, fontSize: 9, color: MINT, letterSpacing: 2.8 }}>CONFIRMED</Text>
      </Animated.View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 05 · NOPE — X drawing in with shake
// ─────────────────────────────────────────────────────────────────────────────
export function StickerNope({ size = 80 }: SP) {
  const dashOff = useSharedValue(100);
  const shakeX  = useSharedValue(0);

  useEffect(() => {
    dashOff.value = withRepeat(withSequence(
      withTiming(100, { duration: 0 }),
      withDelay(450, withTiming(0, { duration: 1200, easing: eeo })),
      withDelay(1350, withTiming(100, { duration: 0 })),
    ), -1, false);
    shakeX.value = withRepeat(withSequence(
      withTiming(0, { duration: 2400 }),
      withTiming(-5, { duration: 60 }),
      withTiming(5,  { duration: 90 }),
      withTiming(-3, { duration: 90 }),
      withTiming(3,  { duration: 90 }),
      withTiming(0,  { duration: 60 }),
      withTiming(0,  { duration: 210 }),
    ), -1, false);
    return () => { cancelAnimation(dashOff); cancelAnimation(shakeX); };
  }, []);

  const xProps = useAnimatedProps<{ strokeDashoffset: number }>(
    () => ({ strokeDashoffset: dashOff.value })
  );
  const containerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shakeX.value }] }));

  const svgSz = size * 0.52;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={containerStyle}>
        <Svg width={svgSz} height={svgSz} viewBox="0 0 100 100">
          <AnimPath
            d="M22 22 L78 78 M78 22 L22 78"
            stroke={RED}
            strokeWidth={10}
            strokeLinecap="round"
            fill="none"
            strokeDasharray="100"
            animatedProps={xProps}
          />
        </Svg>
      </Animated.View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 10, color: RED, letterSpacing: 2.8 }}>
        NOPE
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 06 · TYPING — three bouncing dots
// ─────────────────────────────────────────────────────────────────────────────
export function StickerTyping({ size = 80 }: SP) {
  const y1 = useSharedValue(0), y2 = useSharedValue(0), y3 = useSharedValue(0);
  const dotSeq = (delay: number) => withDelay(delay, withRepeat(
    withSequence(withTiming(-7, { duration: 550, easing: eio }), withTiming(0, { duration: 550, easing: eio })),
    -1, false,
  ));
  useEffect(() => {
    y1.value = dotSeq(0);
    y2.value = dotSeq(180);
    y3.value = dotSeq(360);
    return () => { cancelAnimation(y1); cancelAnimation(y2); cancelAnimation(y3); };
  }, []);
  const s1 = useAnimatedStyle(() => ({ transform: [{ translateY: y1.value }] }));
  const s2 = useAnimatedStyle(() => ({ transform: [{ translateY: y2.value }] }));
  const s3 = useAnimatedStyle(() => ({ transform: [{ translateY: y3.value }] }));
  const dot: object = { width: 12, height: 12, borderRadius: 6, backgroundColor: MINT };
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Animated.View style={[dot, s1]} />
        <Animated.View style={[dot, s2]} />
        <Animated.View style={[dot, s3]} />
      </View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 9, color: INK_DIM, letterSpacing: 1.5 }}>
        composing…
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 07 · READ — double checkmark drawing in + turning mint
// ─────────────────────────────────────────────────────────────────────────────
export function StickerRead({ size = 80 }: SP) {
  const d1 = useSharedValue(60), d2 = useSharedValue(60);
  const op1 = useSharedValue(0.3), op2 = useSharedValue(0.3);

  useEffect(() => {
    // First check draws first
    d1.value = withRepeat(withSequence(
      withTiming(60, { duration: 0 }),
      withDelay(450, withTiming(0, { duration: 1200, easing: eeo })),
      withDelay(1350, withTiming(60, { duration: 0 })),
    ), -1, false);
    // Second check follows 300ms later
    d2.value = withRepeat(withSequence(
      withTiming(60, { duration: 0 }),
      withDelay(750, withTiming(0, { duration: 1200, easing: eeo })),
      withDelay(1050, withTiming(60, { duration: 0 })),
    ), -1, false);
    // Flash to mint after both are drawn (at ~60% = 1800ms)
    op1.value = withRepeat(withSequence(
      withTiming(0.3, { duration: 1800 }),
      withTiming(1, { duration: 450, easing: eeo }),
      withDelay(750, withTiming(0.3, { duration: 0 })),
    ), -1, false);
    op2.value = withRepeat(withSequence(
      withTiming(0.3, { duration: 1800 }),
      withTiming(1, { duration: 450, easing: eeo }),
      withDelay(750, withTiming(0.3, { duration: 0 })),
    ), -1, false);
    return () => {
      cancelAnimation(d1); cancelAnimation(d2);
      cancelAnimation(op1); cancelAnimation(op2);
    };
  }, []);

  const p1Props = useAnimatedProps<{ strokeDashoffset: number }>(
    () => ({ strokeDashoffset: d1.value })
  );
  const p2Props = useAnimatedProps<{ strokeDashoffset: number }>(
    () => ({ strokeDashoffset: d2.value })
  );
  const c1Style = useAnimatedStyle(() => ({ opacity: op1.value }));
  const c2Style = useAnimatedStyle(() => ({ opacity: op2.value }));

  const svgW = size * 0.7, svgH = size * 0.45;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={svgW} height={svgH} viewBox="0 0 110 70">
        {/* First check (wrapped in Animated.View for opacity) */}
        <Animated.View>
          <Svg width={svgW} height={svgH} viewBox="0 0 110 70" style={{ position: 'absolute' }}>
            <AnimPath
              d="M10 36 L30 56 L60 18"
              stroke={MINT}
              strokeWidth={7}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              strokeDasharray="60"
              animatedProps={p1Props}
            />
          </Svg>
        </Animated.View>
        <AnimPath
          d="M44 36 L64 56 L100 14"
          stroke={MINT}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray="60"
          animatedProps={p2Props}
        />
      </Svg>
      {/* Opacity wrapper — separate SVGs for opacity control */}
      <Animated.View style={[{ position: 'absolute', top: size * 0.22 }, c1Style]}>
        <Svg width={svgW} height={svgH} viewBox="0 0 110 70">
          <AnimPath
            d="M10 36 L30 56 L60 18"
            stroke={MINT}
            strokeWidth={7}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray="60"
            animatedProps={p1Props}
          />
        </Svg>
      </Animated.View>
      <Animated.View style={[{ position: 'absolute', top: size * 0.22 }, c2Style]}>
        <Svg width={svgW} height={svgH} viewBox="0 0 110 70">
          <AnimPath
            d="M44 36 L64 56 L100 14"
            stroke={MINT}
            strokeWidth={7}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray="60"
            animatedProps={p2Props}
          />
        </Svg>
      </Animated.View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 9, color: MINT, letterSpacing: 2.8 }}>
        READ
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 08 · ONLINE — pulsing dot with expanding rings
// ─────────────────────────────────────────────────────────────────────────────
export function StickerOnline({ size = 80 }: SP) {
  const r1S = useSharedValue(1), r1O = useSharedValue(0.6);
  const r2S = useSharedValue(1), r2O = useSharedValue(0.6);

  const startRing = (s: typeof r1S, o: typeof r1O, delay: number) => {
    s.value = withDelay(delay, withRepeat(
      withTiming(2.6, { duration: 1600, easing: eeo }), -1, false
    ));
    o.value = withDelay(delay, withRepeat(
      withTiming(0, { duration: 1600, easing: eeo }), -1, false
    ));
  };

  useEffect(() => {
    startRing(r1S, r1O, 0);
    startRing(r2S, r2O, 800);
    return () => { cancelAnimation(r1S); cancelAnimation(r1O); cancelAnimation(r2S); cancelAnimation(r2O); };
  }, []);

  const ring1 = useAnimatedStyle(() => ({ transform: [{ scale: r1S.value }], opacity: r1O.value }));
  const ring2 = useAnimatedStyle(() => ({ transform: [{ scale: r2S.value }], opacity: r2O.value }));
  const DOT = 26;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: DOT, height: DOT, position: 'relative', alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={[{ position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 2, borderColor: MINT }, ring1]} />
        <Animated.View style={[{ position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 2, borderColor: MINT }, ring2]} />
        <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: MINT }} />
      </View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 9, color: MINT, letterSpacing: 2.8 }}>
        ONLINE
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 09 · HEART — <3 beating
// ─────────────────────────────────────────────────────────────────────────────
export function StickerHeart({ size = 80 }: SP) {
  const scale = useSharedValue(1);
  useEffect(() => {
    // beat: 0→14%→28%→42%→56%→100% at 1.4s
    scale.value = withRepeat(withSequence(
      withTiming(1.18, { duration: 196, easing: eio }),
      withTiming(1,    { duration: 196, easing: eio }),
      withTiming(1.14, { duration: 196, easing: eio }),
      withTiming(1,    { duration: 196, easing: eio }),
      withTiming(1,    { duration: 616 }),
    ), -1, false);
    return () => cancelAnimation(scale);
  }, []);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={style}>
        <Text style={{ fontFamily: FM, fontSize: 40, color: MINT, fontWeight: '700', letterSpacing: -2 }}>&lt;3</Text>
      </Animated.View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 8, color: INK_DIM, letterSpacing: 2 }}>
        CIPHERHEART
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 10 · ZK — eye blinking inside a ring (Zero Knowledge)
// ─────────────────────────────────────────────────────────────────────────────
export function StickerZK({ size = 80 }: SP) {
  const eyeH = useSharedValue(1);
  useEffect(() => {
    // blink: 0-92% open, 92-95% close, 95-100% open. cycle: 2.8s
    eyeH.value = withRepeat(withSequence(
      withTiming(1,    { duration: 2576 }),
      withTiming(0.05, { duration: 84, easing: eeo }),
      withTiming(1,    { duration: 140, easing: eeo }),
    ), -1, false);
    return () => cancelAnimation(eyeH);
  }, []);
  const eyeStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: eyeH.value }] }));
  const RING = size * 0.56;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: RING, height: RING, borderRadius: RING / 2, borderWidth: 4, borderColor: MINT, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={[{
          width: RING * 0.4, height: RING * 0.2,
          borderRadius: RING * 0.2,
          backgroundColor: MINT,
          alignItems: 'center', justifyContent: 'center',
        }, eyeStyle]}>
          <View style={{ width: RING * 0.14, height: RING * 0.14, borderRadius: RING * 0.07, backgroundColor: MINT_INK }} />
        </Animated.View>
      </View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 7.5, color: MINT, letterSpacing: 2.5 }}>
        ZERO · KNOWLEDGE
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 11 · BRB — terminal text with blinking cursor
// ─────────────────────────────────────────────────────────────────────────────
export function StickerBRB({ size = 80 }: SP) {
  const cursorOp = useSharedValue(1);
  useEffect(() => {
    cursorOp.value = withRepeat(withSequence(
      withTiming(1, { duration: 450 }),
      withTiming(0, { duration: 0 }),
      withTiming(0, { duration: 450 }),
      withTiming(1, { duration: 0 }),
    ), -1, false);
    return () => cancelAnimation(cursorOp);
  }, []);
  const cStyle = useAnimatedStyle(() => ({ opacity: cursorOp.value }));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      <Text style={{ fontFamily: FD, fontStyle: 'italic', fontSize: 32, color: INK, lineHeight: 32 }}>brb.</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ fontFamily: FM, fontSize: 11, color: MINT, letterSpacing: 1 }}>&gt; back soon</Text>
        <Animated.View style={[{ width: 8, height: 15, backgroundColor: MINT, marginLeft: 3 }, cStyle]} />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 12 · SHHH — letters dropping in staggered
// ─────────────────────────────────────────────────────────────────────────────
function ShhhLetter({ char, delay }: { char: string; delay: number }) {
  const y  = useSharedValue(-14);
  const op = useSharedValue(0);
  useEffect(() => {
    y.value = withDelay(delay, withRepeat(withSequence(
      withTiming(-14, { duration: 0 }),
      withTiming(0, { duration: 440, easing: eeo }),
      withDelay(1320, withTiming(2, { duration: 440 })),
      withTiming(-14, { duration: 0 }),
    ), -1, false));
    op.value = withDelay(delay, withRepeat(withSequence(
      withTiming(0, { duration: 0 }),
      withTiming(1, { duration: 440, easing: eeo }),
      withDelay(1320, withTiming(0, { duration: 440 })),
    ), -1, false));
    return () => { cancelAnimation(y); cancelAnimation(op); };
  }, []);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }],
    opacity: op.value,
  }));
  return (
    <Animated.View style={style}>
      <Text style={{ fontFamily: FD, fontStyle: 'italic', fontSize: 44, color: MINT, fontWeight: '500', lineHeight: 44 }}>
        {char}
      </Text>
    </Animated.View>
  );
}

export function StickerShhh({ size = 80 }: SP) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        {['s', 'h', 'h', 'h'].map((c, i) => (
          <ShhhLetter key={i} char={c} delay={i * 180} />
        ))}
      </View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 8, color: INK_DIM, letterSpacing: 2 }}>
        QUIET · CHANNEL
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 13 · KEYS — two key shapes sliding together (X3DH handshake)
// ─────────────────────────────────────────────────────────────────────────────
export function StickerKeys({ size = 80 }: SP) {
  const kLX = useSharedValue(-16);
  const kRX = useSharedValue(16);
  const sparkOp = useSharedValue(0);

  useEffect(() => {
    kLX.value = withRepeat(withSequence(
      withTiming(-16, { duration: 0 }),
      withTiming(-16, { duration: 480 }),
      withTiming(0, { duration: 600, easing: eio }),
      withTiming(0, { duration: 240 }),
      withTiming(-16, { duration: 600, easing: eio }),
      withTiming(-16, { duration: 480 }),
    ), -1, false);
    kRX.value = withRepeat(withSequence(
      withTiming(16, { duration: 0 }),
      withTiming(16, { duration: 480 }),
      withTiming(0, { duration: 600, easing: eio }),
      withTiming(0, { duration: 240 }),
      withTiming(16, { duration: 600, easing: eio }),
      withTiming(16, { duration: 480 }),
    ), -1, false);
    sparkOp.value = withRepeat(withSequence(
      withTiming(0, { duration: 1056 }),
      withTiming(1, { duration: 120 }),
      withTiming(0, { duration: 360 }),
      withTiming(0, { duration: 864 }),
    ), -1, false);
    return () => { cancelAnimation(kLX); cancelAnimation(kRX); cancelAnimation(sparkOp); };
  }, []);

  const kLStyle    = useAnimatedStyle(() => ({ transform: [{ translateX: kLX.value }] }));
  const kRStyle    = useAnimatedStyle(() => ({ transform: [{ translateX: kRX.value }, { scaleX: -1 }] }));
  const sparkStyle = useAnimatedStyle(() => ({ opacity: sparkOp.value }));

  const KEY_W = size * 0.28, KEY_H = size * 0.1;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, position: 'relative' }}>
        <Animated.View style={[{ flexDirection: 'row', alignItems: 'center' }, kLStyle]}>
          <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: MINT, backgroundColor: 'transparent' }} />
          <View style={{ width: KEY_W, height: KEY_H, backgroundColor: MINT, borderRadius: KEY_H / 2, marginLeft: -3 }} />
        </Animated.View>
        <Animated.View style={[{ flexDirection: 'row', alignItems: 'center' }, kRStyle]}>
          <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: MINT, backgroundColor: 'transparent' }} />
          <View style={{ width: KEY_W, height: KEY_H, backgroundColor: MINT, borderRadius: KEY_H / 2, marginLeft: -3 }} />
        </Animated.View>
        {/* Spark at center */}
        <Animated.View style={[{
          position: 'absolute', alignSelf: 'center', left: '50%' as unknown as number,
          width: 20, height: 20, borderRadius: 10,
          backgroundColor: MINT, marginLeft: -10,
        }, sparkStyle]} />
      </View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 8, color: MINT, letterSpacing: 2 }}>
        KEY · EXCHANGED
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 14 · PARANOID — eyes darting side to side
// ─────────────────────────────────────────────────────────────────────────────
export function StickerParanoid({ size = 80 }: SP) {
  const pupilX = useSharedValue(-5);
  useEffect(() => {
    // dart: 0%=-6, 25%=+6, 50%=-4, 75%=+8, 100%=-6 at 1.6s
    pupilX.value = withRepeat(withSequence(
      withTiming(6,  { duration: 400, easing: eio }),
      withTiming(-4, { duration: 400, easing: eio }),
      withTiming(8,  { duration: 400, easing: eio }),
      withTiming(-6, { duration: 400, easing: eio }),
    ), -1, false);
    return () => cancelAnimation(pupilX);
  }, []);
  const pupilStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pupilX.value }] }));

  const EYE = size * 0.22;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {[0, 1].map((i) => (
          <View key={i} style={{
            width: EYE, height: EYE, borderRadius: EYE / 2,
            borderWidth: 2.5, borderColor: MINT,
            alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden',
          }}>
            <Animated.View style={[{ width: EYE * 0.4, height: EYE * 0.4, borderRadius: EYE * 0.2, backgroundColor: MINT }, pupilStyle]} />
          </View>
        ))}
      </View>
      <Text style={{ fontFamily: FD, fontStyle: 'italic', fontSize: 14, color: INK, letterSpacing: -0.3 }}>
        paranoid? good.
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 15 · LOL — bouncing italic text
// ─────────────────────────────────────────────────────────────────────────────
export function StickerLOL({ size = 80 }: SP) {
  const scale  = useSharedValue(1);
  const rotate = useSharedValue(-3);
  useEffect(() => {
    scale.value = withRepeat(withSequence(
      withTiming(1.08, { duration: 300, easing: eio }),
      withTiming(1,    { duration: 300, easing: eio }),
    ), -1, false);
    rotate.value = withRepeat(withSequence(
      withTiming(3,  { duration: 300, easing: eio }),
      withTiming(-3, { duration: 300, easing: eio }),
    ), -1, false);
    return () => { cancelAnimation(scale); cancelAnimation(rotate); };
  }, []);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { rotate: `${rotate.value}deg` }],
  }));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={style}>
        <Text style={{ fontFamily: FD, fontStyle: 'italic', fontWeight: '600', fontSize: 44, color: MINT, lineHeight: 44 }}>
          lol
        </Text>
      </Animated.View>
      <Text style={{ position: 'absolute', bottom: 10, fontFamily: FM, fontSize: 8, color: INK_DIM, letterSpacing: 2 }}>
        UNENCRYPTED LAUGH
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 16 · OTR — spinning tape reels
// ─────────────────────────────────────────────────────────────────────────────
export function StickerOTR({ size = 80 }: SP) {
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = withRepeat(withTiming(360, { duration: 2000, easing: elin }), -1, false);
    return () => cancelAnimation(rot);
  }, []);
  const reelStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));

  const REEL = size * 0.26;
  const Reel = () => (
    <Animated.View style={[{
      width: REEL, height: REEL, borderRadius: REEL / 2,
      borderWidth: 2.5, borderColor: MINT,
      alignItems: 'center', justifyContent: 'center',
    }, reelStyle]}>
      {/* Cross inside reel */}
      <View style={{ position: 'absolute', width: REEL * 0.55, height: 2.5, backgroundColor: MINT }} />
      <View style={{ position: 'absolute', width: 2.5, height: REEL * 0.55, backgroundColor: MINT }} />
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#11181a' }} />
    </Animated.View>
  );

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
        <Reel />
        <Reel />
      </View>
      <Text style={{ fontFamily: FM, fontSize: 8, color: MINT, letterSpacing: 2.5 }}>
        OFF · THE · RECORD
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry — maps sticker keys to components and display info
// ─────────────────────────────────────────────────────────────────────────────
export const VAULT_PACK = [
  { key: 'vault_sealed',   label: 'Sealed',    Component: StickerSealed   },
  { key: 'vault_burn',     label: 'Burn',      Component: StickerBurn     },
  { key: 'vault_lock',     label: 'Locked',    Component: StickerLock     },
  { key: 'vault_ok',       label: 'OK',        Component: StickerOK       },
  { key: 'vault_nope',     label: 'Nope',      Component: StickerNope     },
  { key: 'vault_typing',   label: 'Typing',    Component: StickerTyping   },
  { key: 'vault_read',     label: 'Read',      Component: StickerRead     },
  { key: 'vault_online',   label: 'Online',    Component: StickerOnline   },
  { key: 'vault_heart',    label: 'Heart',     Component: StickerHeart    },
  { key: 'vault_zk',       label: 'Zero KN',   Component: StickerZK       },
  { key: 'vault_brb',      label: 'BRB',       Component: StickerBRB      },
  { key: 'vault_shhh',     label: 'Shhh',      Component: StickerShhh     },
  { key: 'vault_keys',     label: 'Handshake', Component: StickerKeys     },
  { key: 'vault_paranoid', label: 'Paranoid',  Component: StickerParanoid },
  { key: 'vault_lol',      label: 'LOL',       Component: StickerLOL      },
  { key: 'vault_otr',      label: 'OTR',       Component: StickerOTR      },
] as const;

export type VaultStickerKey = (typeof VAULT_PACK)[number]['key'];

/** Render a sticker by key. Returns null for unknown keys. */
export function VaultSticker({ stickerKey, size = 80 }: { stickerKey: string; size?: number }) {
  const entry = VAULT_PACK.find((s) => s.key === stickerKey);
  if (!entry) return null;
  const { Component } = entry;
  return <Component size={size} />;
}
