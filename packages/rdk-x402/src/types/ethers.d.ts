// Minimal type stub for ethers.
// The real package is an optional runtime dependency installed on demand via `rdk tips:enable`.
// This stub satisfies the TypeScript compiler without requiring the package at build time.
declare module 'ethers' {
  export class JsonRpcProvider {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(url: string, ...args: any[]);
  }
  export class Wallet {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(privateKey: string, provider?: any);
    readonly address: string;
  }
  export class Contract {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(address: string, abi: any[], provider: any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [method: string]: any;
  }
  export namespace utils {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function parseUnits(value: string, decimals: number): any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function parseUnits(value: string, decimals: number): any;
}
