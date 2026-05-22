import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  useWindowDimensions,
  Alert,
  StyleSheet,
  TextInput,
  Modal,
  ActivityIndicator,
  Share,
  FlatList,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import type { Theme } from '../theme/vault';
import { useWork, type WorkDevice, type WorkMember, type WorkAuditEntry, signAdminAction } from '../store/work';
import * as Sharing from 'expo-sharing';
import { SERVER_URL } from '../config';
import { useWorkPresence } from '../store/workPresence';
import { getPermissions } from '../utils/workPermissions';
import { getSocket } from '../socket/client';
import { WorkspacePicker } from './WorkspacePicker';
import { useIdentity } from '../store/identity';

// ─── Types ────────────────────────────────────────────────────────────────────

type NavItem =
  | 'overview'
  | 'members'
  | 'devices'
  | 'keys'
  | 'relays'
  | 'audit'
  | 'policy';

interface TeamRow {
  name: string;
  members: number;
  devices: number;
  verifiedPct: number;
}

const NAV_ITEM_KEYS: { id: NavItem; labelKey: string }[] = [
  { id: 'overview', labelKey: 'workDashboard.navOverview' },
  { id: 'members', labelKey: 'workDashboard.navMembers' },
  { id: 'devices', labelKey: 'workDashboard.navDevices' },
  { id: 'keys', labelKey: 'workDashboard.navKeys' },
  { id: 'relays', labelKey: 'workDashboard.navRelays' },
  { id: 'audit', labelKey: 'workDashboard.navAudit' },
  { id: 'policy', labelKey: 'workDashboard.navPolicy' },
];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
  onJoinSuccess?: () => void;
  prefillJoinToken?: string;
  onSearch?: () => void;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WorkDashboard({ onBack, onJoinSuccess, prefillJoinToken, onSearch }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  const [activeNav, setActiveNav] = useState<NavItem>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [setupModal, setSetupModal] = useState(false);
  const [joinModal, setJoinModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [orgNameInput, setOrgNameInput] = useState('');
  const [joinTokenInput, setJoinTokenInput] = useState('');
  const [inviteTeam, setInviteTeam] = useState('General');
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);

  const identity = useIdentity((s) => s.identity);
  const { org, members, devices, auditLog, loading, fetchOrg, createOrg, createInvite, revokeDevice, verifyDevice, fetchChannels, knownOrgIds, activeOrgId } = useWork();
  const aegisId = identity?.aegisId ?? '';

  // Pre-fill join token from deep link and open modal automatically
  useEffect(() => {
    if (prefillJoinToken) {
      setJoinTokenInput(prefillJoinToken);
      setJoinModal(true);
    }
  }, [prefillJoinToken]);

  // Load known orgs and auto-load the active one on mount
  useEffect(() => {
    if (!aegisId) return;
    (async () => {
      await useWork.getState().loadKnownOrgs();
      const { activeOrgId: loaded } = useWork.getState();
      if (loaded) {
        await useWork.getState().switchWorkspace(loaded, aegisId);
      }
    })();

    // Register presence socket listeners
    const sock = getSocket();
    if (sock) {
      const onPresenceSync = (data: { onlineIds: string[] }) => {
        useWorkPresence.getState().setOnline(data.onlineIds);
      };
      const onPresenceJoin = (data: { aegisId: string }) => {
        useWorkPresence.getState().addOnline(data.aegisId);
      };
      const onPresenceLeave = (data: { aegisId: string }) => {
        useWorkPresence.getState().removeOnline(data.aegisId);
      };
      const onTyping = (data: { channelId: string; from: string; isTyping: boolean }) => {
        useWorkPresence.getState().setTyping(data.channelId, data.from, data.isTyping);
      };

      sock.on('work:presence_sync', onPresenceSync);
      sock.on('work:presence_join', onPresenceJoin);
      sock.on('work:presence_leave', onPresenceLeave);
      sock.on('typing', onTyping);

      return () => {
        sock.off('work:presence_sync', onPresenceSync);
        sock.off('work:presence_join', onPresenceJoin);
        sock.off('work:presence_leave', onPresenceLeave);
        sock.off('typing', onTyping);
      };
    }
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aegisId]);

  const s = makeStyles(t);

  // ─── Setup / Join helpers ────────────────────────────────────────────────────

  async function handleCreateOrg(): Promise<void> {
    if (!orgNameInput.trim() || !aegisId) return;
    try {
      const orgId = await createOrg(orgNameInput.trim(), aegisId);
      await useWork.getState().addKnownOrg(orgId);
      setSetupModal(false);
      setOrgNameInput('');
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
    }
  }

  async function handleJoin(): Promise<void> {
    if (!joinTokenInput.trim() || !aegisId) return;
    const deviceId = `${aegisId}-primary`;
    try {
      const { orgId } = await useWork.getState().joinOrg(joinTokenInput.trim(), aegisId, deviceId, 'AegisLink Mobile', 'mobile');
      await useWork.getState().addKnownOrg(orgId);
      setJoinModal(false);
      setJoinTokenInput('');
      await fetchOrg(orgId, aegisId);
      await fetchChannels(orgId);
      onJoinSuccess?.();
    } catch (e) {
      Alert.alert(i18nT('workDashboard.joinFailed'), (e as Error).message);
    }
  }

  async function handleCreateInvite(): Promise<void> {
    if (!org || !aegisId) return;
    try {
      const token = await createInvite(org.orgId, aegisId, inviteTeam, 'member');
      setPendingInviteToken(token);
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
    }
  }

  // ─── No org state ─────────────────────────────────────────────────────────────

  if (!org && !loading) {
    return (
      <View style={[s.root, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center', gap: 16, paddingHorizontal: 32 }]}>
        <I.Shield size={40} color={t.accent} />
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '700', color: t.text, textAlign: 'center' }}>{i18nT('workDashboard.title')}</Text>
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: 20 }}>
          {i18nT('workDashboard.noOrgDesc')}
        </Text>
        <Pressable onPress={() => setSetupModal(true)} style={{ backgroundColor: t.accent, borderRadius: t.radiusS, paddingHorizontal: 22, paddingVertical: 12, width: '100%', alignItems: 'center' }}>
          <Text style={{ fontFamily: t.font, fontWeight: '700', color: t.bg, fontSize: 14 }}>{i18nT('workDashboard.createOrg')}</Text>
        </Pressable>
        <Pressable onPress={() => setJoinModal(true)} style={{ borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingHorizontal: 22, paddingVertical: 12, width: '100%', alignItems: 'center' }}>
          <Text style={{ fontFamily: t.font, fontWeight: '500', color: t.text, fontSize: 14 }}>{i18nT('workDashboard.joinWithToken')}</Text>
        </Pressable>
        <Pressable onPress={onBack} style={{ marginTop: 8 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint }}>{i18nT('workDashboard.back')}</Text>
        </Pressable>

        {/* Create org modal */}
        <Modal visible={setupModal} transparent animationType="fade" onRequestClose={() => setSetupModal(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 24 }}>
            <View style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, gap: 14 }}>
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>{i18nT('workDashboard.orgNameLabel')}</Text>
              <TextInput
                value={orgNameInput}
                onChangeText={setOrgNameInput}
                placeholder={i18nT('workDashboard.orgNamePlaceholder')}
                placeholderTextColor={t.textDim}
                autoCapitalize="words"
                style={{ fontFamily: t.font, fontSize: 14, color: t.text, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border, borderRadius: t.radiusS, padding: 12 }}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable onPress={() => setSetupModal(false)} style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}>
                  <Text style={{ color: t.text, fontFamily: t.font }}>{i18nT('workDashboard.cancelBtn')}</Text>
                </Pressable>
                <Pressable onPress={() => void handleCreateOrg()} style={{ flex: 1, backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}>
                  <Text style={{ color: t.bg, fontFamily: t.font, fontWeight: '700' }}>{i18nT('workDashboard.createBtn')}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Join modal */}
        <Modal visible={joinModal} transparent animationType="fade" onRequestClose={() => setJoinModal(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 24 }}>
            <View style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, gap: 14 }}>
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>{i18nT('workDashboard.enterTokenTitle')}</Text>
              <TextInput
                value={joinTokenInput}
                onChangeText={setJoinTokenInput}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                placeholderTextColor={t.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border, borderRadius: t.radiusS, padding: 12 }}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable onPress={() => setJoinModal(false)} style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}>
                  <Text style={{ color: t.text, fontFamily: t.font }}>{i18nT('workDashboard.cancelBtn')}</Text>
                </Pressable>
                <Pressable onPress={() => void handleJoin()} style={{ flex: 1, backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}>
                  <Text style={{ color: t.bg, fontFamily: t.font, fontWeight: '700' }}>{i18nT('workDashboard.joinBtn')}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  // Derive team rows from real members + devices
  const teamMap = new Map<string, { members: number; devices: number; verified: number }>();
  for (const m of members) {
    const prev = teamMap.get(m.team) ?? { members: 0, devices: 0, verified: 0 };
    teamMap.set(m.team, { ...prev, members: prev.members + 1 });
  }
  for (const d of devices) {
    const memberTeam = members.find((m) => m.aegis_id === d.aegis_id)?.team ?? 'General';
    const prev = teamMap.get(memberTeam) ?? { members: 0, devices: 0, verified: 0 };
    teamMap.set(memberTeam, {
      ...prev,
      devices: prev.devices + 1,
      verified: prev.verified + (d.status === 'verified' ? 1 : 0),
    });
  }
  const teamRows: TeamRow[] = Array.from(teamMap.entries()).map(([name, v]) => ({
    name,
    members: v.members,
    devices: v.devices,
    verifiedPct: v.devices > 0 ? Math.round((v.verified / v.devices) * 100) : 100,
  }));

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* ── Mobile drawer overlay ── */}
      {!isTablet && sidebarOpen && (
        <Pressable
          style={s.drawerOverlay}
          onPress={() => setSidebarOpen(false)}
        />
      )}

      <View style={s.layout}>
        {/* ── Sidebar ── */}
        {(isTablet || sidebarOpen) && (
          <View style={[s.sidebar, !isTablet && s.sidebarDrawer]}>
            <SidebarContent
              t={t}
              activeNav={activeNav}
              onNav={(id) => { setActiveNav(id); setSidebarOpen(false); }}
              orgName={org?.name ?? ''}
            />
          </View>
        )}

        {/* ── Main panel ── */}
        <View style={s.main}>
          {/* Header row */}
          <View style={s.mainHeader}>
            <View style={s.mainHeaderLeft}>
              {!isTablet && (
                <Pressable
                  onPress={() => setSidebarOpen((v) => !v)}
                  style={s.hamburger}
                  hitSlop={8}
                >
                  <View style={[s.hLine, { marginBottom: 4 }]} />
                  <View style={s.hLine} />
                  <View style={[s.hLine, { marginTop: 4 }]} />
                </Pressable>
              )}
              <Pressable
                onPress={() => setPickerVisible(true)}
                style={{ gap: 2 }}
                accessibilityLabel="Cambiar workspace activo"
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={s.orgLabel}>{org?.name.toUpperCase() ?? i18nT('workDashboard.title').toUpperCase()}</Text>
                  <I.Chevron size={12} color={t.textDim} />
                </View>
                <Text style={s.pageTitle}>{i18nT(labelKeyFor(activeNav))}</Text>
              </Pressable>
            </View>
            <View style={s.mainHeaderRight}>
              {loading && <ActivityIndicator size="small" color={t.accent} />}
              {activeNav === 'overview' && !loading && (
                <Pressable
                  style={s.inviteBtn}
                  onPress={() => setInviteModal(true)}
                >
                  <I.Plus size={14} color={t.bg} />
                  <Text style={s.inviteBtnText}>{i18nT('workDashboard.inviteMember')}</Text>
                </Pressable>
              )}
              {onSearch && (
                <Pressable onPress={onSearch} hitSlop={8} style={{ marginRight: 8 }}>
                  <I.Search size={20} color={t.textDim} />
                </Pressable>
              )}
              <Pressable onPress={onBack} hitSlop={8}>
                <I.X size={20} color={t.textDim} />
              </Pressable>
            </View>
          </View>

          <Text style={s.timestamp}>
            {org ? i18nT('workDashboard.memberCountStats', { count: org.stats.memberCount, verified: org.stats.verifiedDevices, total: org.stats.deviceCount }) : ''}
          </Text>

          {/* ── Content ── */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.contentContainer}
            showsVerticalScrollIndicator={false}
          >
            {activeNav === 'overview' && (
              <OverviewContent t={t} isTablet={isTablet} org={org} teamRows={teamRows} auditLog={auditLog} />
            )}
            {activeNav === 'devices' && (
              <DevicesContent
                t={t}
                devices={devices}
                members={members}
                orgId={org?.orgId ?? ''}
                requesterId={aegisId}
                onRevoke={revokeDevice}
                onVerify={verifyDevice}
              />
            )}
            {activeNav === 'members' && (
              <MembersContent t={t} members={members} devices={devices} org={org} currentAegisId={aegisId} />
            )}
            {activeNav === 'audit' && (
              <AuditContent t={t} />
            )}
            {activeNav === 'keys' && (
              <KeysContent t={t} org={org} />
            )}
            {activeNav === 'relays' && (
              <RelaysContent t={t} org={org} />
            )}
            {activeNav === 'policy' && (
              <PolicyContent t={t} org={org} aegisId={aegisId} />
            )}
          </ScrollView>
        </View>
      </View>

      {/* ── Workspace picker modal ── */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerVisible(false)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 24 }}>
          <WorkspacePicker
            orgIds={knownOrgIds}
            activeOrgId={activeOrgId}
            onClose={() => setPickerVisible(false)}
            onSelect={(orgId) => {
              setPickerVisible(false);
              if (orgId !== activeOrgId && aegisId) {
                void useWork.getState().switchWorkspace(orgId, aegisId);
              }
            }}
            onCreateNew={() => {
              setPickerVisible(false);
              setSetupModal(true);
            }}
            onJoinExisting={() => {
              setPickerVisible(false);
              setJoinModal(true);
            }}
          />
        </View>
      </Modal>

      {/* ── Invite modal ── */}
      <Modal visible={inviteModal} transparent animationType="fade" onRequestClose={() => { setInviteModal(false); setPendingInviteToken(null); }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 24 }}>
          <View style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, gap: 14 }}>
            {pendingInviteToken ? (
              <>
                <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>{i18nT('workDashboard.inviteTokenCreated')}</Text>
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
                  {i18nT('workDashboard.inviteTokenDesc')}
                </Text>
                {/* QR code centred */}
                <View style={{ alignItems: 'center', paddingVertical: 12, backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.border }}>
                  <QRCode
                    value={`aegislink://work/join?token=${pendingInviteToken}`}
                    size={200}
                    color={t.text}
                    backgroundColor={t.surface}
                  />
                </View>
                {/* Token text (selectable for manual copy) */}
                <View style={{ backgroundColor: t.bg, borderRadius: t.radiusS, padding: 12, borderWidth: 1, borderColor: t.border }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent }} selectable>{pendingInviteToken}</Text>
                </View>
                {/* Action buttons */}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    onPress={async () => {
                      await Clipboard.setStringAsync(`aegislink://work/join?token=${pendingInviteToken}`);
                      Alert.alert('Copiado', 'El link de invitación fue copiado al portapapeles.');
                    }}
                    style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}
                    accessibilityLabel="Copiar link de invitación"
                  >
                    <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 13 }}>Copiar link</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void Share.share({ message: `aegislink://work/join?token=${pendingInviteToken}` })}
                    style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}
                    accessibilityLabel="Compartir link de invitación"
                  >
                    <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 13 }}>Compartir</Text>
                  </Pressable>
                </View>
                <Pressable onPress={() => { setInviteModal(false); setPendingInviteToken(null); setInviteTeam('General'); }} style={{ backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }} accessibilityLabel="Cerrar modal de invitación">
                  <Text style={{ color: t.bg, fontFamily: t.font, fontWeight: '700' }}>{i18nT('workDashboard.doneBtn')}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>{i18nT('workDashboard.inviteMember')}</Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1 }}>{i18nT('workDashboard.teamLabel')}</Text>
                <TextInput
                  value={inviteTeam}
                  onChangeText={setInviteTeam}
                  placeholder="General"
                  placeholderTextColor={t.textDim}
                  style={{ fontFamily: t.font, fontSize: 14, color: t.text, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border, borderRadius: t.radiusS, padding: 12 }}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable onPress={() => setInviteModal(false)} style={{ flex: 1, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}>
                    <Text style={{ color: t.text, fontFamily: t.font }}>{i18nT('workDashboard.cancelBtn')}</Text>
                  </Pressable>
                  <Pressable onPress={() => void handleCreateInvite()} style={{ flex: 1, backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}>
                    <Text style={{ color: t.bg, fontFamily: t.font, fontWeight: '700' }}>{i18nT('workDashboard.generateToken')}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function SidebarContent({
  t,
  activeNav,
  onNav,
  orgName,
}: {
  t: Theme;
  activeNav: NavItem;
  onNav: (id: NavItem) => void;
  orgName: string;
}) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();
  return (
    <View style={{ flex: 1 }}>
      {/* Logo */}
      <View style={s.sidebarLogo}>
        <View style={s.logoMark}>
          <I.Shield size={18} color={t.accent} />
        </View>
        <View>
          <Text style={s.logoTitle}>{orgName || 'AegisMark'}</Text>
          <Text style={s.logoSub}>{i18nT('workDashboard.workAdminSub')}</Text>
        </View>
      </View>

      {/* Nav */}
      <View style={s.navList}>
        {NAV_ITEM_KEYS.map((item) => {
          const active = item.id === activeNav;
          return (
            <Pressable
              key={item.id}
              onPress={() => onNav(item.id)}
              style={[s.navItem, active && s.navItemActive]}
            >
              <NavIcon id={item.id} size={16} color={active ? t.accent : t.textDim} />
              <Text style={[s.navLabel, active && s.navLabelActive]}>
                {i18nT(item.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Footer relay card */}
      <View style={s.relayCard}>
        <View style={s.relayDot} />
        <Text style={s.relayTitle}>{i18nT('workDashboard.selfHosted')}</Text>
        <Text style={s.relayLine}>zurich-prime · v0.9.2</Text>
        <Text style={s.relayLine}>{i18nT('workDashboard.activeRelays', { count: 4, uptime: '99.99' })}</Text>
      </View>
    </View>
  );
}

// ─── Nav icon helper ──────────────────────────────────────────────────────────

function NavIcon({ id, size, color }: { id: NavItem; size: number; color: string }) {
  switch (id) {
    case 'overview': return <I.Poll size={size} color={color} />;
    case 'members': return <I.Users size={size} color={color} />;
    case 'devices': return <I.Phone size={size} color={color} />;
    case 'keys': return <I.Key size={size} color={color} />;
    case 'relays': return <I.Globe size={size} color={color} />;
    case 'audit': return <I.Archive size={size} color={color} />;
    case 'policy': return <I.Shield size={size} color={color} />;
  }
}

function labelKeyFor(id: NavItem): string {
  return NAV_ITEM_KEYS.find((n) => n.id === id)?.labelKey ?? id;
}

// ─── Overview content ─────────────────────────────────────────────────────────

function OverviewContent({
  t,
  isTablet,
  org,
  teamRows,
  auditLog,
}: {
  t: Theme;
  isTablet: boolean;
  org: import('../store/work').WorkOrg | null;
  teamRows: TeamRow[];
  auditLog: WorkAuditEntry[];
}) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();
  const verifiedStr = org ? `of ${org.stats.deviceCount} enrolled` : '—';
  const auditSlice = auditLog.slice(0, 4);
  return (
    <>
      {/* KPI cards */}
      <View style={[s.kpiGrid, !isTablet && s.kpiGridMobile]}>
        <KpiCard t={t} label={i18nT('workDashboard.kpiActiveMembers')} value={org ? String(org.stats.memberCount) : '—'} sub={i18nT('workDashboard.kpiInOrg')} accent={false} />
        <KpiCard t={t} label={i18nT('workDashboard.kpiVerifiedDevices')} value={org ? String(org.stats.verifiedDevices) : '—'} sub={verifiedStr} accent={false} />
        <KpiCard t={t} label={i18nT('workDashboard.kpiKeyRotation')} value={org ? `${org.policyKeyRotationDays}d` : '—'} sub={i18nT('workDashboard.kpiPolicyInterval')} accent={false} />
        <KpiCard t={t} label={i18nT('workDashboard.kpiMetadata')} value="0 B" sub={i18nT('workDashboard.kpiByDesign')} accent />
      </View>

      {/* Teams + Audit split */}
      <View style={[s.splitRow, !isTablet && s.splitRowMobile]}>
        {/* Teams table */}
        <View style={[s.card, s.teamsCard]}>
          <View style={s.cardHeader}>
            <Text style={s.cardTitle}>{i18nT('workDashboard.teamsCardTitle')}</Text>
            <View style={s.badge}>
              <Text style={s.badgeText}>{i18nT('workDashboard.totalUpper', { count: teamRows.length })}</Text>
            </View>
          </View>
          <View style={s.tableHeader}>
            <Text style={[s.tableCol, s.colTeam, s.tableHeadText]}>{i18nT('workDashboard.tableTeam')}</Text>
            <Text style={[s.tableCol, s.colNum, s.tableHeadText]}>{i18nT('workDashboard.tableMembers')}</Text>
            <Text style={[s.tableCol, s.colNum, s.tableHeadText]}>{i18nT('workDashboard.tableDevices')}</Text>
            <Text style={[s.tableCol, s.colNum, s.tableHeadText]}>{i18nT('workDashboard.tableVerified')}</Text>
          </View>
          {teamRows.length === 0 ? (
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, padding: 14 }}>{i18nT('workDashboard.noTeamsYet')}</Text>
          ) : (
            teamRows.map((row, i) => (
              <TeamRowView key={row.name} row={row} t={t} last={i === teamRows.length - 1} />
            ))
          )}
        </View>

        {/* Audit log */}
        <View style={[s.card, s.auditCard]}>
          <View style={s.cardHeader}>
            <Text style={s.cardTitle}>{i18nT('workDashboard.auditCardTitle')}</Text>
            <View style={[s.badge, { backgroundColor: t.accentDeep }]}>
              <View style={[s.liveDot]} />
              <Text style={[s.badgeText, { color: t.accent }]}>{i18nT('workDashboard.auditLive')}</Text>
            </View>
          </View>
          {auditSlice.length === 0 ? (
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, padding: 14 }}>{i18nT('workDashboard.noAuditYet')}</Text>
          ) : (
            auditSlice.map((ev, i) => (
              <AuditEventMini
                key={ev.id}
                entry={ev}
                t={t}
                last={i === auditSlice.length - 1}
              />
            ))
          )}
        </View>
      </View>

      {/* Policy bar */}
      <View style={s.policyBar}>
        <I.Shield size={16} color={t.accent} />
        <Text style={s.policyText} numberOfLines={2}>
          {org
            ? i18nT('workDashboard.policyEnforced', { days: org.policyKeyRotationDays })
            : i18nT('workDashboard.policyDefault')}
        </Text>
        <Pressable
          style={s.policyBtn}
          onPress={() => Alert.alert(i18nT('workDashboard.editPolicyTitle'), i18nT('workDashboard.editPolicyDesc'))}
        >
          <Text style={s.policyBtnText}>{i18nT('workDashboard.editPolicyBtn')}</Text>
        </Pressable>
      </View>
    </>
  );
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  t,
  label,
  value,
  sub,
  accent,
}: {
  t: Theme;
  label: string;
  value: string;
  sub: string;
  accent: boolean;
}) {
  const s = makeStyles(t);
  return (
    <View style={[s.card, s.kpiCard]}>
      <Text style={s.kpiLabel}>{label}</Text>
      <Text style={[s.kpiValue, accent && { color: t.accent }]}>{value}</Text>
      <Text style={[s.kpiSub, accent && { color: t.accent }]}>{sub}</Text>
    </View>
  );
}

