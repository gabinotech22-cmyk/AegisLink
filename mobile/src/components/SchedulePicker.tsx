/**
 * SchedulePicker — bottom sheet for composing a scheduled send time.
 *
 * Uses TextInput fields for date and time (no third-party date picker required).
 * Min: now + 1 minute.
 * Calls onConfirm(sendAt) with a unix-ms timestamp on confirmation.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';

interface Props {
  visible: boolean;
  onClose: () => void;
  onConfirm: (sendAt: number) => void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function defaultDate(): { dateStr: string; timeStr: string } {
  const d = new Date(Date.now() + 5 * 60_000); // +5 min
  return {
    dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeStr: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function parseDateTime(dateStr: string, timeStr: string): Date | null {
  // dateStr: YYYY-MM-DD, timeStr: HH:MM
  const parts = dateStr.split('-');
  const timeParts = timeStr.split(':');
  if (parts.length !== 3 || timeParts.length !== 2) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const hours = parseInt(timeParts[0], 10);
  const minutes = parseInt(timeParts[1], 10);
  if (
    isNaN(year) || isNaN(month) || isNaN(day) ||
    isNaN(hours) || isNaN(minutes) ||
    month < 0 || month > 11 ||
    day < 1 || day > 31 ||
    hours < 0 || hours > 23 ||
    minutes < 0 || minutes > 59
  ) return null;
  return new Date(year, month, day, hours, minutes, 0, 0);
}

function previewText(dateStr: string, timeStr: string): string {
  const d = parseDateTime(dateStr, timeStr);
  if (!d) return 'Fecha/hora inválida';
  const weekdays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${weekdays[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} a las ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SchedulePicker({ visible, onClose, onConfirm }: Props) {
  const { t } = useTheme();

  const [dateStr, setDateStr] = useState('');
  const [timeStr, setTimeStr] = useState('');

  const handleOpen = useCallback(() => {
    const { dateStr: d, timeStr: ti } = defaultDate();
    setDateStr(d);
    setTimeStr(ti);
  }, []);

  function handleConfirm() {
    const d = parseDateTime(dateStr, timeStr);
    if (!d) {
      Alert.alert('Fecha inválida', 'Usa el formato YYYY-MM-DD y HH:MM.');
      return;
    }
    const minMs = Date.now() + 60_000;
    if (d.getTime() < minMs) {
      Alert.alert('Fecha demasiado cercana', 'El mensaje debe programarse al menos 1 minuto en el futuro.');
      return;
    }
    onConfirm(d.getTime());
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onShow={handleOpen}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.border }]}>
          <View style={styles.handle} />

          <Text style={[styles.title, { color: t.text, fontFamily: t.fontDisplay }]}>
            Programar mensaje
          </Text>

          {/* Preview */}
          <View style={[styles.previewBox, { backgroundColor: t.surface2, borderColor: t.border }]}>
            <Text style={[styles.previewLabel, { color: t.textDim, fontFamily: t.fontMono }]}>
              SE ENVIARA EL
            </Text>
            <Text style={[styles.previewValue, { color: t.accent, fontFamily: t.fontMono }]}>
              {previewText(dateStr, timeStr)}
            </Text>
          </View>

          {/* Date input */}
          <View style={{ gap: 6 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, letterSpacing: 0.8, color: t.textDim }}>
              FECHA (YYYY-MM-DD)
            </Text>
            <TextInput
              value={dateStr}
              onChangeText={setDateStr}
              placeholder="2025-12-31"
              placeholderTextColor={t.textFaint}
              keyboardType="numeric"
              maxLength={10}
              style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface2, fontFamily: t.fontMono }]}
              accessibilityLabel="Fecha de envio"
            />
          </View>

          {/* Time input */}
          <View style={{ gap: 6 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, letterSpacing: 0.8, color: t.textDim }}>
              HORA (HH:MM)
            </Text>
            <TextInput
              value={timeStr}
              onChangeText={setTimeStr}
              placeholder="15:30"
              placeholderTextColor={t.textFaint}
              keyboardType="numeric"
              maxLength={5}
              style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface2, fontFamily: t.fontMono }]}
              accessibilityLabel="Hora de envio"
            />
          </View>

          {/* Actions */}
          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              style={[styles.btn, { borderWidth: 1, borderColor: t.borderStrong }]}
              accessibilityLabel="Cancelar programacion"
            >
              <Text style={{ fontFamily: t.font, color: t.text, fontWeight: '500' }}>Cancelar</Text>
            </Pressable>
            <Pressable
              onPress={handleConfirm}
              style={[styles.btn, { backgroundColor: t.accent }]}
              accessibilityLabel="Confirmar programacion"
            >
              <Text style={{ fontFamily: t.font, color: t.accentInk, fontWeight: '700' }}>Programar</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: 20,
    paddingBottom: 36,
    gap: 14,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#555',
    marginBottom: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  previewBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    gap: 4,
  },
  previewLabel: {
    fontSize: 10,
    letterSpacing: 1,
  },
  previewValue: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    letterSpacing: 1,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  btn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
  },
});
