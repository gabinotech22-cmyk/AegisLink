import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Share,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { PrimaryButton, GhostButton } from '../components/Button';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import type { StoredContact } from '../db/local';

type Method = 'menu' | 'qr' | 'link' | 'id';

interface Props {
  onCancel: () => void;
  onAdded: (contact: StoredContact) => void;
}

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function AddContactScreen({ onCancel, onAdded }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [method, setMethod] = useState<Method>('menu');
  const identity = useIdentity((s) => s.identity);
  const addByAegisId = useContacts((s) => s.addByAegisId);

  const goBack = () => setMethod('menu');

  if (method === 'qr') {
    return (
      <QRScreen
        t={t}
        identity={identity}
        insets={insets}
        onBack={goBack}
        onScanned={async (scannedId: string) => {
          try {
            const contact = await addByAegisId(scannedId, '');
            if (identity) {
              const { sendProfileTo } = require('../socket/client') as typeof import('../socket/client');
              void sendProfileTo(contact, identity);
            }
            onAdded(contact);
          } catch (e) {
            Alert.alert('Error', (e as Error).message);
            goBack();
          }
        }}
      />
    );
  }

  if (method === 'link') {
    return (
      <LinkScreen
        t={t}
        i18nT={i18nT}
        identity={identity}
        insets={insets}
        onBack={goBack}
        addByAegisId={addByAegisId}
        onAdded={onAdded}
      />
    );
  }

  if (method === 'id') {
    return (
      <ByIdScreen
        t={t}
        i18nT={i18nT}
        insets={insets}
        identity={identity}
        addByAegisId={addByAegisId}
        onBack={goBack}
        onAdded={onAdded}
      />
    );
  }

  // ── Menu principal ──────────────────────────────────────────────────────
  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={onCancel} hitSlop={8} style={{ padding: 6 }}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '600', color: t.text }}>
          Añadir contacto
        </Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 32 }}>
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 20, marginBottom: 22, textAlign: 'center' }}>
          AegisLink nunca lee tu agenda. Elige cómo intercambiar identidades.
        </Text>

        <View style={{ gap: 12 }}>
          <MethodCard
            t={t}
            icon={<I.QR size={26} color={t.accent} />}
            label="En persona — QR"
            sub="Lo más seguro. Tu QR se muestra solo a quien tienes delante."
            cta="MOSTRAR MI QR →"
            badge="RECOMENDADO"
            primary
            onPress={() => setMethod('qr')}
          />
          <MethodCard
            t={t}
            icon={<I.Link size={24} color={t.text} />}
            label="Enlace de invitación"
            sub="Genera un enlace de un solo uso que expira en 24h."
            cta="GENERAR ENLACE →"
            onPress={() => setMethod('link')}
          />
          <MethodCard
            t={t}
            icon={<I.Key size={24} color={t.text} />}
            label="Por Aegis ID"
            sub="Pega el ID de 12 caracteres del contacto. Después verifica la huella."
            cta="INTRODUCIR ID →"
            onPress={() => setMethod('id')}
          />
        </View>

        <View style={{
          marginTop: 28, padding: 14,
          backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
          borderRadius: t.radius, flexDirection: 'row', gap: 12, alignItems: 'flex-start',
        }}>
          <I.Shield size={18} color={t.warn} style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.text }}>
              Verifica antes de hablar.
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18, marginTop: 4 }}>
              Cualquier método sirve para iniciar — pero comparen las 8 palabras de seguridad antes de enviar algo sensible.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ── QR Screen — muestra mi QR y escanea el del otro ─────────────────────────
