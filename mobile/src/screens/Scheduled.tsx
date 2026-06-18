/**
 * ScheduledMessages screen — Section 12
 *
 * Lists all pending scheduled messages grouped by recipient.
 * Each row shows: recipient AegisID snippet, scheduled time, and a Cancel button.
 * Accessed from the Chat header clock icon or from Settings.
 */

import { useEffect, useCallback } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useScheduledMessages } from '../store/scheduledMessages';
import { useContacts } from '../store/contacts';
import { useGroups } from '../store/groups';
import type { ScheduledMessage } from '../store/scheduledMessages';
import type { StoredContact } from '../db/local';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatSendAt(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusLabel(status: ScheduledMessage['status']): string {
  if (status === 'sent') return 'ENVIADO';
  if (status === 'failed') return 'FALLIDO';
  return 'PENDIENTE';
}

function statusColor(status: ScheduledMessage['status'], accent: string, warn: string, textFaint: string): string {
  if (status === 'sent') return accent;
  if (status === 'failed') return warn;
  return textFaint;
}

export function ScheduledScreen({ onBack }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { scheduled, loadPending, cancelScheduled } = useScheduledMessages();
  const contacts = useContacts((s) => s.contacts);
  const groups = useGroups((s) => s.groups);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const contactFor = useCallback(
    (aegisId: string): StoredContact | undefined =>
      contacts.find((c) => c.aegisId === aegisId),
    [contacts],
  );

  function handleCancel(msg: ScheduledMessage) {
    themedAlert(
      'Cancelar mensaje',
      '¿Cancelar este mensaje programado? No se podrá deshacer.',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Cancelar mensaje',
          style: 'destructive',
          onPress: () => void cancelScheduled(msg.id),
        },
      ],
    );
  }

  const pending = scheduled.filter((m) => m.status === 'pending');
  const others = scheduled.filter((m) => m.status !== 'pending');
  const sorted = [...pending, ...others];

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title="Mensajes Programados"
        big
        left={
          <Pressable
            onPress={onBack}
            hitSlop={8}
            style={{ padding: 4 }}
            accessibilityLabel="Volver"
          >
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <FlatList
        data={sorted}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingBottom: 22 + insets.bottom, flexGrow: 1 }}
        ListHeaderComponent={
          <View
            style={{
              marginHorizontal: 18,
              marginTop: 8,
              marginBottom: 14,
              padding: 14,
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: t.radius,
            }}
          >
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
              Los mensajes se cifran ahora y se envían automáticamente en el momento programado.
              El texto nunca se guarda en disco — solo el texto cifrado.
            </Text>
          </View>
        }
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60, paddingHorizontal: 24 }}>
            <I.Timer size={40} color={t.textFaint} />
            <Text
              style={{
                fontFamily: t.font,
                fontSize: 14,
                color: t.textFaint,
                textAlign: 'center',
                marginTop: 14,
                lineHeight: 20,
              }}
            >
              No hay mensajes programados.{'\n'}
              Mantén pulsado el botón de enviar en un chat para programar un mensaje.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isGroupPost = !!item.groupId;
          const groupName = isGroupPost
            ? groups.find((g) => g.id === item.groupId)?.name
            : undefined;
          const contact = isGroupPost ? undefined : contactFor(item.recipientAegisId);
          const displayName = isGroupPost
            ? (groupName ?? 'Grupo')
            : (contact?.name ?? item.recipientAegisId.slice(0, 12) + '…');
          const isPending = item.status === 'pending';

          return (
            <View
              style={[
                styles.row,
                { borderBottomColor: t.divider },
              ]}
              accessibilityLabel={`Mensaje programado para ${displayName} el ${formatSendAt(item.sendAt)}, estado: ${statusLabel(item.status)}`}
            >
              <View
                style={[styles.iconBox, { backgroundColor: t.surface2 }]}
              >
                {isGroupPost ? (
                  <I.Users size={18} color={isPending ? t.accent : t.textFaint} />
                ) : (
                  <I.Timer size={18} color={isPending ? t.accent : t.textFaint} />
                )}
              </View>

              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={styles.rowTop}>
                  <Text
                    numberOfLines={1}
                    style={[styles.name, { color: t.text, fontFamily: t.font }]}
                  >
                    {displayName}
                  </Text>
                  <Text
                    style={[
                      styles.statusBadge,
                      {
                        color: statusColor(item.status, t.accent, t.warn, t.textFaint),
                        fontFamily: t.fontMono,
                      },
                    ]}
                  >
                    {statusLabel(item.status)}
                  </Text>
                </View>

                <Text style={[styles.sendAt, { color: t.textDim, fontFamily: t.fontMono }]}>
                  {formatSendAt(item.sendAt)}
                </Text>

                {item.retryCount > 0 && (
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.warn, marginTop: 2 }}>
                    Intentos: {item.retryCount}/3
                  </Text>
                )}

                <Text style={[styles.e2eeTag, { color: t.textFaint, fontFamily: t.fontMono }]}>
                  {isGroupPost ? 'POST DE GRUPO · E2EE AL ENVIAR' : 'E2EE · CIFRADO EN ORIGEN'}
                </Text>
              </View>

              {isPending && (
                <Pressable
                  onPress={() => handleCancel(item)}
                  hitSlop={8}
                  style={[styles.cancelBtn, { borderColor: t.danger }]}
                  accessibilityLabel={`Cancelar mensaje programado para ${displayName}`}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 12, color: t.danger, fontWeight: '600' }}>
                    Cancelar
                  </Text>
                </Pressable>
              )}
            </View>
          );
        }}
        ItemSeparatorComponent={() => null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 3,
  },
  name: {
    flex: 1,
    fontWeight: '600',
    fontSize: 14,
  },
  statusBadge: {
    fontSize: 9,
    letterSpacing: 0.5,
    fontWeight: '700',
  },
  sendAt: {
    fontSize: 12,
    letterSpacing: 0.3,
  },
  e2eeTag: {
    fontSize: 9,
    letterSpacing: 0.5,
    marginTop: 4,
  },
  cancelBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
