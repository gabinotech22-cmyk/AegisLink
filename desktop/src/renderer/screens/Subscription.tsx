import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { homeRelayBaseUrl } from '../net/homeRelay';

type PlanId = 30 | 90 | 365;

interface Plan {
  id: PlanId;
  label: string;
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

const PLANS: Plan[] = [
  { id: 30,  get label() { return i18n.t('subscription.plan1m'); },  duration: '30 days',  sats: 5_000,  highlight: false },
  { id: 90,  get label() { return i18n.t('subscription.plan3m'); }, duration: '90 days',  sats: 12_000, highlight: true  },
  { id: 365, get label() { return i18n.t('subscription.plan1y'); },   duration: '365 days', sats: 40_000, highlight: false },
];

export function SubscriptionScreen({ onBack }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const [selectedPlan, setSelectedPlan] = useState<PlanId>(90);
  const [loading, setLoading] = useState(false);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [preimageInput, setPreimageInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [activeUntil, setActiveUntil] = useState<number | null>(null);
  const [showPreimageModal, setShowPreimageModal] = useState(false);

  async function requestInvoice() {
    setLoading(true);
    try {
      const res = await fetch(`${homeRelayBaseUrl()}/web3/subscription/invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planDays: selectedPlan }),
      });
      if (!res.ok) throw new Error('Could not generate invoice');
      const data: Invoice = await res.json();
      setInvoice(data);
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function activateWithPreimage() {
    if (!invoice) return;
    const hex = preimageInput.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      window.alert(i18n.t('subscription.invalidPreimageMustBe'));
      return;
    }
    setActivating(true);
    try {
      const res = await fetch(`${homeRelayBaseUrl()}/web3/subscription/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preimage: hex, paymentHash: invoice.paymentHash }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        throw new Error((err as { error: string }).error ?? 'Activation failed');
      }
      const data: { active: boolean; expiresAt: number } = await res.json();
      setActiveUntil(data.expiresAt);
      setShowPreimageModal(false);
      setPreimageInput('');
      setInvoice(null);
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setActivating(false);
    }
  }

  function copyBolt11() {
    if (!invoice) return;
    navigator.clipboard.writeText(invoice.bolt11).catch(() => {});
    window.alert(i18n.t('subscription.bolt11InvoiceCopiedTo'));
  }

  const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100, padding: 24, boxSizing: 'border-box',
  };
  const modalStyle: CSSProperties = {
    backgroundColor: t.surface, borderRadius: t.radius, padding: 20,
    width: '100%', maxWidth: 420, boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', gap: 14,
  };
  const inputStyle: CSSProperties = {
    width: '100%', padding: 12, fontFamily: t.fontMono, fontSize: 13,
    color: t.text, backgroundColor: t.bg,
    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('subscription.subscription')} left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 40px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Active badge */}
        {activeUntil && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 14, borderRadius: t.radius, backgroundColor: `${t.accent}14`, border: `1px solid ${t.accent}` }}>
            <I.Shield size={18} color={t.accent} />
            <div>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.2, display: 'block' }}>{i18n.t('workDashboard.keysActiveBadge')}</span>
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.text, marginTop: 2, display: 'block' }}>
                Expires {new Date(activeUntil).toLocaleDateString()}
              </span>
            </div>
          </div>
        )}

        {/* Privacy notice */}
        <div style={{ padding: 16, borderRadius: t.radius, backgroundColor: t.surface, border: `1px solid ${t.border}` }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.2, display: 'block', marginBottom: 8 }}>{i18n.t('subscription.zeroIdentity')}</span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '20px', display: 'block' }}>{i18n.t('subscription.paymentsAreMadeOver')}</span>
        </div>

        {/* Plan selector */}
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2 }}>{i18n.t('subscription.selectPlan')}</span>
        {PLANS.map((p) => {
          const active = p.id === selectedPlan;
          return (
            <button
              key={p.id}
              onClick={() => setSelectedPlan(p.id)}
              aria-label={p.label}
              style={{
                padding: 16, borderRadius: t.radius,
                backgroundColor: active ? `${t.accent}14` : t.surface,
                border: `1px solid ${active ? t.accent : t.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                cursor: 'pointer', width: '100%', boxSizing: 'border-box', textAlign: 'left',
              }}
            >
              <div>
                <span style={{ fontFamily: t.fontDisplay, fontSize: 16, fontWeight: '600', color: active ? t.accent : t.text, display: 'block' }}>
                  {p.label}{p.highlight ? <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, marginLeft: 6, letterSpacing: 0.5 }}>{i18n.t('workDashboard.bestValue')}</span> : null}
                </span>
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2, display: 'block' }}>{p.duration}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 16, fontWeight: '700', color: active ? t.accent : t.text, display: 'block' }}>
                  {p.sats.toLocaleString()} sats
                </span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, display: 'block' }}>{i18n.t('subscription.lightningBtc2')}</span>
              </div>
            </button>
          );
        })}

        {/* Invoice section */}
        {invoice ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2 }}>{i18n.t('subscription.invoiceSection')}</span>
            <div style={{ padding: 12, backgroundColor: t.bg, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, wordBreak: 'break-all' }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, lineHeight: '16px' }}>{invoice.bolt11}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={copyBolt11}
                style={{ flex: 1, padding: '12px 0', backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontSize: 13, color: t.text }}
              >{i18n.t('subscription.copyInvoice')}</button>
              <button
                onClick={() => setShowPreimageModal(true)}
                style={{ flex: 1, padding: '12px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.accentInk }}
              >{i18n.t('subscription.iPaidEnterPreimage')}</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => void requestInvoice()}
            disabled={loading}
            style={{
              width: '100%', padding: '14px 0', backgroundColor: t.accent, border: 'none',
              borderRadius: t.radius, cursor: loading ? 'not-allowed' : 'pointer',
              fontFamily: t.font, fontWeight: '700', fontSize: 14, color: t.accentInk,
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? i18n.t('subscription.generatingInvoice') : i18n.t('subscription.payWithLightning')}
          </button>
        )}
      </div>

      {/* Preimage modal */}
      {showPreimageModal && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>{i18n.t('subscription.preimageTitle')}</span>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '18px' }}>{i18n.t('subscription.afterPayingTheLightning')}</span>
            <input
              value={preimageInput}
              onChange={(e) => setPreimageInput(e.target.value)}
              placeholder={i18n.t('subscription.64CharacterHexPreimage')}
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { setShowPreimageModal(false); setPreimageInput(''); }}
                style={{ flex: 1, padding: '11px 0', border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, cursor: 'pointer', background: 'none', fontFamily: t.font, color: t.text }}
              >{i18n.t('subscription.cancelInvoice')}</button>
              <button
                disabled={activating}
                onClick={() => void activateWithPreimage()}
                style={{ flex: 1, padding: '11px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radiusS, cursor: activating ? 'not-allowed' : 'pointer', fontFamily: t.font, fontWeight: '700', color: t.accentInk, opacity: activating ? 0.7 : 1 }}
              >
                {activating ? i18n.t('subscription.verifying') : i18n.t('subscription.preimageActivate')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
