import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout, Page } from './components/Layout';
import { Loading, Note, Spinner } from './components/ui';
import { loadConfig } from './config';
import { captureInviteFragment } from './lib/inviteCapture';
import { archiveAllRecords, listRecords, type CeremonyRecord } from './lib/records';
import { requestPersistentStorage } from './lib/storage';
import { archiveRoot, loadRoot, saveRoot, type VaultStore } from './lib/vault';
import { Ceremony } from './screens/Ceremony';
import { CreateCeremony } from './screens/CreateCeremony';
import { Landing } from './screens/Landing';
import { Restore } from './screens/Restore';
import { buildDeployments, singleDeployment, type Deployments } from './deployments';
import { DeploymentsProvider, type Services } from './services';

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

/**
 * Providers + local-state loading; tests pass fake services and a memory vault. `deployments`
 * (current + legacy managers) defaults to `services` alone.
 */
export function AppProvider({
  services,
  deployments,
  vaultStore,
  children,
}: {
  services: Services;
  deployments?: Deployments;
  vaultStore?: VaultStore;
  children: ReactNode;
}) {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [records, setRecords] = useState<CeremonyRecord[]>([]);
  const [ready, setReady] = useState(false);
  // One stable registry per render tree (the Ceremony route's probe depends on its identity).
  const resolvedDeployments = useMemo(() => deployments ?? singleDeployment(services), [deployments, services]);

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
      <div className="flex min-h-screen items-center justify-center bg-paper p-8">
        <Spinner label="Opening…" />
      </div>
    );
  }
  const state: AppState = {
    mnemonic,
    saveMnemonic: async (m) => {
      await saveRoot(m, vaultStore);
      // A key now lives here: ask the browser not to evict this site's data. Not awaited (a
      // browser may ask the person first); a refusal changes nothing but the member's note.
      void requestPersistentStorage();
      setMnemonic(m);
    },
    switchRoot: async (m) => {
      await archiveRoot(vaultStore);
      await archiveAllRecords();
      await saveRoot(m, vaultStore);
      void requestPersistentStorage();
      setMnemonic(m);
      setRecords(await listRecords());
    },
    records,
    refreshRecords: async () => setRecords(await listRecords()),
  };
  return (
    <DeploymentsProvider deployments={resolvedDeployments}>
      <AppContext.Provider value={state}>{children}</AppContext.Provider>
    </DeploymentsProvider>
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
  const [deployments, setDeployments] = useState<Deployments | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig()
      .then((config) => setDeployments(buildDeployments(config)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) {
    return (
      <Layout>
        <Page>
          <Note tone="bad">This deployment is not set up correctly ({error}). Please tell whoever runs it.</Note>
        </Page>
      </Layout>
    );
  }
  if (!deployments) {
    return (
      <Layout>
        <Page>
          <Loading label="Opening…" />
        </Page>
      </Layout>
    );
  }
  return (
    <AppProvider services={deployments.current} deployments={deployments}>
      <AppRoutes />
    </AppProvider>
  );
}
