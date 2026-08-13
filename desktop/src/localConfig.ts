export interface DesktopConfig {
  vaultPath?: string;
  secret: string;
  dataDirName: 'server-data' | 'server-data-v3';
}

export function parseDesktopConfig(value: unknown): DesktopConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DesktopConfig>;
  if (typeof candidate.secret !== 'string' || candidate.secret.length < 12) return null;
  return {
    secret: candidate.secret,
    dataDirName: candidate.dataDirName === 'server-data-v3' ? 'server-data-v3' : 'server-data',
    ...(typeof candidate.vaultPath === 'string' && candidate.vaultPath ? { vaultPath: candidate.vaultPath } : {}),
  };
}

export function isLocalAppUrl(value: string, port: number): boolean {
  try {
    return new URL(value).origin === `http://127.0.0.1:${port}`;
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}
