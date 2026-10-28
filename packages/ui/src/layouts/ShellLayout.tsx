import { useState } from 'react';
import { Sidebar, type SidebarModule } from '../components/Sidebar.js';
import { TopBar } from '../components/TopBar.js';

interface ShellLayoutProps {
  modules: SidebarModule[];
  currentPath: string;
  onNavigate: (path: string) => void;
  userName: string;
  userRole: string;
  onLogout: () => void;
  children: React.ReactNode;
  topBarSlot?: React.ReactNode;
  /** Tag da versão em execução (ex. "v1.1.32"), exibida no rodapé do menu. */
  versao?: string | null;
}

export function ShellLayout({
  modules,
  currentPath,
  onNavigate,
  userName,
  userRole,
  onLogout,
  children,
  topBarSlot,
  versao,
}: ShellLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen-app flex bg-atlas-bg">
      <Sidebar
        modules={modules}
        currentPath={currentPath}
        onNavigate={onNavigate}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(!collapsed)}
        userRole={userRole}
        versao={versao}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar userName={userName} userRole={userRole} onLogout={onLogout} centerSlot={topBarSlot} />

        <main className="flex-1 p-6 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
