import type { NativeBridge } from '../src/main/native';

type Name = 'sample' | 'capture' | 'validate';
type Hold = { arrived: boolean; release: () => void; wait: Promise<void>; fail: boolean };

// Wired into the desktop test bundle only, after the real native response arrives.
export function installCaptureGate(Bridge: typeof NativeBridge) {
  const holds = new Map<Name, Hold>();
  const counts = { sample: 0, capture: 0, validate: 0 };
  Object.assign(globalThis, {
    paneCaptureGate: {
      arm(name: Name, fail = false) {
        let release!: () => void;
        const wait = new Promise<void>(done => { release = done; });
        holds.set(name, { arrived: false, release, wait, fail });
      },
      arrived: (name: Name) => holds.get(name)?.arrived ?? false,
      release(name: Name) { holds.get(name)?.release(); holds.delete(name); },
      count: (name: Name) => counts[name],
    },
  });

  async function track<T>(name: Name, work: Promise<T>) {
    counts[name]++;
    const hold = holds.get(name);
    const result = await work;
    if (hold && !hold.arrived) {
      hold.arrived = true;
      await hold.wait;
      if (hold.fail) throw new Error('测试夹具：Windows 捕获超时。');
    }
    return result;
  }

  const { capture, validate, observe } = Bridge.prototype;
  Bridge.prototype.capture = function (...args) { return track('capture', capture.apply(this, args)); };
  Bridge.prototype.validate = function (...args) { return track('validate', validate.apply(this, args)); };
  Bridge.prototype.observe = function (...args) {
    const worker = observe.apply(this, args);
    return {
      sample: () => track('sample', worker.sample()),
      jpeg: () => worker.jpeg(),
      close: () => worker.close(),
    };
  };
}
