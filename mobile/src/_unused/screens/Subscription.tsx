import { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Alert,
  TextInput,
  Modal,
  ActivityIndicator,
  Clipboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { SERVER_URL } from '../config';

// ─── Types ────────────────────────────────────────────────────────────────────

type PlanId = 30 | 90 | 365;

interface Plan {
  id: PlanId;
  labelKey: string;
  duration: string;
  sats: number;
  highlight: boolean;
}

interface Invoice {
  bolt11: string;
  paymentHash: string;
  expiresAt: number;
  amountSats: number;
}

interface Props {
  onBack: () => void;
}

// ─── Plans ────────────────────────────────────────────────────────────────────

const PLANS: Plan[] = [
  { id: 30,  labelKey: 'subscription.plan1m', duration: '30 days',  sats: 5_000,  highlight: false },
  { id: 90,  labelKey: 'subscription.plan3m', duration: '90 days',  sats: 12_000, highlight: true  },
  { id: 365, labelKey: 'subscription.plan1y', duration: '365 days', sats: 40_000, highlight: false },
];

// ─── Screen ───────────────────────────────────────────────────────────────────

export function SubscriptionScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  const [selectedPlan, setSelectedPlan] = useState<PlanId>(90);
  const [loading, setLoading] = useState(false);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [preimageInput, setPreimageInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [activeUntil, setActiveUntil] = useState<number | null>(null);
  const [showPreimageModal, setShowPreimageModal] = useState(false);

  async function requestInvoice(): Promise<void> {
    setLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/web3/subscription/invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planDays: selectedPlan }),
      });
      if (!res.ok) throw new Error(i18nT('subscription.invoiceError'));
      const data: Invoice = await res.json();
      setInvoice(data);
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function activateWithPreimage(): Promise<void> {
    if (!invoice) return;
    const hex = preimageInput.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      Alert.alert(i18nT('subscription.invalidPreimage'), i18nT('subscription.invalidPreimageDesc'));
      return;
    }
    setActivating(true);
    try {
      const res = await fetch(`${SERVER_URL}/web3/subscription/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preimage: hex, paymentHash: invoice.paymentHash }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        throw new Error((err as { error: string }).error ?? 'Activation failed');
      }
      const data: { active: boolean; expiresAt: number; planDays: number } = await res.json();
      setActiveUntil(data.expiresAt);
      setShowPreimageModal(false);
      setPreimageInput('');
      setInvoice(null);
    } catch (e) {
      Alert.alert(i18nT('subscription.activationFailed'), (e as Error).message);
    } finally {
      setActivating(false);
    }
  }

  function copyBolt11(): void {
    if (!invoice) return;
    Clipboard.setString(invoice.bolt11);
    Alert.alert(i18nT('subscription.copiedTitle'), i18nT('subscription.copiedDesc'));
  }

  const plan = PLANS.find((p) => p.id === selectedPlan)!;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('subscription.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 40, gap: 16 }}>

        {/* Active badge */}
        {activeUntil && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: t.radius, backgroundColor: t.accentDeep, borderWidth: 1, borderColor: t.accent }}>
            <I.Shield size={18} color={t.accent} />
            <View>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.2 }}>{i18nT('subscription.activeBadge')}</Text>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text, marginTop: 2 }}>
                {i18nT('subscription.expires', { date: new Date(activeUntil).toLocaleDateString() })}
              </Text>
            </View>
          </View>
        )}

        {/* Privacy notice */}
        <View style={{ padding: 16, borderRadius: t.radius, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.2, marginBottom: 8 }}>{i18nT('subscription.zeroIdentityLabel')}</Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 20 }}>
            {i18nT('subscription.privacyDesc')}
          </Text>
        </View>

        {/* Plan selector */}
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2 }}>{i18nT('subscription.selectPlan')}</Text>
        {PLANS.map((p) => {
          const active = p.id === selectedPlan;
          return (
            <Pressable
              key={p.id}
              onPress={() => setSelectedPlan(p.id)}
              style={{
                padding: 16,
                borderRadius: t.radius,
                backgroundColor: active ? t.accentDeep : t.surface,
                borderWidth: 1,
                borderColor: active ? t.accent : t.border,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <View>
                <Text style={{ fontFamily: t.fontDisplay, fontSize: 16, fontWeight: '600', color: active ? t.accent : t.text }}>
                  {i18nT(p.labelKey)}
                  {p.highlight ? (
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent }}>{i18nT('subscription.bestValue')}</Text>
                  ) : null}
                </Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2 }}>{p.duration}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 16, fontWeight: '700', color: active ? t.accent : t.text }}>
                  {p.sats.toLocaleString()} sats
                </Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{i18nT('subscription.lightningBtc')}</Text>
              </View>
            </Pressable>
          );
        })}

        {/* Invoice section */}
        {invoice ? (
          <View style={{ gap: 12 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2 }}>{i18nT('subscription.invoiceSection')}</Text>

            {/* BOLT11 string */}
            <View style={{ backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.border, padding: 14 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent }} numberOfLines={3} ellipsizeMode="middle">
                {invoice.bolt11}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 6 }}>
                {invoice.amountSats.toLocaleString()} sats · expires {new Date(invoice.expiresAt).toLocaleTimeString()}
              </Text>
            </View>

            <Pressable
              onPress={copyBolt11}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 12 }}
            >
              <I.Copy size={15} color={t.text} />
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '500', color: t.text }}>{i18nT('subscription.copyInvoice')}</Text>
            </Pressable>

            <Pressable
              onPress={() => setShowPreimageModal(true)}
              style={{ backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 13, alignItems: 'center' }}
            >
              <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '700', color: t.bg }}>{i18nT('subscription.paidEnterPreimage')}</Text>
            </Pressable>

            <Pressable onPress={() => setInvoice(null)} style={{ alignItems: 'center', paddingVertical: 8 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint }}>{i18nT('subscription.cancelInvoice')}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => void requestInvoice()}
            disabled={loading}
            style={{ backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 14, alignItems: 'center', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? (
              <ActivityIndicator color={t.bg} />
            ) : (
              <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '700', color: t.bg }}>
                {i18nT('subscription.getInvoiceBtn', { sats: plan.sats.toLocaleString() })}
              </Text>
            )}
          </Pressable>
        )}

        {/* How it works */}
        <View style={{ padding: 16, borderRadius: t.radius, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, gap: 10 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2 }}>{i18nT('subscription.howItWorksTitle')}</Text>
          {(['howItWorksStep1', 'howItWorksStep2', 'howItWorksStep3', 'howItWorksStep4'] as const).map((key) => (
            <Text key={key} style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>{i18nT(`subscription.${key}`)}</Text>
          ))}
        </View>
      </ScrollView>

      {/* Preimage entry modal */}
      <Modal visible={showPreimageModal} transparent animationType="fade" onRequestClose={() => { if (!activating) setShowPreimageModal(false); }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', paddingHorizontal: 22 }}>
          <View style={{ backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.borderStrong, padding: 20, gap: 14 }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '600', color: t.text }}>{i18nT('subscription.preimageTitle')}</Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
              {i18nT('subscription.preimageDesc')}
            </Text>
            <TextInput
              value={preimageInput}
              onChangeText={setPreimageInput}
              placeholder="a1b2c3d4e5f6…"
              placeholderTextColor={t.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, backgroundColor: t.bg, borderColor: t.border, borderWidth: 1, borderRadius: t.radiusS, padding: 12 }}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                disabled={activating}
                onPress={() => { if (!activating) setShowPreimageModal(false); }}
                style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center', opacity: activating ? 0.5 : 1 }}
              >
                <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 13 }}>{i18nT('common.cancel')}</Text>
              </Pressable>
              <Pressable
                disabled={activating}
                onPress={() => void activateWithPreimage()}
                style={{ flex: 1, backgroundColor: t.accent, paddingVertical: 12, borderRadius: t.radiusS, alignItems: 'center', opacity: activating ? 0.6 : 1 }}
              >
                {activating ? (
                  <ActivityIndicator color={t.bg} />
                ) : (
                  <Text style={{ color: t.bg, fontFamily: t.font, fontWeight: '700', fontSize: 13 }}>{i18nT('subscription.preimageActivate')}</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
