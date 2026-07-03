import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  TrendingUp,
  Package,
  AlertTriangle,
  BarChart3,
  Ship,
  FileText,
  LineChart,
} from 'lucide-react';
import { MODULE_NAMES } from '../lib/modules.js';

export interface ModuleInfo {
  id: string;
  name: string;
  enabled: boolean;
  path: string;
  icon: LucideIcon;
}

const MODULE_ICONS: Record<string, LucideIcon> = {
  hedge: TrendingUp,
  stockbridge: Package,
  breakingpoint: AlertTriangle,
  clevel: BarChart3,
  comexinsight: Ship,
  comexflow: FileText,
  forecast: LineChart,
};

export function useModules(options: { enabled?: boolean } = {}) {
  return useQuery<ModuleInfo[]>({
    queryKey: ['modules'],
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const res = await fetch('/api/v1/auth/modules', { credentials: 'include' });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        data?: { modules?: { id: string; enabled: boolean }[] };
      };

      const modules = body.data?.modules ?? [];
      return modules.map((m) => ({
        id: m.id,
        name: MODULE_NAMES[m.id] ?? m.id,
        enabled: m.enabled,
        path: `/${m.id}`,
        icon: MODULE_ICONS[m.id] ?? Package,
      }));
    },
    staleTime: 5 * 60 * 1000,
  });
}
