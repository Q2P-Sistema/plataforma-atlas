export const MODULE_KEYS = [
  'hedge',
  'stockbridge',
  'breakingpoint',
  'clevel',
  'comexinsight',
  'comexflow',
  'forecast',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export function isModuleKey(key: string): key is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(key);
}
