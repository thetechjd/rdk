import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
}));

/**
 * The desktop is a HUMAN surface and must never redact.
 *
 * This is the other half of the redaction guarantee, and the half that breaks
 * quietly. If a model-facing path stops redacting, a compliance review catches
 * it. If a human path STARTS redacting, nothing fails — a teammate just finds
 * their colleague's shared document full of [PERSON_9a7614] and assumes RDK is
 * broken. The team is trusted with the full document; that is the entire premise
 * the feature rests on.
 *
 * The desktop process now installs the org policy at startNode() (so its status
 * surface can report one, and so a future local-model query inherits
 * enforcement). These tests exist to prove that installing it changes nothing
 * about what a person reads.
 */
describe('desktop reads are never redacted', () => {
  /** The kind of policy an enterprise would actually deploy. */
  const AGGRESSIVE_RULES = [
    { ruleType: 'builtin' as const, builtinKey: 'ssn', tokenPrefix: 'SSN' },
    { ruleType: 'builtin' as const, builtinKey: 'email', tokenPrefix: 'EMAIL' },
    { ruleType: 'builtin' as const, builtinKey: 'credit_card', tokenPrefix: 'CARD' },
    { ruleType: 'termlist' as const, terms: ['Jane Doe', 'Project Northstar'], tokenPrefix: 'INTERNAL' },
  ];

  const SENSITIVE =
    '# Case notes\n\n' +
    'Jane Doe (jane@acme.co, SSN 123-45-6789) disputed invoice #4471.\n' +
    'Card on file 4111 1111 1111 1111. Escalated to Project Northstar.';

  const SECRETS = [
    'Jane Doe', 'jane@acme.co', '123-45-6789', '4111 1111 1111 1111', 'Project Northstar',
  ];

  /** Install a live org policy, exactly as a member node would hold one. */
  async function activatePolicy() {
    const { setActiveRedactionPolicy, redactionIsActive } = await import('@rdk/core');
    setActiveRedactionPolicy({
      enabled: true,
      version: 'test-policy',
      rules: AGGRESSIVE_RULES,
      tokenSalt: 'a'.repeat(64),
    });
    // Guard the guard: a test that silently ran with no policy would pass for
    // the wrong reason and prove nothing.
    expect(redactionIsActive()).toBe(true);
  }

  it('returns a private chunk in full, decrypted, with an org policy in force', async () => {
    await activatePolicy();
    const { encrypt, generateVaultKey, keyToHex } = await import('@rdk/core');
    const { NodeService } = await import('../../electron/node-service.js');

    const vaultKey = generateVaultKey();
    const service = new NodeService() as unknown as {
      readContent(id: string): { body: string; decrypted: boolean; state: string } | null;
      getStore(): unknown;
      getConfig(): unknown;
    };

    service.getConfig = () => ({ nodeId: 'node-me', vaultKeyHex: keyToHex(vaultKey) });
    service.getStore = () => ({
      getChunk: () => ({
        id: 'chunk-1',
        title: 'Case notes',
        content: encrypt(SENSITIVE, vaultKey),
        isEncrypted: true,
        isPublic: false,
        sourcePath: '/vault/case-notes.md',
      }),
    });

    const view = service.readContent('chunk-1');

    expect(view?.decrypted).toBe(true);
    expect(view?.body).toBe(SENSITIVE);
    for (const secret of SECRETS) expect(view?.body, secret).toContain(secret);
    expect(view?.body).not.toMatch(/\[[A-Z]+_[0-9a-f]{6}]/);
  }, 30_000);

  it('returns a plaintext public chunk in full too', async () => {
    await activatePolicy();
    const { NodeService } = await import('../../electron/node-service.js');

    const service = new NodeService() as unknown as {
      readContent(id: string): { body: string } | null;
      getStore(): unknown;
      getConfig(): unknown;
    };

    service.getConfig = () => ({ nodeId: 'node-me' });
    service.getStore = () => ({
      getChunk: () => ({
        id: 'chunk-2',
        title: 'Case notes',
        content: SENSITIVE,
        isEncrypted: false,
        isPublic: true,
      }),
    });

    expect(service.readContent('chunk-2')?.body).toBe(SENSITIVE);
  }, 30_000);

  it("hands a teammate's shared document to the UI whole", async () => {
    await activatePolicy();
    const { NodeService } = await import('../../electron/node-service.js');

    // The teammate path: the chunk arrives from the owning node as ciphertext,
    // the router decrypts it locally with the shared vault key, and the result
    // reaches the UI through query(). Redaction must not sit anywhere on that
    // hop — the whole point of team access is reading the real document.
    const service = new NodeService() as unknown as {
      query(q: string): Promise<{ hits: Array<{ preview?: string; title: string }> }>;
      embedderAvailable(): Promise<boolean>;
      getConfig(): unknown;
      getRouter(): unknown;
    };

    service.embedderAvailable = async () => true;
    service.getConfig = () => ({ nodeId: 'node-me' });
    service.getRouter = () => ({
      query: async () => ({
        source: 'private',
        chunks: [{
          id: 'shared-1',
          title: 'Case notes',
          docTitle: 'Case notes',
          sourcePath: '/vault/shared/case-notes.md',
          // Already decrypted by the router with the shared vault key.
          content: SENSITIVE,
          score: 0.91,
        }],
        tokenEstimate: 100,
        tipsPaid: [],
        latencyMs: 4,
      }),
    });

    const result = await service.query('case notes');
    const serialized = JSON.stringify(result);

    expect(result.hits.length).toBeGreaterThan(0);
    expect(serialized).not.toMatch(/\[[A-Z]+_[0-9a-f]{6}]/);
    // The preview is truncated for display, so assert on what it does carry
    // rather than on every secret in the document.
    expect(serialized).toContain('Jane Doe');
  }, 30_000);
});