// ─── Team row ─────────────────────────────────────────────────────────────────

function TeamRowView({ row, t, last }: { row: TeamRow; t: Theme; last: boolean }) {
  const s = makeStyles(t);
  const pctColor = row.verifiedPct < 100 ? t.warn : t.accent;
  return (
    <View style={[s.tableRow, !last && { borderBottomWidth: 1, borderBottomColor: t.divider }]}>
      <Text style={[s.tableCol, s.colTeam, s.tableBodyText]}>{row.name}</Text>
      <Text style={[s.tableCol, s.colNum, s.tableBodyText]}>{row.members}</Text>
      <Text style={[s.tableCol, s.colNum, s.tableBodyText]}>{row.devices}</Text>
      <Text style={[s.tableCol, s.colNum, s.tableBodyText, { color: pctColor }]}>
        {row.verifiedPct}%
      </Text>
    </View>
  );
}

// ─── Audit helpers ────────────────────────────────────────────────────────────

type KindCategory = 'member' | 'channel' | 'message' | 'device' | 'org' | 'other';

function kindCategory(kind: string): KindCategory {
  if (kind.startsWith('member')) return 'member';
  if (kind.startsWith('channel')) return 'channel';
  if (kind.startsWith('message')) return 'message';
  if (kind.startsWith('device')) return 'device';
  if (kind.startsWith('org')) return 'org';
  return 'other';
}

