import type { CSSProperties } from 'react';
import type { Theme } from '../theme/vault';
import { I } from './icons';

export type Tab = 'home' | 'groups' | 'verify' | 'settings' | 'dashboard';

interface Props {
  t: Theme;
  current: Tab;
  onChange: (tab: Tab) => void;
  /** When true, renders using work profile styling */
  isWork?: boolean;
}

const WORK_ACCENT = '#6366f1';

const PERSONAL_ITEMS: { id: Tab; icon: keyof typeof I; label: string }[] = [
  { id: 'home',     icon: 'Chat',    label: 'CHATS'     },
  { id: 'groups',   icon: 'Users',   label: 'GROUPS'    },
  { id: 'verify',   icon: 'QR',      label: 'VERIFY'    },
  { id: 'settings', icon: 'Shield',  label: 'PRIVACY'   },
];

const WORK_ITEMS: { id: Tab; icon: keyof typeof I; label: string }[] = [
  { id: 'dashboard', icon: 'Building', label: 'DASHBOARD' },
  { id: 'groups',    icon: 'Users',    label: 'CHANNELS'  },
  { id: 'verify',    icon: 'QR',       label: 'VERIFY'    },
  { id: 'settings',  icon: 'Shield',   label: 'PRIVACY'   },
];

export function TabBar({ t, current, onChange, isWork = false }: Props) {
  const activeColor = isWork ? WORK_ACCENT : t.accent;
  const items = isWork ? WORK_ITEMS : PERSONAL_ITEMS;

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 10,
    paddingBottom: 10,
    borderTop: isWork ? `2px solid ${WORK_ACCENT}55` : `1px solid ${t.divider}`,
    backgroundColor: t.surface,
    flexShrink: 0,
  };

  return (
    <div style={containerStyle}>
      {items.map((it) => {
        const Icon = I[it.icon];
        const active = current === it.id;

        const itemStyle: CSSProperties = {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 8,
          paddingRight: 8,
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          userSelect: 'none',
        };

        const labelStyle: CSSProperties = {
          fontFamily: t.fontMono,
          fontSize: 9,
          letterSpacing: 0.8,
          fontWeight: active ? '600' : '400',
          color: active ? activeColor : t.textFaint,
          margin: 0,
        };

        return (
          <button
            key={it.id}
            onClick={() => onChange(it.id)}
            style={itemStyle}
            aria-label={it.label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={20} stroke={active ? 2.2 : 1.8} color={active ? activeColor : t.textFaint} />
            <span style={labelStyle}>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
