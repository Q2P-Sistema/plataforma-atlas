import { useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ShellLayout, type SidebarSubItem } from '@atlas/ui';
import {
  LayoutDashboard,
  FileText,
  Calculator,
  Activity,
  Package,
  Bell,
  Settings,
  AlertTriangle,
  FileWarning,
  Coins,
  RotateCcw,
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
import { UserGalpaoPage } from './pages/stockbridge/diretor/UserGalpaoPage.js';
import { CockpitPage } from './pages/stockbridge/gestor/CockpitPage.js';
import { CmcPage } from './pages/stockbridge/gestor/CmcPage.js';
import { AprovacoesPage } from './pages/stockbridge/gestor/AprovacoesPage.js';
import { TransitoPage } from './pages/stockbridge/gestor/TransitoPage.js';
import { SaidaManualPage } from './pages/stockbridge/operador/SaidaManualPage.js';
import { ComodatoRetornoPage } from './pages/stockbridge/operador/ComodatoRetornoPage.js';
import { MetricasPage } from './pages/stockbridge/diretor/MetricasPage.js';
import { FornecedoresPage } from './pages/stockbridge/diretor/FornecedoresPage.js';
import { ConfigProdutosPage } from './pages/stockbridge/diretor/ConfigProdutosPage.js';
import { LocalidadesPage } from './pages/stockbridge/gestor/LocalidadesPage.js';
import { MovimentacoesPage } from './pages/stockbridge/gestor/MovimentacoesPage.js';
import { DivergenciasPage } from './pages/stockbridge/gestor/DivergenciasPage.js';
import { ConferenciaEstoquePage } from './pages/stockbridge/gestor/ConferenciaEstoquePage.js';
import { PendenciasFiscaisPage } from './pages/stockbridge/gestor/PendenciasFiscaisPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { useAuth } from './hooks/useAuth.js';
import { useModules, type ModuleInfo } from './hooks/useModules.js';
import { MODULE_NAMES, ALL_MODULE_IDS } from './lib/modules.js';
import { useAuthStore } from './stores/auth.store.js';
import {
  TrendingUp,
  ShoppingCart,
  BarChart3,
  Lightbulb,
  Building2,
  Landmark,
  Table,
  Users,
  Scale,
} from 'lucide-react';

const FORECAST_SUB_ITEMS: SidebarSubItem[] = [
  { id: 'forecast-dashboard', name: 'Dashboard', path: '/forecast', icon: LayoutDashboard },
  { id: 'forecast-rolling', name: 'Forecast 120d', path: '/forecast/rolling', icon: TrendingUp },
  { id: 'forecast-demanda', name: 'Demanda', path: '/forecast/demanda', icon: BarChart3 },
  { id: 'forecast-insights', name: 'Insights', path: '/forecast/insights', icon: Lightbulb },
  { id: 'forecast-shopping', name: 'Lista de Compras', path: '/forecast/shopping', icon: ShoppingCart },
  { id: 'forecast-config', name: 'Configuração', path: '/forecast/config', icon: Settings },
];

// Roles refletem requireOperador/requireGestor/requireDiretor das rotas
// (modules/stockbridge/src/middleware/role.ts) — fonte da verdade no backend.
// Aqui e so visibilidade no menu pra evitar UX de clicar e levar 403.
//
// UI-C (ACXEGDP-263): itens agrupados por secao — "Operação" (dia a dia do
// operador), "Gestão" (gestor/diretor) e "Cadastros" (configuracao). Mantenha
// itens do mesmo grupo em sequencia: o cabecalho renderiza quando o grupo muda.
// Nomenclatura historica: 'Indicadores por Produto' vive em /config-produtos
// (ConfigProdutosPage) e 'Custos de Estoque' em /custos (CmcPage) — renomear
// a rota quebraria links salvos.
const STOCKBRIDGE_SUB_ITEMS: SidebarSubItem[] = [
  { id: 'sb-estoque', name: 'Meu Estoque', path: '/stockbridge/estoque', icon: Package, roles: ['operador', 'gestor', 'diretor'], group: 'Operação' },
  { id: 'sb-fila', name: 'Recebimento', path: '/stockbridge/fila', icon: FileText, roles: ['operador', 'gestor', 'diretor'], group: 'Operação' },
  { id: 'sb-saida-manual', name: 'Saída Manual', path: '/stockbridge/saida-manual', icon: ShoppingCart, roles: ['operador', 'gestor', 'diretor'], group: 'Operação' },
  { id: 'sb-comodato-retorno', name: 'Retorno Comodato', path: '/stockbridge/comodato-retorno', icon: RotateCcw, roles: ['operador', 'gestor', 'diretor'], group: 'Operação' },
  { id: 'sb-movimentacoes', name: 'Movimentações', path: '/stockbridge/movimentacoes', icon: Table, roles: ['operador', 'gestor', 'diretor'], group: 'Operação' },
  { id: 'sb-transito', name: 'Trânsito', path: '/stockbridge/transito', icon: Activity, roles: ['operador', 'gestor', 'diretor'], group: 'Operação' },
  { id: 'sb-cockpit', name: 'Cockpit', path: '/stockbridge/cockpit', icon: LayoutDashboard, roles: ['gestor', 'diretor'], group: 'Gestão' },
  { id: 'sb-aprovacoes', name: 'Aprovações', path: '/stockbridge/aprovacoes', icon: Bell, roles: ['gestor', 'diretor'], group: 'Gestão' },
  { id: 'sb-divergencias', name: 'Divergências', path: '/stockbridge/divergencias', icon: AlertTriangle, roles: ['gestor', 'diretor'], group: 'Gestão' },
  { id: 'sb-conferencia', name: 'Conferência de Estoque', path: '/stockbridge/conferencia', icon: Scale, roles: ['gestor', 'diretor'], group: 'Gestão' },
  { id: 'sb-pendencias-fiscais', name: 'Pendências Fiscais', path: '/stockbridge/pendencias-fiscais', icon: FileWarning, roles: ['gestor', 'diretor'], group: 'Gestão' },
  { id: 'sb-custos', name: 'Custos de Estoque', path: '/stockbridge/custos', icon: Coins, roles: ['gestor', 'diretor'], group: 'Gestão' },
  { id: 'sb-metricas', name: 'Métricas', path: '/stockbridge/metricas', icon: BarChart3, roles: ['diretor'], group: 'Gestão' },
  { id: 'sb-fornecedores', name: 'Fornecedores', path: '/stockbridge/fornecedores', icon: Building2, roles: ['diretor'], group: 'Cadastros' },
  { id: 'sb-localidades', name: 'Localidades', path: '/stockbridge/localidades', icon: Landmark, roles: ['gestor', 'diretor'], group: 'Cadastros' },
  { id: 'sb-config', name: 'Indicadores por Produto', path: '/stockbridge/config-produtos', icon: Settings, roles: ['diretor'], group: 'Cadastros' },
  { id: 'sb-user-galpao', name: 'Galpões × Usuários', path: '/stockbridge/admin/user-galpao', icon: Users, roles: ['gestor', 'diretor'], group: 'Cadastros' },
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
  { id: 'hedge-simulacao', name: 'Simulação', path: '/hedge/simulacao', icon: Activity },
  { id: 'hedge-estoque', name: 'Estoque', path: '/hedge/estoque', icon: Package },
  { id: 'hedge-alertas', name: 'Alertas', path: '/hedge/alertas', icon: Bell },
  { id: 'hedge-config', name: 'Configuração', path: '/hedge/config', icon: Settings },
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});


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
  // Guard com isAuthenticated pra evitar fetch /modules retornar 401 antes
  // do auth validar e cachear [] por 5min — sintoma classico era sidebar
  // vazia logo apos login, exigindo F5 pra renderizar.
  const { data: modules = [] } = useModules({ enabled: isAuthenticated });
  const location = useLocation();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const csrfToken = useAuthStore((s) => s.csrfToken);

  // Contador de aprovacoes pendentes — so pra gestor/diretor (operador 403 na rota).
  // Hook precisa rodar SEMPRE (Rules of Hooks); guarded por `enabled` quando user nao esta pronto.
  const podeAprovar = user?.role === 'gestor' || user?.role === 'diretor';
  const { data: aprovacoesCount = 0 } = useQuery<number>({
    queryKey: ['stockbridge', 'aprovacoes', 'count'],
    enabled: !!user && podeAprovar,
    refetchInterval: 30_000,
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/stockbridge/aprovacoes', { credentials: 'include', headers });
      if (!res.ok) return 0;
      const body = (await res.json()) as { data: unknown[] };
      return Array.isArray(body.data) ? body.data.length : 0;
    },
  });

  // Contador de divergencias abertas — gestor/diretor (badge no menu lateral).
  const { data: divergenciasCount = 0 } = useQuery<number>({
    queryKey: ['stockbridge', 'divergencias', 'count'],
    enabled: !!user && podeAprovar,
    refetchInterval: 30_000,
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/stockbridge/divergencias?status=aberta', { credentials: 'include', headers });
      if (!res.ok) return 0;
      const body = (await res.json()) as { data: unknown[] };
      return Array.isArray(body.data) ? body.data.length : 0;
    },
  });

  // Contador da Conferência de Estoque (itens com Status Geral != OK) — badge no menu.
  const { data: conferenciaCount = 0 } = useQuery<number>({
    queryKey: ['stockbridge', 'conferencia', 'contagem'],
    enabled: !!user && podeAprovar,
    refetchInterval: 30_000,
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/stockbridge/conferencia/contagem', { credentials: 'include', headers });
      if (!res.ok) return 0;
      const body = (await res.json()) as { data: { contagem?: number } | null };
      return body.data?.contagem ?? 0;
    },
  });

  // Contador de rejeicoes pendentes do operador — quebrado entre recebimento (tem
  // loteId) e saida manual (nao tem). Cada badge aparece no item da sidebar
  // correspondente: o operador ve um sino vermelho quando tem coisa esperando dele.
  const { data: minhasRejeicoes = { recebimento: 0, saidaManual: 0 } } = useQuery<{
    recebimento: number;
    saidaManual: number;
  }>({
    queryKey: ['stockbridge', 'minhas-rejeicoes', 'count'],
    enabled: !!user, // todos os perfis tem acesso a propria caixa de rejeicoes
    refetchInterval: 30_000,
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/stockbridge/aprovacoes/minhas-rejeicoes', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) return { recebimento: 0, saidaManual: 0 };
      const body = (await res.json()) as {
        data: Array<{ loteId: string | null; tipoAprovacao: string }>;
      };
      const lista = Array.isArray(body.data) ? body.data : [];
      return {
        recebimento: lista.filter((r) => r.loteId !== null || r.tipoAprovacao === 'entrada_manual').length,
        saidaManual: lista.filter((r) => r.loteId === null && r.tipoAprovacao !== 'entrada_manual').length,
      };
    },
  });

  // Contador de comodatos em aberto, separado por dentro/fora do prazo.
  // Endpoint retorna { vencido: boolean } por linha — basta contar.
  const { data: comodatosCount = { noPrazo: 0, vencidos: 0 } } = useQuery<{
    noPrazo: number;
    vencidos: number;
  }>({
    queryKey: ['stockbridge', 'comodatos', 'count'],
    enabled: !!user,
    refetchInterval: 60_000,
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/stockbridge/comodato/abertos', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) return { noPrazo: 0, vencidos: 0 };
      const body = (await res.json()) as { data: Array<{ vencido: boolean }> };
      const lista = Array.isArray(body.data) ? body.data : [];
      return {
        noPrazo: lista.filter((c) => !c.vencido).length,
        vencidos: lista.filter((c) => c.vencido).length,
      };
    },
  });

  // Gestor/diretor sem 2FA configurado precisa ir para o setup.
  const precisa2faSetup =
    !!user &&
    (user.role === 'gestor' || user.role === 'diretor') &&
    !user.totp_enabled &&
    location.pathname !== '/2fa/setup';

  // navigate() precisa rodar num efeito, não durante o render — chamá-lo direto no
  // corpo do componente (como antes) dispara o warning do React Router "You should
  // call navigate() in a React.useEffect()" e pode causar navegação/estado
  // inconsistente entre renders concorrentes.
  useEffect(() => {
    if (precisa2faSetup) {
      navigate('/2fa/setup', { replace: true });
    }
  }, [precisa2faSetup, navigate]);

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

  if (precisa2faSetup) {
    return null;
  }

  // Filtra itens cujo `roles` nao inclui o role do user. Itens sem `roles`
  // declarado ficam visiveis pra todos (default conservador). Backend continua
  // sendo a fonte da verdade — isso aqui e cosmetico.
  const stockbridgeSubItems = STOCKBRIDGE_SUB_ITEMS
    .filter((s) => !s.roles || s.roles.includes(user.role))
    .map((s) => {
      if (s.id === 'sb-aprovacoes') return { ...s, badge: aprovacoesCount };
      if (s.id === 'sb-divergencias') return { ...s, badge: divergenciasCount };
      if (s.id === 'sb-conferencia') return { ...s, badge: conferenciaCount };
      if (s.id === 'sb-fila') return { ...s, badge: minhasRejeicoes.recebimento };
      if (s.id === 'sb-saida-manual') return { ...s, badge: minhasRejeicoes.saidaManual };
      if (s.id === 'sb-comodato-retorno') {
        return {
          ...s,
          badges: [
            { count: comodatosCount.noPrazo, color: 'emerald' as const, title: 'Comodatos no prazo' },
            { count: comodatosCount.vencidos, color: 'red' as const, title: 'Comodatos vencidos' },
          ],
        };
      }
      return s;
    });

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
              ? stockbridgeSubItems
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
            <Route index element={<SBIndexRedirect role={user.role} />} />
            <Route path="fila" element={<FilaOmiePage />} />
            <Route path="cockpit" element={<CockpitPage />} />
            <Route path="custos" element={<CmcPage />} />
            <Route path="aprovacoes" element={<AprovacoesPage />} />
            <Route path="divergencias" element={<DivergenciasPage />} />
            <Route path="conferencia" element={<ConferenciaEstoquePage />} />
            <Route path="pendencias-fiscais" element={<PendenciasFiscaisPage />} />
            <Route path="movimentacoes" element={<MovimentacoesPage />} />
            <Route path="transito" element={<TransitoPage />} />
            <Route path="saida-manual" element={<SaidaManualPage />} />
            <Route path="comodato-retorno" element={<ComodatoRetornoPage />} />
            <Route path="metricas" element={<MetricasPage />} />
            <Route path="fornecedores" element={<FornecedoresPage />} />
            <Route path="localidades" element={<LocalidadesPage />} />
            <Route path="config-produtos" element={<ConfigProdutosPage />} />
            <Route path="estoque" element={<MeuEstoquePage />} />
            <Route path="admin/user-galpao" element={<UserGalpaoPage />} />
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

/** Redireciona a rota index do StockBridge pra tela certa por role. */
function SBIndexRedirect({ role }: { role: string }) {
  if (role === 'operador') return <Navigate to="/stockbridge/fila" replace />;
  return <Navigate to="/stockbridge/cockpit" replace />;
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