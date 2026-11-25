
import { join } from 'node:path';
import { app, screen, shell, systemPreferences } from 'electron';
import type { DesktopPermission, DesktopPermissions } from '../shared';
import { NativeBridge, UserError } from './native';

export const mac = process.platform === 'darwin';

export function nativePaths() {
  const base = app.isPackaged ? join(process.resourcesPath, 'native')
    : join(__dirname, '../../native/bin', ...(mac ? ['macos'] : []));
  return { desktop: join(base, mac ? 'pane-native' : 'window-capture.exe'),
    whisper: join(base, 'whisper', mac ? 'whisper-cli' : 'whisper-cli.exe') };
}

export const toDip = (point: Electron.Point) => mac ? point : screen.screenToDipPoint(point);
export const toNative = (point: Electron.Point) => mac ? point : screen.dipToScreenPoint(point);
export function nativeDisplayAt(point: Electron.Point) {
  const display = screen.getDisplayNearestPoint(point);
  return mac ? { ...display, scaleFactor: 1 } : display;
}

const privacySections = {
  screen: 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  microphone: 'Privacy_Microphone',
} as const;

export function desktopPermissions(): DesktopPermissions | null {
  if (!mac) return null;
  return { accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    microphone: systemPreferences.getMediaAccessStatus('microphone') === 'granted' };
}

export async function openDesktopPermission(permission: DesktopPermission, bridge: NativeBridge) {
  if (!mac || !Object.hasOwn(privacySections, permission)) throw new UserError('此权限设置不可用。');
  const granted = permission === 'screen' ? await bridge.requestScreenPermission()
    : permission === 'accessibility' ? systemPreferences.isTrustedAccessibilityClient(true)
    : await systemPreferences.askForMediaAccess('microphone');
  if (!granted) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + privacySections[permission]);
  return desktopPermissions();
}

export async function requireMicrophone() {
  if (mac && !await systemPreferences.askForMediaAccess('microphone')) {
    throw new UserError('请在 Pane 设置的「macOS 系统权限」中允许使用麦克风。');
  }
}