function QRScreen({ t, identity, insets, onBack, onScanned }: any) {
  const [mode, setMode] = useState<'show' | 'scan'>('show');
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  const myQRData = identity ? `aegislink:${identity.aegisId}` : '';

  const handleScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    setMode('scan');
  };

  const handleBarCode = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    const id = data.replace('aegislink:', '').trim().toUpperCase();
    if (AEGIS_ID_RE.test(id)) {
      onScanned(id);
    } else {
      Alert.alert('QR inválido', 'Este código QR no pertenece a AegisLink.', [
        { text: 'OK', onPress: () => { setScanned(false); setMode('show'); } },
      ]);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
          {mode === 'show' ? 'Mi código QR' : 'Escanear QR'}
        </Text>
        <View style={{ width: 34 }} />
      </View>

      {mode === 'show' ? (
        <ScrollView contentContainerStyle={{ alignItems: 'center', padding: 28, gap: 24 }}>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: 20 }}>
            Muestra este código a quien quieras añadir. Solo es válido para tu identidad actual.
          </Text>

          {myQRData ? (
            <View style={{
              padding: 20, backgroundColor: '#fff', borderRadius: t.radius,
              shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
            }}>
              <QRCode
                value={myQRData}
                size={220}
                color="#0a0a0a"
                backgroundColor="#ffffff"
              />
            </View>
          ) : (
            <View style={{ width: 260, height: 260, backgroundColor: t.surface, borderRadius: t.radius,
              alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={t.accent} />
            </View>
          )}

          <View style={{
            backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
            borderRadius: t.radius, paddingHorizontal: 18, paddingVertical: 12,
            alignItems: 'center',
          }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5, marginBottom: 4 }}>
              TU AEGIS ID
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 18, color: t.text, letterSpacing: 2 }}>
              {identity?.aegisId ?? '—'}
            </Text>
          </View>

          <Pressable
            onPress={handleScan}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
              borderRadius: t.radius, paddingHorizontal: 20, paddingVertical: 12,
            }}
          >
            <I.QR size={18} color={t.accent} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, letterSpacing: 0.5 }}>
              ESCANEAR QR DEL CONTACTO
            </Text>
          </Pressable>
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            onBarcodeScanned={scanned ? undefined : handleBarCode}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          />
          <View style={{
            position: 'absolute', bottom: 40, left: 0, right: 0,
            alignItems: 'center',
          }}>
            <Pressable
              onPress={() => setMode('show')}
              style={{
                backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 99,
                paddingHorizontal: 20, paddingVertical: 10,
              }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: '#fff', letterSpacing: 0.5 }}>
                CANCELAR
              </Text>
            </Pressable>
          </View>
          {/* Visor overlay */}
          <View style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
          }}>
            <View style={{
              width: 220, height: 220, borderWidth: 2, borderColor: t.accent,
              borderRadius: 12, backgroundColor: 'transparent',
            }} />
          </View>
        </View>
      )}
    </View>
  );
}

