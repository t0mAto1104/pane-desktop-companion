import type { SelectionRead } from '../selection';
import type { NativeBridge } from './native';

export class SelectionReader {
  constructor(private readonly native: NativeBridge) {}
  read(denied: string[], signal: AbortSignal): Promise<SelectionRead> {
    return this.native.readSelection(denied, signal);
  }
  watch(signal: AbortSignal, notify: (event: string) => void, denied: string[]) {
    this.native.watchSelection(signal, notify, denied);
  }
}
