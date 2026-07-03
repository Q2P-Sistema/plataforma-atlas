import { useState } from 'react';
import { Menu, X, ChevronLeft, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type SidebarBadgeColor = 'red' | 'emerald' | 'amber';

export interface SidebarBadge {
  count: number;
  color: SidebarBadgeColor;
  /** Tooltip ao passar o mouse — explica o que o numero representa. */
  title?: string;
}

export type SidebarRole = 'operador' | 'gestor' | 'diretor';

export interface SidebarSubItem {
  id: string;
  name: string;
  path: string;
  icon: LucideIcon;
  /** Quando > 0, mostra um badge vermelho ao lado do item (estilo notificacao). */
  badge?: number | null;
  /** Multiplos badges coloridos lado a lado. Tem precedencia sobre `badge`. */
  badges?: SidebarBadge[];
  /**
   * Roles que veem o item. Ausente = todos os roles autenticados veem.
   * Filtro e responsabilidade do caller (App.tsx) — Sidebar so renderiza
   * o que receber.
   */
  roles?: SidebarRole[];
  /**
   * Cabecalho de secao no menu (ex.: "Operação"/"Gestão"/"Cadastros").
   * Renderizado quando difere do item visivel anterior — agrupe itens da
   * mesma secao em sequencia. Ausente = sem cabecalho.
   */
  group?: string;
}

export interface SidebarModule {
  id: string;
  name: string;
  enabled: boolean;
  path: string;
  icon: LucideIcon;
  subItems?: SidebarSubItem[];
}

interface SidebarProps {
  modules: SidebarModule[];
  currentPath: string;
  onNavigate: (path: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  userRole?: string;
}

export function Sidebar({
  modules,
  currentPath,
  onNavigate,
  collapsed = false,
  onToggleCollapse,
  userRole,
}: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-atlas-card border border-atlas-border shadow-md"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'}
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Overlay mobile */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:sticky top-0 left-0 z-40 h-screen
          bg-atlas-card border-r border-atlas-border
          flex flex-col transition-all duration-200
          ${collapsed ? 'w-16' : 'w-60'}
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-atlas-border">
          {!collapsed && (
            <h1 className="font-heading text-xl font-bold text-atlas-text">
              Atlas
            </h1>
          )}
          {collapsed && (
            <span className="font-heading text-xl font-bold text-atlas-text mx-auto">
              A
            </span>
          )}
          <button
            onClick={onToggleCollapse}
            className="hidden lg:flex p-1 rounded hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors"
            aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
          >
            <ChevronLeft
              size={16}
              className={`transition-transform ${collapsed ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        {/* Modules */}
        <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
          {modules.map((mod) => {
            const Icon = mod.icon;
            const isActive = currentPath.startsWith(mod.path);
            const isEnabled = mod.enabled;
            const showSub = isActive && isEnabled && mod.subItems && !collapsed;

            return (
              <div key={mod.id}>
                <button
                  onClick={() => {
                    if (isEnabled) {
                      onNavigate(mod.path);
                      setMobileOpen(false);
                    }
                  }}
                  disabled={!isEnabled}
                  title={collapsed ? mod.name : undefined}
                  className={`
                    w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                    transition-colors focus:outline-none focus:ring-2 focus:ring-acxe
                    ${
                      isActive && isEnabled
                        ? 'bg-acxe/10 text-acxe'
                        : isEnabled
                          ? 'text-atlas-text hover:bg-atlas-border/50'
                          : 'text-atlas-muted/50 cursor-not-allowed'
                    }
                  `}
                >
                  <Icon size={18} className="shrink-0" />
                  {!collapsed && <span className="truncate">{mod.name}</span>}
                  {!collapsed && !isEnabled && (
                    <span className="ml-auto text-[10px] text-atlas-muted/40 uppercase tracking-wider">
                      inativo
                    </span>
                  )}
                </button>
                {showSub && (
                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-atlas-border/50 pl-2">
                    {mod.subItems!.map((sub, subIdx) => {
                      const SubIcon = sub.icon;
                      const isSubActive =
                        sub.path === mod.path
                          ? currentPath === sub.path
                          : currentPath.startsWith(sub.path);
                      // Cabecalho de secao quando o grupo muda em relacao ao
                      // item visivel anterior (itens ja chegam filtrados por role).
                      const showGroupHeader =
                        sub.group != null && sub.group !== mod.subItems![subIdx - 1]?.group;
                      return (
                        <div key={sub.id}>
                          {showGroupHeader && (
                            <div className={`px-2.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-atlas-muted/60 select-none ${subIdx > 0 ? 'pt-2.5' : 'pt-1'}`}>
                              {sub.group}
                            </div>
                          )}
                        <button
                          onClick={() => {
                            onNavigate(sub.path);
                            setMobileOpen(false);
                          }}
                          className={`
                            w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium
                            transition-colors focus:outline-none focus:ring-2 focus:ring-acxe
                            ${
                              isSubActive
                                ? 'text-acxe bg-acxe/5'
                                : 'text-atlas-muted hover:text-atlas-text hover:bg-atlas-border/30'
                            }
                          `}
                        >
                          <SubIcon size={14} className="shrink-0" />
                          <span className="truncate">{sub.name}</span>
                          {sub.badges && sub.badges.length > 0 ? (
                            <span className="ml-auto inline-flex items-center gap-1">
                              {sub.badges
                                .filter((b) => b.count > 0)
                                .map((b, i) => (
                                  <span
                                    key={i}
                                    title={b.title}
                                    className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold text-white rounded-full ${
                                      b.color === 'emerald'
                                        ? 'bg-success'
                                        : b.color === 'amber'
                                          ? 'bg-warn'
                                          : 'bg-crit'
                                    }`}
                                  >
                                    {b.count > 99 ? '99+' : b.count}
                                  </span>
                                ))}
                            </span>
                          ) : sub.badge != null && sub.badge > 0 ? (
                            <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold text-white bg-crit rounded-full">
                              {sub.badge > 99 ? '99+' : sub.badge}
                            </span>
                          ) : null}
                        </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Admin — only for diretor */}
        {userRole === 'diretor' && (
          <div className="px-2 pb-1">
            <button
              onClick={() => { onNavigate('/admin/users'); setMobileOpen(false); }}
              title={collapsed ? 'Usuários' : undefined}
              className={`
                w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                transition-colors focus:outline-none focus:ring-2 focus:ring-acxe
                ${currentPath.startsWith('/admin') ? 'bg-acxe/10 text-acxe' : 'text-atlas-muted hover:text-atlas-text hover:bg-atlas-border/50'}
              `}
            >
              <Users size={18} className="shrink-0" />
              {!collapsed && <span>Usuários</span>}
            </button>
          </div>
        )}

        {/* Footer */}
        {!collapsed && (
          <div className="px-4 py-3 border-t border-atlas-border">
            <p className="text-[10px] text-atlas-muted">ACXE + Q2P</p>
          </div>
        )}
      </aside>
    </>
  );
}
