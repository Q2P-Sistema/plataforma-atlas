import { useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShellLayout } from '@atlas/ui';
import { LoginPage } from './pages/LoginPage.js';
import { TwoFactorPage } from './pages/TwoFactorPage.js';
import { TwoFactorSetupPage } from './pages/TwoFactorSetupPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ModulePlaceholder } from './components/ModulePlaceholder.js';
import { AdminUsersPage } from './pages/AdminUsersPage.js';
import { PositionDashboard } from './pages/hedge/PositionDashboard.js';
import { NDFListPage } from './pages/hedge/NDFListPage.js';
import { MotorMVPage } from './pages/hedge/MotorMVPage.js';
import { MarginSimulationPage } from './pages/hedge/MarginSimulationPage.js';
import { InventoryPage } from './pages/hedge/InventoryPage.js';
import { AlertsPage } from './pages/hedge/AlertsPage.js';
import { ConfigPage } from './pages/hedge/ConfigPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { useAuth } from './hooks/useAuth.js';
import { useModules, type ModuleInfo } from './hooks/useModules.js';
import { useAuthStore } from './stores/auth.store.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

const MODULE_NAMES: Record<string, string> = {
  hedge: 'Hedge Engine',
  stockbridge: 'StockBridge',
  breakingpoint: 'Breaking Point',
  clevel: 'C-Level',
  comexinsight: 'ComexInsight',
  comexflow: 'ComexFlow',
  forecast: 'Forecast',
};

const ALL_MODULE_IDS = Object.keys(MODULE_NAMES);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/2fa" element={<TwoFactorPage />} />
          <Route path="/2fa/setup" element={<TwoFactorSetupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
          <Route
            path="/*"
            element={
              <ProtectedShell />
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function ProtectedShell() {
  const { user, isAuthenticated, isLoading } = useAuth({ requireAuth: true });
  const { data: modules = [] } = useModules();
  const location = useLocation();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-atlas-bg">
        <p className="text-atlas-muted">Carregando...</p>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return null; // useAuth will redirect
  }

  // Redirect gestor/diretor without 2FA to setup
  if (
    (user.role === 'gestor' || user.role === 'diretor') &&
    !user.totp_enabled &&
    location.pathname !== '/2fa/setup'
  ) {
    navigate('/2fa/setup', { replace: true });
    return null;
  }

  const sidebarModules = modules.map((m: ModuleInfo) => ({
    id: m.id,
    name: m.name,
    enabled: m.enabled,
    path: m.path,
    icon: m.icon,
  }));

  // Build set of enabled module IDs for route guard
  const enabledSet = new Set(modules.filter((m) => m.enabled).map((m) => m.id));

  return (
    <ShellLayout
      modules={sidebarModules}
      currentPath={location.pathname}
      onNavigate={(path) => navigate(path)}
      userName={user.name}
      userRole={user.role}
      onLogout={() => {
        logout().then(() => navigate('/login', { replace: true }));
      }}
    >
      <Routes>
        <Route index element={<DashboardPage />} />
        {/* Hedge has real pages when enabled */}
        {enabledSet.has('hedge') && <Route path="hedge" element={<PositionDashboard />} />}
        {enabledSet.has('hedge') && <Route path="hedge/ndfs" element={<NDFListPage />} />}
        {enabledSet.has('hedge') && <Route path="hedge/motor" element={<MotorMVPage />} />}
        {enabledSet.has('hedge') && <Route path="hedge/simulacao" element={<MarginSimulationPage />} />}
        {enabledSet.has('hedge') && <Route path="hedge/estoque" element={<InventoryPage />} />}
        {enabledSet.has('hedge') && <Route path="hedge/alertas" element={<AlertsPage />} />}
        {enabledSet.has('hedge') && <Route path="hedge/config" element={<ConfigPage />} />}
        {!enabledSet.has('hedge') && <Route path="hedge" element={<ModuleRoute moduleId="hedge" moduleName="Hedge Engine" enabled={false} />} />}
        {ALL_MODULE_IDS.filter((id) => id !== 'hedge').map((id) => (
          <Route
            key={id}
            path={id}
            element={
              <ModuleRoute
                moduleId={id}
                moduleName={MODULE_NAMES[id]!}
                enabled={enabledSet.has(id)}
              />
            }
          />
        ))}
        <Route path="admin/users" element={<AdminUsersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ShellLayout>
  );
}

function ModuleRoute({
  moduleName,
  enabled,
}: {
  moduleId: string;
  moduleName: string;
  enabled: boolean;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!enabled) {
      navigate('/', { replace: true });
    }
  }, [enabled, navigate]);

  if (!enabled) {
    return null;
  }

  return <ModulePlaceholder name={moduleName} />;
}