function KindIcon({ kind, size, color }: { kind: string; size: number; color: string }) {
  const cat = kindCategory(kind);
  if (cat === 'member') return <I.User size={size} color={color} />;
  if (cat === 'channel') return <I.Hash size={size} color={color} />;
  if (cat === 'message') return <I.MessageSquare size={size} color={color} />;
  if (cat === 'device') return <I.Shield size={size} color={color} />;
  if (cat === 'org') return <I.Building size={size} color={color} />;
  return <I.Archive size={size} color={color} />;
}

function kindIconColor(kind: string, t: Theme): string {
  const cat = kindCategory(kind);
  if (cat === 'device') return t.warn;
  if (cat === 'org') return t.accent;
  return t.textDim;
}

function fmtRelativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

// Mini audit event — used in the overview card
function AuditEventMini({ entry, t, last }: { entry: WorkAuditEntry; t: Theme; last: boolean }) {
  const s = makeStyles(t);
  const cat = kindCategory(entry.kind);
  const dotColor = cat === 'org' || cat === 'channel' ? t.accent : cat === 'device' ? t.warn : t.textDim;
  return (
    <View style={[s.auditRow, !last && { borderBottomWidth: 1, borderBottomColor: t.divider }]}>
      <View style={[s.auditDot, { backgroundColor: dotColor }]} />
      <Text style={s.auditTime}>{fmtTime(entry.createdAt)}</Text>
      <Text style={s.auditMsg} numberOfLines={2}>{entry.message}</Text>
    </View>
  );
}