// ── Enlace de invitación ─────────────────────────────────────────────────────
function LinkScreen({ t, i18nT, identity, insets, onBack, addByAegisId, onAdded }: any) {
  const link = identity ? `https://aegislink.app/add/${identity.aegisId}` : '';
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    await Share.share({
      message: `Agrégate en AegisLink (E2EE, sin metadatos):\n${link}`,
      url: link,
    });
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
          Enlace de invitación
        </Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 22, gap: 18 }}>
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 20, textAlign: 'center' }}>
          Este enlace identifica tu cuenta. Cualquiera que lo reciba podrá agregarte como contacto.
        </Text>

        {/* Link display */}
        <View style={{
          backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
          borderRadius: t.radius, padding: 16,
        }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent, letterSpacing: 0.5, marginBottom: 8 }}>
            TU ENLACE DE CONTACTO
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, lineHeight: 20 }}>
            {link}
          </Text>
        </View>

        <View style={{ gap: 10 }}>
          <Pressable
            onPress={handleCopy}
            style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              backgroundColor: copied ? t.accent + '22' : t.surface,
              borderWidth: 1, borderColor: copied ? t.accent : t.border,
              borderRadius: t.radius, paddingVertical: 14,
            }}
          >
            <I.Copy size={18} color={copied ? t.accent : t.text} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: copied ? t.accent : t.text, letterSpacing: 0.5 }}>
              {copied ? 'COPIADO ✓' : 'COPIAR ENLACE'}
            </Text>
          </Pressable>

          <Pressable
            onPress={handleShare}
            style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              backgroundColor: t.accent, borderRadius: t.radius, paddingVertical: 14,
            }}
          >
            <I.Send size={18} color={t.accentInk} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accentInk, letterSpacing: 0.5, fontWeight: '600' }}>
              COMPARTIR
            </Text>
          </Pressable>
        </View>

        <View style={{
          backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
          borderRadius: t.radius, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start',
        }}>
          <I.Shield size={16} color={t.warn} style={{ marginTop: 2 }} />
          <Text style={{ flex: 1, fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
            Comparte solo con personas de confianza. Quien reciba este enlace podrá ver tu Aegis ID y agregarte.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ── Por Aegis ID ─────────────────────────────────────────────────────────────
function ByIdScreen({ t, i18nT, insets, identity, addByAegisId, onBack, onAdded }: any) {
  const [aegisId, setAegisId] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmedId = aegisId.trim().toUpperCase();
  const idValid = AEGIS_ID_RE.test(trimmedId);

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setAegisId(text.trim());
  };

  const handleAdd = async () => {
    if (!idValid) return;
    setSubmitting(true);
    try {
      const contact = await addByAegisId(trimmedId, name);
      if (identity) {
        const { sendProfileTo } = require('../socket/client') as typeof import('../socket/client');
        void sendProfileTo(contact, identity);
      }
      onAdded(contact);
    } catch (e) {
      const raw = (e as Error).message ?? '';
      const isNetwork =
        raw.toLowerCase().includes('network') ||
        raw.toLowerCase().includes('failed to fetch') ||
        raw.toLowerCase().includes('timeout') ||
        raw.toLowerCase().includes('econnrefused');
      Alert.alert(
        'No se pudo agregar',
        isNetwork
          ? 'No se puede conectar al servidor AegisLink. Verifica tu conexión.'
          : raw,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
          Por Aegis ID
        </Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 22, gap: 18 }}>
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 20, textAlign: 'center' }}>
          Introduce el ID de 12 caracteres de tu contacto. Después verifica la huella para confirmar la identidad.
        </Text>

        {/* ID input */}
        <View>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            AEGIS ID
          </Text>
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            backgroundColor: t.surface, borderWidth: 1,
            borderColor: idValid || aegisId.length === 0 ? t.border : t.danger,
            borderRadius: t.radius, paddingHorizontal: 14,
          }}>
            <TextInput
              value={aegisId}
              onChangeText={(s) => setAegisId(s.toUpperCase())}
              placeholder="XXX-XXXX-XXXX"
              placeholderTextColor={t.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              spellCheck={false}
              style={{
                flex: 1, fontFamily: t.fontMono, fontSize: 18,
                color: t.text, paddingVertical: 14, letterSpacing: 1,
              }}
            />
            <Pressable onPress={handlePaste} hitSlop={8} style={{ padding: 6 }}>
              <I.Copy size={18} color={t.textDim} />
            </Pressable>
          </View>
          {aegisId.length > 0 && !idValid && (
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger, marginTop: 6 }}>
              Formato inválido — debe ser XXX-XXXX-XXXX
            </Text>
          )}
        </View>

        {/* Nickname */}
        <View>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8 }}>
            APODO (OPCIONAL)
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="¿Cómo quieres llamarle?"
            placeholderTextColor={t.textFaint}
            style={{
              backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
              borderRadius: t.radius, paddingHorizontal: 14, paddingVertical: 14,
              fontFamily: t.font, fontSize: 15, color: t.text,
            }}
          />
        </View>

        <PrimaryButton
          t={t}
          label={submitting ? 'Añadiendo…' : 'Añadir contacto'}
          disabled={!idValid || submitting}
          onPress={handleAdd}
        />

        {submitting && <ActivityIndicator color={t.accent} style={{ marginTop: 8 }} />}
      </ScrollView>
    </View>
  );
}

// ── MethodCard ───────────────────────────────────────────────────────────────
function MethodCard({ t, icon, label, sub, cta, badge, primary, onPress }: any) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [{
        padding: 16, backgroundColor: t.surface,
        borderWidth: 1, borderColor: primary ? t.accent + '66' : t.border,
        borderRadius: t.radius, flexDirection: 'row', alignItems: 'center', gap: 14,
        opacity: pressed ? 0.75 : 1,
      }]}
    >
      <View style={{
        width: 44, height: 44, borderRadius: t.radiusS,
        backgroundColor: primary ? t.accent + '22' : t.surface2,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>
            {label}
          </Text>
          {badge && (
            <View style={{
              borderWidth: 1, borderColor: t.accent, borderRadius: 99,
              paddingHorizontal: 5, paddingVertical: 1,
            }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent, letterSpacing: 0.8 }}>
                {badge}
              </Text>
            </View>
          )}
        </View>
        <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17 }}>
          {sub}
        </Text>
      </View>
      <Text style={{
        fontFamily: t.fontMono, fontSize: 10,
        color: primary ? t.accent : t.textDim,
        letterSpacing: 0.5, fontWeight: '600',
      }}>
        {cta}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
  },
});
