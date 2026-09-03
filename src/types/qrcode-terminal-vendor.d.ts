// Ambient declarations for qrcode-terminal's vendored QRCode class, which has no
// bundled types. bot-onboarding.ts imports these explicit `.js` files (rather
// than the untyped `createRequire(...)` of a bare dir path) so `bun build
// --compile` embeds them into the single-file binary. Only the surface
// bot-onboarding.ts actually uses is declared.

declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  /** Low-level QR model. `typeNumber` -1 = auto-size. */
  class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    /** Row-major matrix of module on/off flags, valid after make(). */
    modules: boolean[][];
  }
  export default QRCode;
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js' {
  /** Error-correction levels (L/M/Q/H → numeric codes). */
  const QRErrorCorrectLevel: { L: number; M: number; Q: number; H: number };
  export default QRErrorCorrectLevel;
}
