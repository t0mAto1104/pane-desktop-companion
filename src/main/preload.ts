import { contextBridge, ipcRenderer } from 'electron';
import type { Actions, Desktop, Events } from '../shared';

const channelNames = new Set(['capture', 'observation', 'chat', 'account', 'shown']);
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
contextBridge.exposeInMainWorld('pane', api);