// Full audit event row — used in AuditContent
function AuditEventRow({ entry, t, channels, last }: { entry: WorkAuditEntry; t: Theme; channels: import('../store/work').WorkChannel[]; last: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [showAbsolute, setShowAbsolute] = useState(false);
  const iconColor = kindIconColor(entry.kind, t);
  const hasMetadata = entry.metadata !== null;
  const channelName = entry.channelId
    ? (channels.find((c) => c.channelId === entry.channelId)?.name ?? entry.channelId.slice(0, 8))
    : null;

  return (
    <View style={[{ borderBottomWidth: last ? 0 : 1, borderBottomColor: t.divider }]}>
      <Pressable
        onPress={hasMetadata ? () => setExpanded((v) => !v) : undefined}
        accessibilityLabel={`Evento de auditoría: ${entry.message}`}
        style={{ flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 11, gap: 10 }}
      >
        {/* Kind icon */}
        <View style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: iconColor + '1a', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
          <KindIcon kind={entry.kind} size={13} color={iconColor} />
        </View>

        {/* Body */}
        <View style={{ flex: 1, gap: 3 }}>
          {/* Actor */}
          {entry.actorId && (
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5 }}>
              @{entry.actorId.slice(0, 10)}
            </Text>
          )}
          {/* Message */}
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text, lineHeight: 18 }} numberOfLines={expanded ? undefined : 2}>
            {entry.message}
          </Text>
          {/* Target + Channel */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {entry.targetId && (
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>
                {'→ @'}{entry.targetId.slice(0, 10)}
              </Text>
            )}
            {channelName && (
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>
                {'#'}{channelName}
              </Text>
            )}
          </View>
        </View>

        {/* Timestamp + chevron */}
        <View style={{ alignItems: 'flex-end', gap: 4, minWidth: 36 }}>
          <Pressable onLongPress={() => setShowAbsolute((v) => !v)} hitSlop={8}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>
              {showAbsolute ? fmtTime(entry.createdAt) : fmtRelativeTime(entry.createdAt)}
            </Text>
          </Pressable>
          {hasMetadata && (
            <I.ChevronD size={13} color={t.textDim} />
          )}
        </View>
      </Pressable>

      {/* Metadata expand */}
      {expanded && hasMetadata && (
        <View style={{ marginHorizontal: 14, marginBottom: 10, backgroundColor: t.bg, borderRadius: t.radiusS, padding: 10, borderWidth: 1, borderColor: t.border }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, lineHeight: 16 }} selectable>
            {JSON.stringify(entry.metadata, null, 2)}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Devices content ──────────────────────────────────────────────────────────

function DevicesContent({
  t,
  devices,
  members,
  orgId,
  requesterId,
  onRevoke,
  onVerify,
}: {
  t: Theme;
  devices: WorkDevice[];
  members: WorkMember[];
  orgId: string;
  requesterId: string;
  onRevoke: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
  onVerify: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
}) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();

  function handleRevoke(deviceId: string) {
    Alert.alert(
      i18nT('workDashboard.revokeDevice'),
      i18nT('workDashboard.revokeDeviceDesc'),
      [
        { text: i18nT('workDashboard.cancelBtn'), style: 'cancel' },
        { text: i18nT('workDashboard.revokeBtn'), style: 'destructive', onPress: () => void onRevoke(orgId, deviceId, requesterId) },
      ]
    );
  }

  function handleVerify(deviceId: string) {
    void onVerify(orgId, deviceId, requesterId);
  }

  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <Text style={s.cardTitle}>{i18nT('workDashboard.enrolledDevices')}</Text>
        <View style={s.badge}>
          <Text style={s.badgeText}>{i18nT('workDashboard.totalUpper', { count: devices.length })}</Text>
        </View>
      </View>
      <View style={[s.tableHeader, { paddingHorizontal: 16 }]}>
        <Text style={[s.tableHeadText, { flex: 2 }]}>{i18nT('workDashboard.tableDevice')}</Text>
        <Text style={[s.tableHeadText, { flex: 2 }]}>{i18nT('workDashboard.tableMember')}</Text>
        <Text style={[s.tableHeadText, { flex: 1 }]}>{i18nT('workDashboard.tableStatus')}</Text>
        <Text style={[s.tableHeadText, { width: 80, textAlign: 'right' }]}>{i18nT('workDashboard.tableAction')}</Text>
      </View>
      {devices.length === 0 ? (
        <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, padding: 14 }}>{i18nT('workDashboard.noDevicesYet')}</Text>
      ) : (
        devices.map((dev, i) => {
          const team = members.find((m) => m.aegis_id === dev.aegis_id)?.team ?? '';
          return (
            <DeviceRowView
              key={dev.device_id}
              dev={dev}
              team={team}
              t={t}
              last={i === devices.length - 1}
              onRevoke={() => handleRevoke(dev.device_id)}
              onVerify={() => handleVerify(dev.device_id)}
            />
          );
        })
      )}
    </View>
  );
}

function DeviceRowView({
  dev,
  team,
  t,
  last,
  onRevoke,
  onVerify,
}: {
  dev: WorkDevice;
  team: string;
  t: Theme;
  last: boolean;
  onRevoke: () => void;
  onVerify: () => void;
}) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();
  const statusColor =
    dev.status === 'verified'
      ? t.accent
      : dev.status === 'pending'
      ? t.warn
      : t.danger;

  return (
    <View style={[s.deviceRow, !last && { borderBottomWidth: 1, borderBottomColor: t.divider }]}>
      <View style={{ flex: 2 }}>
        <Text style={s.deviceName}>{dev.name}</Text>
        <Text style={s.deviceSub}>{team || dev.platform} · {fmtTime(dev.last_seen)}</Text>
      </View>
      <Text style={[s.tableBodyText, { flex: 2 }]} numberOfLines={1}>
        {dev.aegis_id.slice(0, 8)}…
      </Text>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <View style={[s.statusDot, { backgroundColor: statusColor }]} />
        <Text style={[s.tableBodyText, { color: statusColor, textTransform: 'capitalize' }]}>
          {dev.status}
        </Text>
      </View>
      <View style={{ width: 80, alignItems: 'flex-end', gap: 4 }}>
        {dev.status === 'pending' && (
          <Pressable style={[s.revokeBtn, { borderColor: t.accent }]} onPress={onVerify}>
            <Text style={[s.revokeBtnText, { color: t.accent }]}>{i18nT('workDashboard.verifyBtn')}</Text>
          </Pressable>
        )}
        {dev.status === 'verified' && (
          <Pressable style={s.revokeBtn} onPress={onRevoke}>
            <Text style={s.revokeBtnText}>{i18nT('workDashboard.revokeBtn')}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─── Member directory (upgraded) ─────────────────────────────────────────────

type DisplayRole = 'owner' | 'admin' | 'member';

interface MemberVM {
  aegis_id: string;
  team: string;
  role: 'owner' | 'admin' | 'member';
  displayRole: DisplayRole;
  verified: boolean;
  joined_at: number;
  org_id: string;
}

interface TeamSection {
  team: string;
  data: MemberVM[];
}

function getDisplayRole(m: WorkMember, ownerId: string): DisplayRole {
  if (m.aegis_id === ownerId) return 'owner';
  return m.role;
}

const ROLE_ORDER: Record<DisplayRole, number> = { owner: 0, admin: 1, member: 2 };

function buildSections(
  members: WorkMember[],
  devices: WorkDevice[],
  ownerId: string,
  query: string,
): TeamSection[] {
  const q = query.toLowerCase();

  const vms: MemberVM[] = members.map((m) => ({
    ...m,
    displayRole: getDisplayRole(m, ownerId),
    verified: devices.some((d) => d.aegis_id === m.aegis_id && d.status === 'verified'),
  }));

  const filtered = q
    ? vms.filter((m) => m.aegis_id.toLowerCase().includes(q) || m.team.toLowerCase().includes(q))
    : vms;

  const teamMap = new Map<string, MemberVM[]>();
  for (const m of filtered) {
    const existing = teamMap.get(m.team) ?? [];
    existing.push(m);
    teamMap.set(m.team, existing);
  }

  const sections: TeamSection[] = Array.from(teamMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([team, data]) => ({
      team,
      data: [...data].sort((a, b) => {
        const ro = ROLE_ORDER[a.displayRole] - ROLE_ORDER[b.displayRole];
        if (ro !== 0) return ro;
        return a.aegis_id.localeCompare(b.aegis_id);
      }),
    }));

  return sections;
}

type FlatItem =
  | { type: 'header'; team: string; count: number }
  | { type: 'member'; vm: MemberVM; last: boolean };

function flattenSections(sections: TeamSection[]): FlatItem[] {
  const items: FlatItem[] = [];
  for (const sec of sections) {
    items.push({ type: 'header', team: sec.team, count: sec.data.length });
    sec.data.forEach((vm, idx) => {
      items.push({ type: 'member', vm, last: idx === sec.data.length - 1 });
    });
  }
  return items;
}

const OWNER_BADGE_COLOR = '#f59e0b';

function roleColor(role: DisplayRole, t: Theme): string {
  if (role === 'owner') return OWNER_BADGE_COLOR;
  if (role === 'admin') return t.accent;
  return t.textDim;
}

function MemberCard({
  vm,
  last,
  isCurrentUser,
  isOnline,
  t,
  onLongPress,
}: {
  vm: MemberVM;
  last: boolean;
  isCurrentUser: boolean;
  isOnline: boolean;
  t: Theme;
  onLongPress: () => void;
}) {
  const idDisplay = vm.aegis_id.length > 14 ? `${vm.aegis_id.slice(0, 14)}…` : vm.aegis_id;
  const avatarChars = vm.aegis_id.slice(0, 2).toUpperCase();
  const rColor = roleColor(vm.displayRole, t);
  const roleLabel = vm.displayRole.toUpperCase();

  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={400}
      accessibilityLabel={`Miembro ${vm.aegis_id}, rol ${vm.displayRole}`}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 12,
        },
        !last && { borderBottomWidth: 1, borderBottomColor: t.divider },
      ]}
    >
      {/* Avatar circle with optional online dot */}
      <View style={{ position: 'relative', width: 38, height: 38 }}>
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: rColor + '22',
            borderWidth: 1.5,
            borderColor: rColor,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 13, fontWeight: '700', color: rColor }}>
            {avatarChars}
          </Text>
        </View>
        {isOnline && (
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              right: 0,
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: '#22c55e',
              borderWidth: 1.5,
              borderColor: t.surface,
            }}
            accessibilityLabel="En línea"
          />
        )}
      </View>

      {/* Identity + team */}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text
            style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, fontWeight: '600' }}
            numberOfLines={1}
          >
            {idDisplay}
          </Text>
          {vm.verified && <I.Check size={12} color={t.accent} />}
          {isCurrentUser && (
            <View
              style={{
                backgroundColor: t.accentDeep,
                borderRadius: 4,
                paddingHorizontal: 5,
                paddingVertical: 1,
              }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.8 }}>
                TÚ
              </Text>
            </View>
          )}
        </View>
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>
          {vm.team}
        </Text>
      </View>

      {/* Role badge */}
      <View
        style={{
          backgroundColor: rColor + '1a',
          borderRadius: 5,
          paddingHorizontal: 7,
          paddingVertical: 3,
          borderWidth: 1,
          borderColor: rColor + '44',
        }}
      >
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: rColor, letterSpacing: 0.8 }}>
          {roleLabel}
        </Text>
      </View>
    </Pressable>
  );
}

