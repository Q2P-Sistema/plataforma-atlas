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
import { ShellLayout, type SidebarSubItem } from '@atlas/ui';
import {
  LayoutDashboard,
  FileText,
  Calculator,
  Activity,
  Package,
  Bell,
  Settings,
} from 'lucide-react';
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
import { HedgeLayout, HedgePtaxBadge } from './pages/hedge/HedgeLayout.js';
import { ForecastDashboard } from './pages/forecast/ForecastDashboard.js';
import { RollingForecastPage } from './pages/forecast/RollingForecastPage.js';
import { ShoppingListPage } from './pages/forecast/ShoppingListPage.js';
import { ForecastConfigPage } from './pages/forecast/ForecastConfigPage.js';
import { DemandAnalysisPage } from './pages/forecast/DemandAnalysisPage.js';
import { BusinessInsightsPage } from './pages/forecast/BusinessInsightsPage.js';
import { BPLayout } from './pages/breakingpoint/BPLayout.js';
import { BPDashboardPage } from './pages/breakingpoint/BPDashboardPage.js';
import { BPConfigPage } from './pages/breakingpoint/BPConfigPage.js';
import { BPTabelaPage } from './pages/breakingpoint/BPTabelaPage.js';
import { BPEstruturaBancosPage } from './pages/breakingpoint/BPEstruturaBancosPage.js';
import { BPLimitesPage } from './pages/breakingpoint/BPLimitesPage.js';
import { SBLayout } from './pages/stockbridge/SBLayout.js';
import { SBPlaceholderPage } from './pages/stockbridge/SBPlaceholderPage.js';
import { FilaOmiePage } from './pages/stockbridge/operador/FilaOmiePage.js';
import { MeuEstoquePage } from './pages/stockbridge/operador/MeuEstoquePage.js';
import { CockpitPage } from './pages/stockbridge/gestor/CockpitPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { useAuth } from './hooks/useAuth.js';
import { useModules, type ModuleInfo } from './hooks/useModules.js';
import { useAuthStore } from './stores/auth.store.js';
import {
  TrendingUp,
  ShoppingCart,
  BarChart3,
  Lightbulb,
  Building2,
  Landmark,
  Table,
} from 'lucide-react';

const FORECAST_SUB_ITEMS: SidebarSubItem[] = [
  { id: 'forecast-dashboard', name: 'Dashboard', path: '/forecast', icon: LayoutDashboard },
  { id: 'forecast-rolling', name: 'Forecast 120d', path: '/forecast/rolling', icon: TrendingUp },
  { id: 'forecast-demanda', name: 'Demanda', path: '/forecast/demanda', icon: BarChart3 },
  { id: 'forecast-insights', name: 'Insights', path: '/forecast/insights', icon: Lightbulb },
  { id: 'forecast-shopping', name: 'Shopping List', path: '/forecast/shopping', icon: ShoppingCart },
  { id: 'forecast-config', name: 'Config', path: '/forecast/config', icon: Settings },
];

const STOCKBRIDGE_SUB_ITEMS: SidebarSubItem[] = [
  { id: 'sb-fila', name: 'Fila OMIE', path: '/stockbridge/fila', icon: FileText },
  { id: 'sb-cockpit', name: 'Cockpit', path: '/stockbridge/cockpit', icon: LayoutDashboard },
  { id: 'sb-estoque', name: 'Meu Estoque', path: '/stockbridge/estoque', icon: Package },
];

const BP_SUB_ITEMS: SidebarSubItem[] = [
  { id: 'bp-dashboard', name: 'Dashboard', path: '/breakingpoint', icon: LayoutDashboard },
  { id: 'bp-tabela', name: 'Tabela', path: '/breakingpoint/tabela', icon: Table },
  { id: 'bp-estrutura', name: 'Estrutura', path: '/breakingpoint/estrutura', icon: Building2 },
  { id: 'bp-limites', name: 'Limites', path: '/breakingpoint/limites', icon: Landmark },
  { id: 'bp-config', name: 'Configurar', path: '/breakingpoint/config', icon: Settings },
];

