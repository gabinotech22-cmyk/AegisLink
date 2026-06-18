/**
 * AegisLink Desktop — distribution lists store.
 *
 * Port literal de mobile/src/store/distribution.ts:
 *  - expo-secure-store     → window.aegis.secureStorage (IPC keychain)
 *  - expo-crypto.randomUUID → crypto.randomUUID() (Web Crypto API)
 * El resto (zustand state machine) es idéntico.
 *
 * Una "distribution list" es un conjunto de aegisIds al que se puede mandar
 * un broadcast 1→N. Cada destinatario recibe un mensaje E2EE INDEPENDIENTE
 * (no es un grupo): los miembros no se conocen entre sí.
 */

import { create } from 'zustand';

const STORE_KEY = 'aegis.distribution.v1';

export interface DistributionList {
  id: string;
  name: string;
  members: string[]; // aegisIds
  createdAt: number;
}

interface DistributionState {
  lists: DistributionList[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  create: (name: string, members: string[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  update: (id: string, patch: Partial<Pick<DistributionList, 'name' | 'members'>>) => Promise<void>;
}

async function persist(lists: DistributionList[]): Promise<void> {
  await window.aegis.secureStorage.set(STORE_KEY, JSON.stringify(lists));
}

export const useDistribution = create<DistributionState>((set, get) => ({
  lists: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await window.aegis.secureStorage.get(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DistributionList[];
        set({ lists: parsed, hydrated: true });
      } else {
        set({ hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  },

  create: async (name, members) => {
    const newList: DistributionList = {
      id: crypto.randomUUID(),
      name,
      members,
      createdAt: Date.now(),
    };
    const lists = [...get().lists, newList];
    set({ lists });
    await persist(lists);
  },

  remove: async (id) => {
    const lists = get().lists.filter((l) => l.id !== id);
    set({ lists });
    await persist(lists);
  },

  update: async (id, patch) => {
    const lists = get().lists.map((l) =>
      l.id === id ? { ...l, ...patch } : l
    );
    set({ lists });
    await persist(lists);
  },
}));
