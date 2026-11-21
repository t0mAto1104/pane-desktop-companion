import { contextBridge, ipcRenderer } from 'electron';
import type { Actions, Desktop, Events } from '../shared';

import type { SelectionBridge } from '../selection';

const channelNames = new Set(['capture', 'observation', 'chat', 'guidance', 'account', 'shown', 'mascot', 'settings', 'interaction', 'voice']);
const api: Desktop = {
  call(name: keyof Actions, ...args: unknown[]) {
    return ipcRenderer.invoke('pane:call', name, args);
  },
  subscribe<K extends keyof Events>(name: K, listener: (payload: Events[K]) => void) {
    if (!channelNames.has(name)) throw new Error('Unknown event');
    const channel = `pane:${name}`;
    const wrapped = (_event: Electron.IpcRendererEvent, payload: Events[K]) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => { ipcRenderer.removeListener(channel, wrapped); };
  },
};
if (window.location.hash === '#selection') {
  const selection: SelectionBridge = {
    call: (name, ...args) => ipcRenderer.invoke('pane:selection', name, args),
    subscribe(listener) {
      const channel = 'pane:selection:view';
      const wrapped = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on(channel, wrapped);
      return () => { ipcRenderer.removeListener(channel, wrapped); };
    },
  };
  contextBridge.exposeInMainWorld('paneSelection', selection);
} else contextBridge.exposeInMainWorld('pane', api);
