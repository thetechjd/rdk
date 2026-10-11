import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
describe('Hosted node config keys',()=>{
  it('requires a valid master-derived key and does not fall back to machine identity',async()=>{
    vi.stubEnv('RDK_CONFIG_ENCRYPTION_KEY','invalid');vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow('32 hex-encoded bytes');
  });
  it('isolates encrypted node secrets between hosted projects',async()=>{
    vi.stubEnv('RDK_CONFIG_ENCRYPTION_KEY','12'.repeat(32));vi.resetModules();
    const first=await import('../src/config.js');const ciphertext=first.encryptValue('private-vault-key');
    expect(first.decryptValue(ciphertext)).toBe('private-vault-key');
    vi.stubEnv('RDK_CONFIG_ENCRYPTION_KEY','34'.repeat(32));vi.resetModules();
    const second=await import('../src/config.js');expect(()=>second.decryptValue(ciphertext)).toThrow('decrypt');
  });
});
