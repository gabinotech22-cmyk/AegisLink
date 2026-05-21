import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { useIdentity } from '../store/identity';
import { I } from '../components/icons';

interface Props {
  onDone: () => void;
  onBack: () => void;
}

export function WorkGenerationScreen({ onDone, onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { createWorkSlot, switchSlot } = useIdentity();
  
  const progressAnim = useRef(new Animated.Value(0)).current;
  const isCreatedRef = useRef(false);
  const isAnimationDoneRef = useRef(false);

  // Helper to handle slot switching after both keygen and animation are done
  async function completeAndSwitch() {
    try {
      await switchSlot('work');
      onDone();
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
      onBack();
    }
  }

  useEffect(() => {
    // 1. Start the 10-second linear progress bar animation
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: 10000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(() => {
      isAnimationDoneRef.current = true;
      if (isCreatedRef.current) {
        void completeAndSwitch();
      }
    });

    // 2. Call createWorkSlot in the background
    createWorkSlot()
      .then(() => {
        isCreatedRef.current = true;
        if (isAnimationDoneRef.current) {
          void completeAndSwitch();
        }
      })
      .catch((err) => {
        Alert.alert(i18nT('common.error'), err.message || i18nT('profile.keygenError'));
        onBack();
      });
  }, []);

  const containerPad = { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 };

  return (
    <View style={[styles.frame, { backgroundColor: '#0b0813' }, containerPad]}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <KeySpinner accentColor="#8b5cf6" surfaceColor="#1b152d" />
        
        <Text style={[styles.title, { color: '#ffffff', fontFamily: t.fontDisplay }]}>
          {i18nT('profile.generatingWorkTitle')}
        </Text>
        
        <Text style={[styles.subtitle, { color: '#a78bfa', fontFamily: t.fontMono }]}>
          {i18nT('profile.generatingWorkSubtitle')}
        </Text>
        
        <View style={{ marginTop: 32, width: '100%', paddingHorizontal: 28 }}>
          <View style={[styles.progressBg, { backgroundColor: '#21183c' }]}>
            <Animated.View
              style={[
                styles.progressBar,
                {
                  backgroundColor: '#8b5cf6',
                  width: progressAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

function KeySpinner({ accentColor, surfaceColor }: { accentColor: string; surfaceColor: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View style={{ width: 96, height: 96, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          width: 96,
          height: 96,
          borderRadius: 48,
          borderWidth: 2,
          borderColor: 'transparent',
          borderTopColor: accentColor,
          borderRightColor: accentColor,
          transform: [{ rotate }],
          position: 'absolute',
        }}
      />
      <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: surfaceColor, alignItems: 'center', justifyContent: 'center' }}>
        <I.Key size={26} stroke={1.8} color={accentColor} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, paddingHorizontal: 28 },
  title: {
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -0.48,
    marginTop: 36,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 11,
    marginTop: 12,
    letterSpacing: 0.4,
    textAlign: 'center',
  },
  progressBg: {
    height: 3,
    borderRadius: 99,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 99,
  },
});