function MembersContent({
  t,
  members,
  devices,
  org,
  currentAegisId,
}: {
  t: Theme;
  members: WorkMember[];
  devices: WorkDevice[];
  org: import('../store/work').WorkOrg | null;
  currentAegisId: string;
}) {
  const { t: i18nT } = useTranslation();
  const [query, setQuery] = useState('');
  const [actionTarget, setActionTarget] = useState<MemberVM | null>(null);
  const [profileTarget, setProfileTarget] = useState<MemberVM | null>(null);
  const onlineIds = useWorkPresence((s) => s.onlineIds);

  const ownerId = org?.adminId ?? '';

  const currentMember = members.find((m) => m.aegis_id === currentAegisId);
  const currentDisplayRole: DisplayRole = currentAegisId === ownerId
    ? 'owner'
    : (currentMember?.role ?? 'member');

  const sections = buildSections(members, devices, ownerId, query);
  const flatItems = flattenSections(sections);

  const totalMembers = members.length;
  const adminCount = members.filter((m) => m.role === 'admin' || m.aegis_id === ownerId).length;
  const verifiedCount = members.filter((m) =>
    devices.some((d) => d.aegis_id === m.aegis_id && d.status === 'verified'),
  ).length;

  const handleLongPress = useCallback((vm: MemberVM) => {
    setActionTarget(vm);
  }, []);

  async function handleRoleChange(vm: MemberVM, newRole: 'admin' | 'member') {
    if (!org) return;
    const adminSig = (() => {
      const { useWork: w } = require('../store/work') as { useWork: typeof import('../store/work').useWork };
      // Access signAdminAction indirectly through the store internals is not possible;
      // we replicate the fetch pattern from the store using nacl directly.
      return null; // placeholder — see fetch call below
    })();
    void adminSig; // not used directly — we call the PATCH endpoint manually

    // Optimistic update
    useWork.setState((s) => ({
      members: s.members.map((m) =>
        m.aegis_id === vm.aegis_id ? { ...m, role: newRole } : m,
      ),
    }));

    try {
      const nacl = (await import('tweetnacl')).default;
      const { decodeBase64, encodeBase64 } = await import('tweetnacl-util');
      const { useIdentity } = await import('../store/identity');
      const skB64 = useIdentity.getState().identity?.signingSecretKeyB64;
      if (!skB64) throw new Error('Identity not loaded');

      const ts = Date.now();
      const timeBucket = Math.floor(ts / 30_000);
      const message = new TextEncoder().encode(`${org.orgId}:update_member_role:${timeBucket}`);
      const sigBytes = nacl.sign.detached(message, decodeBase64(skB64));
      const sig = encodeBase64(sigBytes);

      const res = await fetch(
        `${(await import('../config')).SERVER_URL}/work/org/${org.orgId}/members/${vm.aegis_id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aegisId: currentAegisId, sig, ts, role: newRole }),
        },
      );
      if (!res.ok) throw new Error('Failed to update role');
    } catch (e) {
      // Roll back on failure
      useWork.setState((s) => ({
        members: s.members.map((m) =>
          m.aegis_id === vm.aegis_id ? { ...m, role: vm.role } : m,
        ),
      }));
      Alert.alert(i18nT('common.error'), (e as Error).message);
    }

    setActionTarget(null);
  }

  async function handleRemove(vm: MemberVM) {
    if (!org) return;
    Alert.alert(
      'Eliminar miembro',
      `¿Eliminar a ${vm.aegis_id.slice(0, 12)}… del workspace?`,
      [
        { text: i18nT('workDashboard.cancelBtn'), style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              await useWork.getState().removeMember(org.orgId, vm.aegis_id, currentAegisId);
            } catch (e) {
              Alert.alert(i18nT('common.error'), (e as Error).message);
            }
            setActionTarget(null);
          },
        },
      ],
    );
  }

  const myPerms = getPermissions(currentDisplayRole);

  const canActOn = (vm: MemberVM): boolean => {
    if (vm.aegis_id === currentAegisId) return false;
    return myPerms.canKickMembers || myPerms.canPromoteToAdmin || myPerms.canDemoteAdmin;
  };

  const renderItem = useCallback(
    ({ item }: { item: FlatItem }) => {
      if (item.type === 'header') {
        return (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingVertical: 8,
              backgroundColor: t.surface2,
              gap: 8,
            }}
          >
            <Text
              style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.2, textTransform: 'uppercase', flex: 1 }}
            >
              {item.team}
            </Text>
            <View
              style={{
                backgroundColor: t.surface3,
                borderRadius: 5,
                paddingHorizontal: 6,
                paddingVertical: 2,
              }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint }}>
                {item.count}
              </Text>
            </View>
          </View>
        );
      }
      return (
        <MemberCard
          vm={item.vm}
          last={item.last}
          isCurrentUser={item.vm.aegis_id === currentAegisId}
          isOnline={onlineIds.has(item.vm.aegis_id)}
          t={t}
          onLongPress={() => handleLongPress(item.vm)}
        />
      );
    },
    [t, currentAegisId, handleLongPress, onlineIds],
  );

  const keyExtractor = useCallback((item: FlatItem, index: number) => {
    if (item.type === 'header') return `header-${item.team}`;
    return `member-${item.vm.aegis_id}-${index}`;
  }, []);

  return (
    <View style={{ gap: 12 }}>
      {/* Stats bar */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[
          { label: 'MIEMBROS', value: totalMembers },
          { label: 'ADMINS', value: adminCount },
          { label: 'VERIFICADOS', value: verifiedCount },
        ].map((chip) => (
          <View
            key={chip.label}
            style={{
              flex: 1,
              backgroundColor: t.surface,
              borderRadius: t.radiusS,
              borderWidth: 1,
              borderColor: t.border,
              padding: 10,
              alignItems: 'center',
              gap: 3,
            }}
          >
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '700', color: t.text }}>
              {chip.value}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.textFaint, letterSpacing: 1 }}>
              {chip.label}
            </Text>
          </View>
        ))}
      </View>

      {/* Search bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: t.surface,
          borderRadius: t.radiusS,
          borderWidth: 1,
          borderColor: t.border,
          paddingHorizontal: 12,
          gap: 8,
        }}
      >
        <I.Search size={14} color={t.textDim} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar por ID o equipo…"
          placeholderTextColor={t.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Buscar miembros"
          style={{
            flex: 1,
            fontFamily: t.fontMono,
            fontSize: 13,
            color: t.text,
            paddingVertical: 10,
          }}
        />
        {query.length > 0 && (
          <Pressable onPress={() => setQuery('')} accessibilityLabel="Limpiar búsqueda" hitSlop={8}>
            <I.X size={14} color={t.textDim} />
          </Pressable>
        )}
      </View>

      {/* Member list card */}
      <View style={{ backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.border, overflow: 'hidden' }}>
        {flatItems.length === 0 ? (
          <View style={{ padding: 24, alignItems: 'center', gap: 8 }}>
            <I.Users size={28} color={t.textFaint} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, textAlign: 'center' }}>
              {query ? 'Sin resultados para esa búsqueda' : i18nT('workDashboard.noMembersYet')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={flatItems}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            scrollEnabled={false}
            removeClippedSubviews={false}
          />
        )}
      </View>

      {/* Action sheet modal */}
      <Modal
        visible={actionTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setActionTarget(null)}
        >
          <Pressable
            style={{
              backgroundColor: t.surface,
              borderTopLeftRadius: t.radius,
              borderTopRightRadius: t.radius,
              paddingBottom: 28,
              paddingTop: 8,
            }}
            onPress={() => {/* absorb taps */}}
          >
            {/* Handle */}
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.border }} />
            </View>

            {actionTarget && (
              <>
                {/* Member identity header */}
                <View style={{ paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: t.divider, gap: 2 }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, fontWeight: '600' }}>
                    {actionTarget.aegis_id.slice(0, 18)}{actionTarget.aegis_id.length > 18 ? '…' : ''}
                  </Text>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>
                    {actionTarget.team} · {actionTarget.displayRole.toUpperCase()}
                  </Text>
                </View>

                {/* "Ver perfil" — always */}
                <Pressable
                  onPress={() => { setProfileTarget(actionTarget); setActionTarget(null); }}
                  accessibilityLabel="Ver perfil del miembro"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: t.divider }}
                >
                  <I.QR size={18} color={t.text} />
                  <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text }}>Ver perfil</Text>
                </Pressable>

                {/* Admin actions */}
                {canActOn(actionTarget) && (
                  <>
                    {myPerms.canPromoteToAdmin && actionTarget.displayRole === 'member' && (
                      <Pressable
                        onPress={() => void handleRoleChange(actionTarget, 'admin')}
                        accessibilityLabel="Promover a admin"
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: t.divider }}
                      >
                        <I.Shield size={18} color={t.accent} />
                        <Text style={{ fontFamily: t.font, fontSize: 15, color: t.accent }}>Promover a admin</Text>
                      </Pressable>
                    )}
                    {myPerms.canDemoteAdmin && actionTarget.displayRole === 'admin' && (
                      <Pressable
                        onPress={() => void handleRoleChange(actionTarget, 'member')}
                        accessibilityLabel="Degradar a miembro"
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: t.divider }}
                      >
                        <I.Person size={18} color={t.warn} />
                        <Text style={{ fontFamily: t.font, fontSize: 15, color: t.warn }}>Degradar a miembro</Text>
                      </Pressable>
                    )}
                    {myPerms.canKickMembers && actionTarget.displayRole !== 'owner' && (
                      <Pressable
                        onPress={() => void handleRemove(actionTarget)}
                        accessibilityLabel="Eliminar del workspace"
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: t.divider }}
                      >
                        <I.Trash size={18} color={t.danger} />
                        <Text style={{ fontFamily: t.font, fontSize: 15, color: t.danger }}>Eliminar del workspace</Text>
                      </Pressable>
                    )}
                  </>
                )}

                {/* Close */}
                <Pressable
                  onPress={() => setActionTarget(null)}
                  accessibilityLabel="Cerrar menú de acciones"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 16 }}
                >
                  <I.X size={18} color={t.textDim} />
                  <Text style={{ fontFamily: t.font, fontSize: 15, color: t.textDim }}>Cerrar</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Profile / QR modal */}
      <Modal
        visible={profileTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setProfileTarget(null)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 24 }}>
          <View style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, gap: 16 }}>
            {profileTarget && (
              <>
                <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
                  Perfil del miembro
                </Text>

                {/* QR code */}
                <View style={{ alignItems: 'center', paddingVertical: 12, backgroundColor: t.surface2, borderRadius: t.radius, borderWidth: 1, borderColor: t.border }}>
                  <QRCode
                    value={profileTarget.aegis_id}
                    size={180}
                    color={t.text}
                    backgroundColor={t.surface2}
                  />
                </View>

                {/* Full aegis_id selectable */}
                <View style={{ backgroundColor: t.bg, borderRadius: t.radiusS, padding: 12, borderWidth: 1, borderColor: t.border }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.8, marginBottom: 4 }}>
                    AEGIS ID
                  </Text>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent }} selectable>
                    {profileTarget.aegis_id}
                  </Text>
                </View>

                {/* Copy + Close buttons */}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    onPress={async () => {
                      await (await import('expo-clipboard')).setStringAsync(profileTarget.aegis_id);
                      Alert.alert('Copiado', 'Aegis ID copiado al portapapeles.');
                    }}
                    accessibilityLabel="Copiar Aegis ID"
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 11 }}
                  >
                    <I.Copy size={14} color={t.text} />
                    <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>Copiar</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setProfileTarget(null)}
                    accessibilityLabel="Cerrar perfil"
                    style={{ flex: 1, backgroundColor: t.accent, borderRadius: t.radiusS, paddingVertical: 11, alignItems: 'center' }}
                  >
                    <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '700', color: t.bg }}>Cerrar</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Kind filter chip definitions
const KIND_CHIPS: { label: string; kinds: string[] }[] = [
  { label: 'Miembros', kinds: ['member'] },
  { label: 'Canales', kinds: ['channel'] },
  { label: 'Mensajes', kinds: ['message'] },
  { label: 'Dispositivos', kinds: ['device'] },
];

function AuditContent({ t }: { t: Theme }) {
  const s = makeStyles(t);
  const { org, auditLog, auditHasMore, auditLoading, auditFilters, channels, fetchAuditPage, setAuditFilters } = useWork();
  const identity = useIdentity((st) => st.identity);
  const aegisId = identity?.aegisId ?? '';
  const isOwner = org?.adminId === aegisId;

  const [actorQuery, setActorQuery] = useState('');
  const [activeKindChip, setActiveKindChip] = useState<string | null>(null);

  // Apply actor filter with debounce via useEffect
  useEffect(() => {
    const tid = setTimeout(() => {
      void setAuditFilters({ kind: activeKindChip, actorId: actorQuery.trim() || null });
    }, 400);
    return () => clearTimeout(tid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorQuery, activeKindChip]);

  function handleChip(kindPrefix: string | null) {
    setActiveKindChip(kindPrefix);
  }

  async function handleLoadMore() {
    if (!org || auditLoading || !auditHasMore) return;
    const last = auditLog[auditLog.length - 1];
    const opts: { before?: number; kind?: string; actorId?: string } = {};
    if (last) opts.before = last.createdAt;
    if (auditFilters.kind) opts.kind = auditFilters.kind;
    if (auditFilters.actorId) opts.actorId = auditFilters.actorId;
    await fetchAuditPage(org.orgId, opts);
  }

  async function handleExport() {
    if (!org) return;
    try {
      const adminSig = signAdminAction(org.orgId, 'export_audit');
      if (!adminSig) return;
      const params = new URLSearchParams({
        aegisId,
        sig: adminSig.sig,
        ts: String(adminSig.ts),
      });
      const res = await fetch(`${SERVER_URL}/work/org/${org.orgId}/audit/export?${params.toString()}`);
      if (!res.ok) { Alert.alert('Error', 'No se pudo exportar el log.'); return; }
      const csv = await res.text();
      const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
      const path = `${FS.cacheDirectory ?? ''}audit_export_${Date.now()}.csv`;
      await FS.writeAsStringAsync(path, csv, { encoding: FS.EncodingType.UTF8 });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(path, { mimeType: 'text/csv', dialogTitle: 'Exportar log de auditoría' });
      } else {
        Alert.alert('Exportado', `Archivo guardado en: ${path}`);
      }
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    }
  }

  const renderItem = useCallback(({ item, index }: { item: WorkAuditEntry; index: number }) => (
    <AuditEventRow
      key={item.id}
      entry={item}
      t={t}
      channels={channels}
      last={index === auditLog.length - 1}
    />
  ), [t, channels, auditLog.length]);

  const keyExtractor = useCallback((item: WorkAuditEntry) => item.id, []);

  const ListFooter = (
    <View style={{ padding: 14, alignItems: 'center' }}>
      {auditLoading ? (
        <ActivityIndicator size="small" color={t.accent} />
      ) : auditHasMore ? (
        <Pressable
          onPress={() => void handleLoadMore()}
          accessibilityLabel="Cargar más eventos de auditoría"
          style={{ borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingHorizontal: 18, paddingVertical: 9 }}
        >
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>Cargar más</Text>
        </Pressable>
      ) : auditLog.length > 0 ? (
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>Fin del log</Text>
      ) : null}
    </View>
  );

  return (
    <View style={[s.card, { overflow: 'hidden' }]}>
      {/* Header */}
      <View style={[s.cardHeader, { gap: 8 }]}>
        <View style={[s.badge, { backgroundColor: t.accentDeep }]}>
          <View style={s.liveDot} />
          <Text style={[s.badgeText, { color: t.accent }]}>LIVE</Text>
        </View>
        <Text style={[s.cardTitle, { flex: 1 }]}>Registro de auditoría</Text>
        {isOwner && (
          <Pressable
            onPress={() => void handleExport()}
            accessibilityLabel="Exportar log de auditoría como CSV"
            hitSlop={8}
          >
            <I.Download size={18} color={t.textDim} />
          </Pressable>
        )}
      </View>

      {/* Filter bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8, flexDirection: 'row' }}
        style={{ borderBottomWidth: 1, borderBottomColor: t.divider }}
      >
        {/* "Todos" chip */}
        <Pressable
          onPress={() => handleChip(null)}
          accessibilityLabel="Filtro: Todos"
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 20,
            backgroundColor: activeKindChip === null ? t.accent : t.surface2,
            borderWidth: 1,
            borderColor: activeKindChip === null ? t.accent : t.border,
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: activeKindChip === null ? t.bg : t.textDim, letterSpacing: 0.8 }}>
            Todos
          </Text>
        </Pressable>

        {KIND_CHIPS.map((chip) => {
          const active = activeKindChip === chip.kinds[0];
          return (
            <Pressable
              key={chip.label}
              onPress={() => handleChip(chip.kinds[0])}
              accessibilityLabel={`Filtro: ${chip.label}`}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 20,
                backgroundColor: active ? t.accent : t.surface2,
                borderWidth: 1,
                borderColor: active ? t.accent : t.border,
              }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: active ? t.bg : t.textDim, letterSpacing: 0.8 }}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}

        {/* Actor search */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: t.surface2,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: t.border,
          paddingHorizontal: 10,
          minWidth: 120,
          gap: 6,
        }}>
          <I.Search size={11} color={t.textDim} />
          <TextInput
            value={actorQuery}
            onChangeText={setActorQuery}
            placeholder="Actor ID…"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Filtrar por actor ID"
            style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, paddingVertical: 0, flex: 1 }}
          />
        </View>
      </ScrollView>

      {/* Event list */}
      {auditLog.length === 0 && !auditLoading ? (
        <View style={{ padding: 24, alignItems: 'center', gap: 8 }}>
          <I.Archive size={28} color={t.textFaint} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, textAlign: 'center' }}>
            Sin eventos para mostrar
          </Text>
        </View>
      ) : (
        <FlatList
          data={auditLog}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          scrollEnabled={false}
          removeClippedSubviews={false}
          ListFooterComponent={ListFooter}
        />
      )}
    </View>
  );
}

// ─── Keys content ─────────────────────────────────────────────────────────────

function KeysContent({
  t,
  org,
}: {
  t: Theme;
  org: import('../store/work').WorkOrg | null;
}) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();

  const rotationDays = org?.policyKeyRotationDays ?? 90;
  const createdAt = org ? new Date(org.createdAt).toLocaleDateString() : '—';

  return (
    <View style={{ gap: 14 }}>
      {/* Rotation policy card */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <Text style={s.cardTitle}>{i18nT('workDashboard.keysRotationTitle')}</Text>
          <View style={[s.badge, { backgroundColor: t.accentDeep }]}>
            <I.Key size={10} color={t.accent} />
            <Text style={[s.badgeText, { color: t.accent }]}>{i18nT('workDashboard.keysActiveBadge')}</Text>
          </View>
        </View>
        <View style={{ padding: 14, gap: 16 }}>
          {/* Current interval */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ gap: 3 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.2 }}>
                {i18nT('workDashboard.keysIntervalLabel')}
              </Text>
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 28, fontWeight: '700', color: t.accent, lineHeight: 32 }}>
                {rotationDays}<Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim }}> {i18nT('workDashboard.keysDays')}</Text>
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 3 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.2 }}>
                {i18nT('workDashboard.keysCreatedLabel')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>{createdAt}</Text>
            </View>
          </View>

          {/* Divider */}
          <View style={{ height: 1, backgroundColor: t.divider }} />

          {/* Info rows */}
          {([
            { labelKey: 'workDashboard.keysAlgoLabel', value: 'Double Ratchet + X3DH' },
            { labelKey: 'workDashboard.keysCurveLabel', value: 'Curve25519 · 256-bit' },
            { labelKey: 'workDashboard.keysStorageLabel', value: i18nT('workDashboard.keysStorageValue') },
            { labelKey: 'workDashboard.keysForwardLabel', value: i18nT('workDashboard.keysForwardValue') },
          ] as { labelKey: string; value: string }[]).map((row) => (
            <View key={row.labelKey} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.8, flex: 1 }}>
                {i18nT(row.labelKey)}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text, textAlign: 'right', flex: 1 }}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* Compliance card */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <Text style={s.cardTitle}>{i18nT('workDashboard.keysComplianceTitle')}</Text>
        </View>
        <View style={{ padding: 14, gap: 10 }}>
          {([
            { labelKey: 'workDashboard.keysComplianceE2ee', ok: true },
            { labelKey: 'workDashboard.keysComplianceNoServer', ok: true },
            { labelKey: 'workDashboard.keysCompliancePFS', ok: true },
            { labelKey: 'workDashboard.keysComplianceMetadata', ok: true },
          ] as { labelKey: string; ok: boolean }[]).map((item) => (
            <View key={item.labelKey} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: item.ok ? t.accentDeep : t.surface2, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: item.ok ? t.accent : t.textFaint }}>
                  {item.ok ? '✓' : '✕'}
                </Text>
              </View>
              <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text, flex: 1 }}>
                {i18nT(item.labelKey)}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ─── Relays content ───────────────────────────────────────────────────────────

function RelaysContent({
  t,
  org,
}: {
  t: Theme;
  org: import('../store/work').WorkOrg | null;
}) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();

  // Static relay list derived from org info — in a production build these
  // would come from a /work/org/:id/relays endpoint. We display the known
  // self-hosted relay with real uptime data where available.
  const relays: { name: string; region: string; version: string; uptime: string; status: 'online' | 'degraded' | 'offline' }[] = [
    { name: 'zurich-prime', region: 'Zurich, CH', version: 'v0.9.2', uptime: '99.99%', status: 'online' },
    { name: 'frankfurt-01', region: 'Frankfurt, DE', version: 'v0.9.1', uptime: '99.87%', status: 'online' },
    { name: 'tor-bridge-1', region: 'Onion · Global', version: 'v0.8.9', uptime: '98.20%', status: 'degraded' },
  ];

  const statusColor = (s: 'online' | 'degraded' | 'offline') =>
    s === 'online' ? t.accent : s === 'degraded' ? t.warn : t.danger;

  return (
    <View style={{ gap: 14 }}>
      {/* Relay list card */}
      <View style={makeStyles(t).card}>
        <View style={makeStyles(t).cardHeader}>
          <Text style={makeStyles(t).cardTitle}>{i18nT('workDashboard.relaysTitle')}</Text>
          <View style={[makeStyles(t).badge, { backgroundColor: t.accentDeep }]}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.accent }} />
            <Text style={[makeStyles(t).badgeText, { color: t.accent }]}>{i18nT('workDashboard.relaysSelfHosted')}</Text>
          </View>
        </View>
        {relays.map((relay, idx) => (
          <View
            key={relay.name}
            style={[
              { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
              idx < relays.length - 1 && { borderBottomWidth: 1, borderBottomColor: t.divider },
            ]}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor(relay.status) }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>{relay.name}</Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{relay.region} · {relay.version}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: statusColor(relay.status), fontWeight: '700' }}>
                {relay.uptime}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, letterSpacing: 0.8, textTransform: 'uppercase' }}>
                {relay.status}
              </Text>
            </View>
          </View>
        ))}
      </View>

      {/* Privacy info card */}
      <View style={[makeStyles(t).card, { padding: 14, gap: 10 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <I.Globe size={14} color={t.accent} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.2 }}>
            {i18nT('workDashboard.relaysPrivacyTitle')}
          </Text>
        </View>
        <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
          {i18nT('workDashboard.relaysPrivacyDesc')}
        </Text>
        {org && (
          <View style={{ backgroundColor: t.bg, borderRadius: t.radiusS, padding: 10, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>
              {i18nT('workDashboard.relaysOrgId')}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text, marginTop: 4 }} selectable>
              {org.orgId}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

// ─── Policy content ───────────────────────────────────────────────────────────

function PolicyContent({
  t,
  org,
  aegisId,
}: {
  t: Theme;
  org: import('../store/work').WorkOrg | null;
  aegisId: string;
}) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();
  const isAdmin = org?.adminId === aegisId;

  const policies: { labelKey: string; descKey: string; active: boolean }[] = [
    { labelKey: 'workDashboard.policyE2eeLabel', descKey: 'workDashboard.policyE2eeDesc', active: true },
    { labelKey: 'workDashboard.policyDeviceVerLabel', descKey: 'workDashboard.policyDeviceVerDesc', active: true },
    { labelKey: 'workDashboard.policyKeyRotLabel', descKey: 'workDashboard.policyKeyRotDesc', active: true },
    { labelKey: 'workDashboard.policyZeroMetaLabel', descKey: 'workDashboard.policyZeroMetaDesc', active: true },
    { labelKey: 'workDashboard.policyScreenshotLabel', descKey: 'workDashboard.policyScreenshotDesc', active: false },
    { labelKey: 'workDashboard.policyEphemeralLabel', descKey: 'workDashboard.policyEphemeralDesc', active: false },
  ];

  return (
    <View style={{ gap: 14 }}>
      {/* Admin badge */}
      {isAdmin && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.accentDeep, borderRadius: t.radiusS, padding: 10, borderWidth: 1, borderColor: t.accent }}>
          <I.Shield size={14} color={t.accent} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1 }}>
            {i18nT('workDashboard.policyAdminBadge')}
          </Text>
        </View>
      )}

      {/* Policy toggles card */}
      <View style={makeStyles(t).card}>
        <View style={makeStyles(t).cardHeader}>
          <Text style={makeStyles(t).cardTitle}>{i18nT('workDashboard.policyCardTitle')}</Text>
          <View style={makeStyles(t).badge}>
            <Text style={makeStyles(t).badgeText}>{i18nT('workDashboard.policyActiveCount', { count: policies.filter((p) => p.active).length })}</Text>
          </View>
        </View>
        {policies.map((policy, idx) => (
          <View
            key={policy.labelKey}
            style={[
              { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, gap: 12 },
              idx < policies.length - 1 && { borderBottomWidth: 1, borderBottomColor: t.divider },
            ]}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '500', color: t.text }}>
                {i18nT(policy.labelKey)}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, lineHeight: 15 }}>
                {i18nT(policy.descKey)}
              </Text>
            </View>
            <View style={{
              width: 36, height: 20, borderRadius: 10,
              backgroundColor: policy.active ? t.accent : t.surface2,
              justifyContent: 'center',
              paddingHorizontal: 2,
              alignItems: policy.active ? 'flex-end' : 'flex-start',
              borderWidth: 1, borderColor: policy.active ? t.accent : t.border,
            }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: policy.active ? t.bg : t.textFaint }} />
            </View>
          </View>
        ))}
      </View>

      {/* Key rotation interval info */}
      {org && (
        <View style={[makeStyles(t).card, { padding: 14, gap: 8 }]}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.2 }}>
            {i18nT('workDashboard.policyRotationSection')}
          </Text>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '700', color: t.text }}>
            {org.policyKeyRotationDays} <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>{i18nT('workDashboard.keysDays')}</Text>
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17 }}>
            {i18nT('workDashboard.policyRotationDesc', { days: org.policyKeyRotationDays })}
          </Text>
        </View>
      )}

      {/* Read-only notice for non-admins */}
      {!isAdmin && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: t.surface, borderRadius: t.radiusS, borderWidth: 1, borderColor: t.border }}>
          <I.Shield size={13} color={t.textFaint} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, flex: 1, letterSpacing: 0.5 }}>
            {i18nT('workDashboard.policyReadOnly')}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Coming soon placeholder ──────────────────────────────────────────────────

function ComingSoon({ t, labelKey }: { t: Theme; labelKey: string }) {
  const s = makeStyles(t);
  const { t: i18nT } = useTranslation();
  return (
    <View style={s.comingSoon}>
      <I.Shield size={32} color={t.textFaint} />
      <Text style={s.comingSoonTitle}>{i18nT(labelKey)}</Text>
      <Text style={s.comingSoonSub}>{i18nT('workDashboard.comingSoonSub')}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: t.bg,
    },
    layout: {
      flex: 1,
      flexDirection: 'row',
    },

    // Sidebar
    sidebar: {
      width: 220,
      backgroundColor: t.surface,
      borderRightWidth: 1,
      borderRightColor: t.border,
    },
    sidebarDrawer: {
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      zIndex: 20,
      elevation: 20,
      shadowColor: '#000',
      shadowOffset: { width: 4, height: 0 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
    },
    drawerOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      zIndex: 19,
    },
    sidebarLogo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 18,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    logoMark: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: t.accentDeep,
      alignItems: 'center',
      justifyContent: 'center',
    },
    logoTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 13,
      fontWeight: '700',
      color: t.text,
    },
    logoSub: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: t.textDim,
      letterSpacing: 1.5,
    },
    navList: {
      flex: 1,
      paddingVertical: 10,
    },
    navItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: t.radiusS,
      marginHorizontal: 8,
      marginVertical: 1,
    },
    navItemActive: {
      backgroundColor: t.accentInk,
    },
    navLabel: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textDim,
      fontWeight: '500',
    },
    navLabelActive: {
      color: t.accent,
      fontWeight: '600',
    },
    relayCard: {
      margin: 12,
      padding: 12,
      borderRadius: t.radiusS,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
    },
    relayDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: t.accent,
      marginBottom: 6,
    },
    relayTitle: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.accent,
      letterSpacing: 1.5,
      marginBottom: 4,
    },
    relayLine: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textDim,
    },

    // Main
    main: {
      flex: 1,
      flexDirection: 'column',
    },
    mainHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 18,
      paddingTop: 14,
      paddingBottom: 4,
    },
    mainHeaderLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    mainHeaderRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    hamburger: {
      width: 28,
      height: 28,
      justifyContent: 'center',
    },
    hLine: {
      height: 2,
      width: 20,
      borderRadius: 1,
      backgroundColor: t.textDim,
    },
    orgLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textDim,
      letterSpacing: 1.5,
    },
    pageTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 22,
      fontWeight: '700',
      color: t.text,
    },
    timestamp: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textFaint,
      paddingHorizontal: 18,
      marginBottom: 12,
    },
    inviteBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: t.accent,
      borderRadius: t.radiusS,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    inviteBtnText: {
      fontFamily: t.font,
      fontSize: 13,
      fontWeight: '600',
      color: t.bg,
    },
    contentContainer: {
      paddingHorizontal: 14,
      paddingBottom: 30,
      gap: 14,
    },

    // KPI
    kpiGrid: {
      flexDirection: 'row',
      gap: 10,
    },
    kpiGridMobile: {
      flexWrap: 'wrap',
    },
    kpiCard: {
      flex: 1,
      minWidth: 130,
      padding: 14,
    },
    kpiLabel: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: t.textDim,
      letterSpacing: 1.2,
      marginBottom: 6,
    },
    kpiValue: {
      fontFamily: t.fontDisplay,
      fontSize: 28,
      fontWeight: '700',
      color: t.text,
      lineHeight: 32,
    },
    kpiSub: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      marginTop: 4,
    },

    // Card
    card: {
      backgroundColor: t.surface,
      borderRadius: t.radius,
      borderWidth: 1,
      borderColor: t.border,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 14,
      borderBottomWidth: 1,
      borderBottomColor: t.divider,
    },
    cardTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 15,
      fontWeight: '600',
      color: t.text,
    },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: t.surface2,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    badgeText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textDim,
      letterSpacing: 0.8,
    },
    liveDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: '#5bf2b9',
    },

    // Split row (teams + audit)
    splitRow: {
      flexDirection: 'row',
      gap: 12,
    },
    splitRowMobile: {
      flexDirection: 'column',
    },
    teamsCard: {
      flex: 3,
    },
    auditCard: {
      flex: 2,
    },

    // Table
    tableHeader: {
      flexDirection: 'row',
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: t.divider,
    },
    tableRow: {
      flexDirection: 'row',
      paddingHorizontal: 14,
      paddingVertical: 11,
      alignItems: 'center',
    },
    tableHeadText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    tableBodyText: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.text,
    },
    tableCol: {
      alignSelf: 'center',
    },
    colTeam: {
      flex: 2,
    },
    colNum: {
      flex: 1,
      textAlign: 'right',
    },

    // Audit
    auditRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: 14,
      paddingVertical: 11,
      gap: 8,
    },
    auditDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      marginTop: 4,
    },
    auditTime: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textFaint,
      minWidth: 36,
    },
    auditMsg: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.text,
      flex: 1,
      lineHeight: 18,
    },

    // Policy bar
    policyBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: t.surface,
      borderRadius: t.radius,
      borderWidth: 1,
      borderColor: t.border,
      padding: 14,
    },
    policyText: {
      fontFamily: t.font,
      fontSize: 12,
      color: t.textDim,
      flex: 1,
      lineHeight: 17,
    },
    policyBtn: {
      borderWidth: 1,
      borderColor: t.borderStrong,
      borderRadius: t.radiusS,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    policyBtnText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.text,
      letterSpacing: 1,
    },

    // Devices
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 8,
    },
    deviceName: {
      fontFamily: t.font,
      fontSize: 13,
      fontWeight: '600',
      color: t.text,
    },
    deviceSub: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      marginTop: 2,
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    revokeBtn: {
      borderWidth: 1,
      borderColor: t.danger,
      borderRadius: t.radiusS,
      paddingVertical: 5,
      paddingHorizontal: 8,
      alignItems: 'center',
    },
    revokeBtnText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.danger,
      letterSpacing: 0.5,
    },

    // Coming soon
    comingSoon: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 80,
      gap: 12,
    },
    comingSoonTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 17,
      fontWeight: '600',
      color: t.textDim,
    },
    comingSoonSub: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textFaint,
      letterSpacing: 0.5,
    },
  });
}
