import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Note, Spinner } from './components/ui';
import { loadConfig } from './config';
import { captureInviteFragment } from './lib/inviteCapture';
import { archiveAllRecords, listRecords, type CeremonyRecord } from './lib/records';
import { archiveRoot, loadRoot, saveRoot, type VaultStore } from './lib/vault';
import { Ceremony } from './screens/Ceremony';
import { CreateCeremony } from './screens/CreateCeremony';
import { Landing } from './screens/Landing';
import { Restore } from './screens/Restore';
import { buildServices, ServicesProvider, type Services } from './services';

export interface AppState {
  /** The unlocked 12-word root, or null before any key exists on this device. */
  mnemonic: string | null;
  saveMnemonic(m: string): Promise<void>;
  /**
   * Replace the active root with a different one (explicit restore-switch):
   * the current encrypted root is set aside — never destroyed — and its
   * ceremony records are archived so they cannot be misread under the new
   * root (§5.3).
   */
  switchRoot(m: string): Promise<void>;
  records: CeremonyRecord[];
  refreshRecords(): Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp outside AppProvider');
  return state;
}

/** Providers + local-state loading; tests pass fake services and a memory vault. */
export function AppProvider({
  services,
  vaultStore,
  children,
}: {
  services: Services;
  vaultStore?: VaultStore;
  children: ReactNode;
}) {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [records, setRecords] = useState<CeremonyRecord[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      setMnemonic(await loadRoot(vaultStore).catch(() => null));
      setRecords(await listRecords().catch(() => []));
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="p-8 text-center">
        <Spinner label="Opening…" />
      </div>
    );
  }
  const state: AppState = {
    mnemonic,
    saveMnemonic: async (m) => {
      await saveRoot(m, vaultStore);
      setMnemonic(m);
    },
    switchRoot: async (m) => {
      await archiveRoot(vaultStore);
      await archiveAllRecords();
      await saveRoot(m, vaultStore);
      setMnemonic(m);
      setRecords(await listRecords());
    },
    records,
    refreshRecords: async () => setRecords(await listRecords()),
  };
  return (
    <ServicesProvider services={services}>
      <AppContext.Provider value={state}>{children}</AppContext.Provider>
    </ServicesProvider>
  );
}

export function AppRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/new" element={<CreateCeremony />} />
        <Route path="/restore" element={<Restore />} />
        <Route path="/c/:cid" element={<Ceremony />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  // Defensive backstop: main.tsx already stripped any invite fragment before
  // anything else ran; this keeps the guarantee even if App is mounted alone.
  captureInviteFragment();
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig()
      .then((config) => setServices(buildServices(config)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) {
    return (
      <Layout>
        <Note tone="bad">This deployment is not set up correctly ({error}). Please tell whoever runs it.</Note>
      </Layout>
    );
  }
  if (!services) {
    return (
      <Layout>
        <Spinner label="Opening…" />
      </Layout>
    );
  }
  return (
    <AppProvider services={services}>
      <AppRoutes />
    </AppProvider>
  );
}
