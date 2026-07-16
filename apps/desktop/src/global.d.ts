import type { RdkApi } from '../shared/ipc';

declare global {
  interface Window {
    rdk: RdkApi;
    rdkNative: { pathForFile(file: File): string };
  }
}

export {};
