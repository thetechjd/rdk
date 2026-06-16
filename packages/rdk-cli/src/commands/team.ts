// packages/rdk-cli/src/commands/team.ts
import crypto from 'crypto';
import { loadConfig, updateConfig } from '../config.js';
import { retrodeckFetch, RetrodeckAuthError } from '../retrodeck-api.js';
import { t, mark, divider } from '../theme.js';
import { input, confirm } from '../prompts.js';

/** Print a session-expired hint for auth failures; returns true if handled. */
function handledAuthError(e: unknown): boolean {
  if (e instanceof RetrodeckAuthError) {
    console.log(t.error('Your RetroDeck session has expired. Run: rdk account:login'));
    return true;
  }
  return false;
}

/** rdk team:invite <email> */
export async function teamInvite(email: string): Promise<void> {
  const config = loadConfig();

  if (!config.vaultKeyHex) {
    console.log(t.error('No vault key found. Run rdk init first.'));
    return;
  }

  const { createKeyShare, keyFromHex } = await import('@rdk/core');

  const inviteCode = crypto.randomBytes(16).toString('base64url');
  const vaultKey   = keyFromHex(config.vaultKeyHex);
  const keyShare   = createKeyShare(vaultKey, inviteCode);

  try {
    const res = await retrodeckFetch('/api/v1/team/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        granteeEmail: email,
        keyShare,
        ownerNodeId: config.nodeId,
        expiresInHours: 48,
      }),
    });

    if (!res.ok) {
      console.log(t.error(`Invite failed: ${await res.text()}`));
      return;
    }

    const data = await res.json() as { inviteId: string };

    console.log('');
    console.log(t.green(`  ✓ Invite created for ${email}`));
    console.log('');
    console.log(t.heading('  Share this with your team member:'));
    console.log('');
    console.log(t.warn(`  Invite code: ${inviteCode}`));
    console.log(t.dim(`  Invite ID:   ${data.inviteId}`));
    console.log('');
    console.log(t.dim('  They should run:'));
    console.log(t.green(`  rdk team:accept ${data.inviteId}`));
    console.log('');
    console.log(t.dim('  Then enter the invite code when prompted.'));
    console.log(t.dim('  Expires in 48 hours.'));
    console.log('');
  } catch (e) {
    if (handledAuthError(e)) return;
    console.log(t.error(`Network error: ${(e as Error).message}`));
  }
}

/** rdk team:accept <inviteId> */
export async function teamAccept(inviteId: string): Promise<void> {
  const config = loadConfig();

  const inviteCode = await input({
    message: 'Enter the invite code from your team owner:',
    validate: v => v.length > 0 || 'Invite code required',
  });

  try {
    const res = await retrodeckFetch(`/api/v1/team/invite/${inviteId}`);

    if (!res.ok) {
      console.log(t.error('Invite not found or expired.'));
      return;
    }

    const data = await res.json() as {
      keyShare: string;
      ownerNodeId: string;
      ownerEmail: string;
    };

    const { unwrapKeyShare, keyToHex } = await import('@rdk/core');
    const vaultKey = unwrapKeyShare(data.keyShare, inviteCode);

    const sharedKeys = config.sharedVaultKeys ?? {};
    sharedKeys[data.ownerNodeId] = keyToHex(vaultKey);
    updateConfig({ sharedVaultKeys: sharedKeys });

    // Notify RetroDeck that invite was accepted
    await retrodeckFetch(`/api/v1/team/invite/${inviteId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeNodeId: config.nodeId }),
    });

    console.log('');
    console.log(t.green(`  ✓ Access granted to ${data.ownerEmail}'s private chunks`));
    console.log(t.dim('  They can now decrypt and query your private chunks.'));
    console.log('');
  } catch (e) {
    if (handledAuthError(e)) return;
    console.log(t.error(`Failed: ${(e as Error).message}`));
  }
}

/** rdk team:list */
export async function teamList(): Promise<void> {
  try {
    const res = await retrodeckFetch('/api/v1/team');

    if (!res.ok) {
      console.log(t.error('Could not fetch team list.'));
      return;
    }

    const data = await res.json() as {
      members: Array<{ email: string; nodeId: string; grantedAt: string }>;
    };

    console.log('');
    console.log(t.heading('  Team members with access to your private chunks'));
    console.log(divider(40));
    console.log('');

    if (data.members.length === 0) {
      console.log(t.dim('  No team members yet.'));
      console.log(t.dim('  Invite with: rdk team:invite email@example.com'));
    } else {
      for (const m of data.members) {
        console.log(`  ${mark.ok()} ${t.body(m.email)}`);
        console.log(t.dim(`       granted ${new Date(m.grantedAt).toLocaleDateString()}`));
      }
    }
    console.log('');
  } catch (e) {
    if (handledAuthError(e)) return;
    console.log(t.error((e as Error).message));
  }
}

/** rdk team:revoke <email> */
export async function teamRevoke(email: string): Promise<void> {
  const config = loadConfig();

  const confirmed = await confirm({
    message: `Revoke vault access for ${email}?`,
    default: false,
  });
  if (!confirmed) return;

  try {
    const res = await retrodeckFetch('/api/v1/team/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: email, ownerNodeId: config.nodeId }),
    });

    if (res.ok) {
      console.log(t.green(`  ✓ Access revoked for ${email}`));
      console.log(t.dim('  Note: rotate your vault key to fully invalidate access.'));
      console.log(t.dim('  Run: rdk vault:rotate-key'));
    } else {
      console.log(t.error('Revoke failed.'));
    }
  } catch (e) {
    if (handledAuthError(e)) return;
    console.log(t.error((e as Error).message));
  }
}

/** rdk vault:rotate-key */
export async function rotateVaultKey(): Promise<void> {
  const config = loadConfig();

  if (!config.vaultKeyHex) {
    console.log(t.error('No vault key found. Run rdk init first.'));
    return;
  }

  const confirmed = await confirm({
    message: 'Rotate vault key? All team members will lose access and must be re-invited.',
    default: false,
  });
  if (!confirmed) return;

  const ora = (await import('ora')).default;
  const { generateVaultKey, keyToHex, keyFromHex, decrypt, encrypt, LocalStore } =
    await import('@rdk/core');

  const oldKey    = keyFromHex(config.vaultKeyHex);
  const newKey    = generateVaultKey();
  const newKeyHex = keyToHex(newKey);

  const store   = new LocalStore();
  const spinner = ora('  Re-encrypting private chunks...').start();

  try {
    const allChunks = store.getAllPrivateEncryptedChunks();
    let reencrypted = 0;

    for (const chunk of allChunks) {
      try {
        const plaintext    = decrypt(chunk.content, oldKey);
        const newCiphertext = encrypt(plaintext, newKey);
        store.updateChunkContent(chunk.id, newCiphertext);
        reencrypted++;
      } catch {
        // Skip chunks that fail decryption with the old key
      }
    }

    updateConfig({ vaultKeyHex: newKeyHex, sharedVaultKeys: {} });

    spinner.succeed(`  Re-encrypted ${reencrypted} chunks`);
    console.log('');
    console.log(t.warn('  ⚠ All team access to your private chunks has been invalidated.'));
    console.log(t.dim('  Your local vault files are unchanged.'));
    console.log(t.dim('  Re-invite team members with: rdk team:invite <email>'));
    console.log('');
  } catch (e) {
    spinner.fail((e as Error).message);
  } finally {
    store.close();
  }
}
