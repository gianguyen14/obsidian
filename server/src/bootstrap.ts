import { loadSettings as _load, getSettings } from './services/settings.js';
import { setUserPassword } from './services/auth.js';
import { config } from './config.js';

export { getSettings };

export async function loadSettings() {
  return _load();
}

export async function setPasswordIfInitial(): Promise<void> {
  const settings = await getSettings();
  if (config.initialPassword && !settings.auth.userPasswordHash && !settings.auth.passwordHash) {
    await setUserPassword(config.initialPassword);
    console.log('[boot] initialized the owner password from WEBOBSIDIAN_PASSWORD');
  }
}