const HEDGE_SUB_ITEMS: SidebarSubItem[] = [
  { id: 'hedge-dashboard', name: 'Dashboard', path: '/hedge', icon: LayoutDashboard },
  { id: 'hedge-ndfs', name: 'NDFs', path: '/hedge/ndfs', icon: FileText },
  { id: 'hedge-motor', name: 'Motor MV', path: '/hedge/motor', icon: Calculator },
  { id: 'hedge-simulacao', name: 'Simulacao', path: '/hedge/simulacao', icon: Activity },
  { id: 'hedge-estoque', name: 'Estoque', path: '/hedge/estoque', icon: Package },
  { id: 'hedge-alertas', name: 'Alertas', path: '/hedge/alertas', icon: Bell },
  { id: 'hedge-config', name: 'Config', path: '/hedge/config', icon: Settings },
];

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
    subItems:
      m.id === 'hedge'
        ? HEDGE_SUB_ITEMS
        : m.id === 'forecast'
          ? FORECAST_SUB_ITEMS
          : m.id === 'breakingpoint'
            ? BP_SUB_ITEMS
            : m.id === 'stockbridge'
              ? STOCKBRIDGE_SUB_ITEMS
              : undefined,
  }));

  // Build set of enabled module IDs for route guard
  const enabledSet = new Set(modules.filter((m) => m.enabled).map((m) => m.id));

  const isHedge = location.pathname.startsWith('/hedge');

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
      topBarSlot={isHedge ? <HedgePtaxBadge /> : undefined}
    >
      <Routes>
        <Route index element={<DashboardPage />} />
        {/* Hedge — shared layout wraps all sub-pages with PTAX badge */}
        {enabledSet.has('hedge') && (
          <Route path="hedge" element={<HedgeLayout />}>
            <Route index element={<PositionDashboard />} />
            <Route path="ndfs" element={<NDFListPage />} />
            <Route path="motor" element={<MotorMVPage />} />
            <Route path="simulacao" element={<MarginSimulationPage />} />
            <Route path="estoque" element={<InventoryPage />} />
            <Route path="alertas" element={<AlertsPage />} />
            <Route path="config" element={<ConfigPage />} />
          </Route>
        )}
        {!enabledSet.has('hedge') && <Route path="hedge" element={<ModuleRoute moduleId="hedge" moduleName="Hedge Engine" enabled={false} />} />}

        {/* Forecast Planner */}
        {enabledSet.has('forecast') && <Route path="forecast" element={<ForecastDashboard />} />}
        {enabledSet.has('forecast') && <Route path="forecast/rolling" element={<RollingForecastPage />} />}
        {enabledSet.has('forecast') && <Route path="forecast/demanda" element={<DemandAnalysisPage />} />}
        {enabledSet.has('forecast') && <Route path="forecast/insights" element={<BusinessInsightsPage />} />}
        {enabledSet.has('forecast') && <Route path="forecast/shopping" element={<ShoppingListPage />} />}
        {enabledSet.has('forecast') && <Route path="forecast/config" element={<ForecastConfigPage />} />}
        {!enabledSet.has('forecast') && <Route path="forecast" element={<ModuleRoute moduleId="forecast" moduleName="Forecast Planner" enabled={false} />} />}

        {/* Breaking Point */}
        {enabledSet.has('breakingpoint') && (
          <Route path="breakingpoint" element={<BPLayout />}>
            <Route index element={<BPDashboardPage />} />
            <Route path="tabela" element={<BPTabelaPage />} />
            <Route path="estrutura" element={<BPEstruturaBancosPage />} />
            <Route path="limites" element={<BPLimitesPage />} />
            <Route path="config" element={<BPConfigPage />} />
          </Route>
        )}
        {!enabledSet.has('breakingpoint') && <Route path="breakingpoint" element={<ModuleRoute moduleId="breakingpoint" moduleName="Breaking Point" enabled={false} />} />}

        {/* StockBridge — Phase 3 (US1 Recebimento) ativa; US2-US8 em fases futuras */}
        {enabledSet.has('stockbridge') && (
          <Route path="stockbridge" element={<SBLayout />}>
            <Route index element={<CockpitPage />} />
            <Route path="fila" element={<FilaOmiePage />} />
            <Route path="cockpit" element={<CockpitPage />} />
            <Route path="estoque" element={<MeuEstoquePage />} />
            <Route path="placeholder" element={<SBPlaceholderPage />} />
          </Route>
        )}
        {!enabledSet.has('stockbridge') && <Route path="stockbridge" element={<ModuleRoute moduleId="stockbridge" moduleName="StockBridge" enabled={false} />} />}

        {ALL_MODULE_IDS.filter((id) => id !== 'hedge' && id !== 'forecast' && id !== 'breakingpoint' && id !== 'stockbridge').map((id) => (
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