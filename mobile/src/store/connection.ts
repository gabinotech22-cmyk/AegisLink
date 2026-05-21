import { create } from 'zustand';

interface ConnectionState {
  online: boolean;
  setOnline: (v: boolean) => void;
}

export const useConnection = create<ConnectionState>((set) => ({
  online: true,
  setOnline: (v) => set({ online: v }),
}));
