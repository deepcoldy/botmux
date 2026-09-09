declare module 'node-pty/lib/utils.js' {
  export interface NativePtyProcess {
    fd: number;
    pid: number;
    pty: string;
  }

  export interface NativePtyModule {
    fork(
      file: string,
      args: string[],
      env: string[],
      cwd: string,
      cols: number,
      rows: number,
      uid: number,
      gid: number,
      useUtf8: boolean,
      helperPath: string,
      onExit: (code: number, signal: number) => void,
    ): NativePtyProcess;
  }

  export function loadNativeModule(name: 'pty'): {
    dir: string;
    helperPath?: string | null;
    module: NativePtyModule;
  };
}
