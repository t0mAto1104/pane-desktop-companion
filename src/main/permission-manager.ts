import type { Session, WebFrameMain } from 'electron';

export function ownFrame(frame: WebFrameMain | null, expected: WebFrameMain, url: string): boolean {
  return !!frame && frame === expected && frame.url === url;
}

export function restrictSession(session: Session) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', event => event.preventDefault());
}
