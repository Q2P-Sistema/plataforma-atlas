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
}

export function ShellLayout({
  modules,
  currentPath,
  onNavigate,
  userName,
  userRole,
  onLogout,
  children,
}: ShellLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen flex bg-atlas-bg">
      <Sidebar
        modules={modules}
        currentPath={currentPath}
        onNavigate={onNavigate}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(!collapsed)}
        userRole={userRole}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar userName={userName} userRole={userRole} onLogout={onLogout} />

        <main className="flex-1 p-6 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
