import { useState, useEffect } from 'react';
import { logger } from '../utils/logger';
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { PrimaryButton } from '../components/Button';
import { decodeBase64 } from 'tweetnacl-util';
import { sendMessage } from '../socket/client';
import { useIdentity } from '../store/identity';
import type { StoredContact } from '../db/local';
import * as Location from 'expo-location';
import { themedAlert } from '../components/AlertHost';

interface Props {
  contact: StoredContact;
  onBack: () => void;
  onShare: () => void;
}

const DURATIONS = [
  { id: '15m', lKey: 'location.duration15m', sKey: 'location.duration15mDesc' },
  { id: '1h',  lKey: 'location.duration1h',  sKey: 'location.duration1hDesc' },
  { id: '8h',  lKey: 'location.duration8h',  sKey: 'location.duration8hDesc' },
  { id: 'eod', lKey: 'location.durationEod', sKey: 'location.durationEodDesc' },
] as const;

export function LocationScreen({ contact, onBack, onShare }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const [dur, setDur] = useState<string>('1h');
  const [precise, setPrecise] = useState(true);
  const [sharing, setSharing] = useState(false);

  // Live Location States
  const [locationName, setLocationName] = useState<string>('');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [loadingLocation, setLoadingLocation] = useState(true);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setPermissionError(i18nT('location.permissionDenied'));
          setLocationName('ZURICH · BAHNHOFSTRASSE (SIMULADA)');
          setCoords({ latitude: 47.3769, longitude: 8.5417 });
          setLoadingLocation(false);
          return;
        }

        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        setCoords(loc.coords);

        // Reverse geocoding to find human-readable address
        const geo = await Location.reverseGeocodeAsync({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        });

        if (geo && geo.length > 0) {
          const first = geo[0];
          // Build clean street address based on precision
          const streetPart = precise 
            ? [first.street, first.streetNumber].filter(Boolean).join(' ') 
            : i18nT('location.approximateNeighborhood');
          const areaPart = [first.city || first.subregion, first.country].filter(Boolean).join(', ');
          const formatted = [streetPart, areaPart].filter(Boolean).join(', ');
          
          setLocationName(formatted || `${loc.coords.latitude.toFixed(5)}, ${loc.coords.longitude.toFixed(5)}`);
        } else {
          setLocationName(`${loc.coords.latitude.toFixed(5)}, ${loc.coords.longitude.toFixed(5)}`);
        }
      } catch (err) {
        if (__DEV__) logger.warn('[location] Failed to fetch live location:', err);
        setLocationName('ZURICH · BAHNHOFSTRASSE (SIMULADA)');
        setCoords({ latitude: 47.3769, longitude: 8.5417 });
      } finally {
        setLoadingLocation(false);
      }
    })();
  }, [precise]); // Refetch and format when precision toggle changes to obfuscate street address instantly

  async function handleShare() {
    if (!identity) return;
    setSharing(true);
    try {
      const precisionText = precise ? i18nT('location.exact') : i18nT('location.approximate');
      const durObj = DURATIONS.find((d) => d.id === dur);
      const durText = durObj ? i18nT(durObj.lKey) : i18nT('location.hour1');

      let shareText = locationName;
      let lat = coords ? coords.latitude : 47.3769;
      let lon = coords ? coords.longitude : 8.5417;

      if (!precise) {
        // Obfuscate coordinates to ~500m precision (0.005 degrees)
        lat = Math.round(lat * 200) / 200;
        lon = Math.round(lon * 200) / 200;
        shareText = i18nT('location.areaOf', { name: shareText });
      }

      shareText += ` (Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)})`;
      const msgText = i18nT('location.sharedMsgFormat', { precision: precisionText, duration: durText, location: shareText });

      let expiresAt: number;
      const now = Date.now();
      if (dur === '15m') {
        expiresAt = now + 15 * 60 * 1000;
      } else if (dur === '1h') {
        expiresAt = now + 60 * 60 * 1000;
      } else if (dur === '8h') {
        expiresAt = now + 8 * 60 * 60 * 1000;
      } else {
        // eod (End of day)
        const eod = new Date();
        eod.setHours(23, 59, 59, 999);
        expiresAt = eod.getTime();
      }

      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: msgText,
        type: 'location',
        expiresAt,
      });

      themedAlert(i18nT('location.sharedSuccess'), i18nT('location.sharedSuccessDesc'));
      onShare();
    } catch (e) {
      themedAlert(i18nT('location.sendErrorTitle'), (e as Error).message);
    } finally {
      setSharing(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('location.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <View
        style={{
          marginHorizontal: 18,
          marginTop: 8,
          marginBottom: 16,
          height: 200,
          borderRadius: t.radius,
          borderWidth: 1,
          borderColor: t.border,
          overflow: 'hidden',
          backgroundColor: t.dark ? '#1a2326' : '#e8e5dc',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Svg viewBox="0 0 280 200" width="100%" height="100%" style={{ position: 'absolute' }}>
          <Path d="M0 80 Q140 60 280 100" stroke={t.borderStrong} strokeWidth={6} fill="none" opacity={0.5} />
          <Path d="M120 0 L160 200" stroke={t.borderStrong} strokeWidth={6} fill="none" opacity={0.5} />
          <Path d="M0 150 L280 140" stroke={t.borderStrong} strokeWidth={3} fill="none" opacity={0.4} />
        </Svg>
        
        {loadingLocation ? (
          <ActivityIndicator color={t.accent} size="large" />
        ) : (
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: t.accent,
              borderWidth: 3,
              borderColor: t.bg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Shield size={18} color={t.accentInk} />
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 22 + insets.bottom }}>
        <View style={{ paddingHorizontal: 22, paddingBottom: 12 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8, marginBottom: 4 }}>
            {locationName.toUpperCase()}
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
            {i18nT('location.shareDesc', { name: contact.name })}
          </Text>
          {permissionError && (
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.danger, marginTop: 4 }}>
              ⚠️ {permissionError} {i18nT('location.permissionError')}
            </Text>
          )}
        </View>

        <Section t={t} label={i18nT('location.duration').toUpperCase()}>
          {DURATIONS.map((o, i) => {
            const sel = dur === o.id;
            return (
              <Pressable
                key={o.id}
                onPress={() => setDur(o.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: i < DURATIONS.length - 1 ? 1 : 0,
                  borderBottomColor: t.divider,
                }}
              >
                <Radio t={t} selected={sel} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: sel ? '600' : '400', color: t.text }}>
                    {i18nT(o.lKey)}
                  </Text>
                  <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{i18nT(o.sKey)}</Text>
                </View>
              </Pressable>
            );
          })}
        </Section>

        <Section t={t} label={i18nT('location.precision').toUpperCase()}>
          <Toggle
            t={t}
            label={i18nT('location.precision')}
            sub={i18nT('location.precisionSub')}
            value={precise}
            onChange={setPrecise}
            noBorder
          />
        </Section>

        <View style={{ paddingHorizontal: 18, marginTop: 10 }}>
          <PrimaryButton
            t={t}
            label={sharing ? i18nT('common.loading') : i18nT('location.share')}
            onPress={handleShare}
            disabled={sharing || loadingLocation}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function Radio({ t, selected }: { t: Theme; selected: boolean }) {
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: selected ? t.accent : t.borderStrong,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {selected ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.accent }} /> : null}
    </View>
  );
}
