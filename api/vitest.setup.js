// Vitest setup — provide the Web Crypto global on Node < 20.
// CI runs the suite on Node 18.x, where `globalThis.crypto` (Web Crypto) is not
// exposed as a global by default. The Worker runtime always has it, and Node 20+
// does too, so this shim only fills the gap for the older CI runner. No effect
// on production code.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
