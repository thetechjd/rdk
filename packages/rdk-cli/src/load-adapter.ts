// packages/rdk-cli/src/load-adapter.ts
// Robustly instantiate a vault adapter regardless of how it was bundled/exported.
//
// Adapters ship in different shapes:
//   - obsidian: `export default class` → CJS bundle + dynamic import() double-wraps
//     the default, landing the class at mod.default.default
//   - filesystem: `export class FilesystemAdapter` (named, no default export)
// This resolver unwraps CJS interop and falls back to the first constructable export.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtor = new () => any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadAdapter(adapterKey: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(adapterKey);

  let AdapterClass: unknown = mod.default ?? mod;

  // Unwrap one level of CJS __esModule interop (mod.default.default)
  if (AdapterClass && typeof AdapterClass !== 'function' && (AdapterClass as { default?: unknown }).default) {
    AdapterClass = (AdapterClass as { default: unknown }).default;
  }

  // Fall back to the first constructable export (handles named-only exports)
  if (typeof AdapterClass !== 'function') {
    const candidates = [
      ...Object.values(mod),
      ...Object.values((mod.default as Record<string, unknown>) ?? {}),
    ];
    AdapterClass = candidates.find((v) => typeof v === 'function');
  }

  if (typeof AdapterClass !== 'function') {
    throw new Error(`Adapter "${adapterKey}" exposes no constructable export`);
  }

  return new (AdapterClass as AnyCtor)();
}
