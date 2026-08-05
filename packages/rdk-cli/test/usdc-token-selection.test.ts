import { describe, it, expect } from 'vitest';
import { usdcEntry, type WalletShow } from '../src/commands/cryptocadet.js';

/**
 * Which USDC the wallet balance is read from.
 *
 * Selecting by symbol returned whichever entry was listed first. A wallet whose
 * policy allowlist holds both the old and the new USDC contract has two entries
 * both called "USDC", so an upgrade reported the balance of a token the payment
 * would not use — and looked funded when it was not.
 */
const OLD = '0x1111111111111111111111111111111111111111';
const NEW = '0x2222222222222222222222222222222222222222';

const wallet = (tokens: Array<[string, string, string]>): WalletShow => ({
  agentAddress: '0xagent',
  chainId: 8453,
  tokens: tokens.map(([token, symbol, balance]) => ({
    token, symbol, balance, reserve: '0', spendable: balance,
  })),
});

describe('choosing the USDC entry', () => {
  it('uses the contract the offer names, not the first one called USDC', () => {
    const w = wallet([[OLD, 'USDC', '54000000'], [NEW, 'USDC', '0']]);

    // Symbol matching would have returned the old token's 54 USDC.
    expect(usdcEntry(w, NEW)?.token).toBe(NEW);
    expect(usdcEntry(w, NEW)?.balance).toBe('0');
  });

  it('matches regardless of address casing', () => {
    const w = wallet([[NEW, 'USDC', '25000000']]);
    expect(usdcEntry(w, NEW.toUpperCase())?.token).toBe(NEW);
  });

  it('returns null when the wallet does not hold the named contract', () => {
    const w = wallet([[OLD, 'USDC', '54000000']]);
    // Falling back to the symbol here would report a balance for a token the
    // payment cannot spend — the exact bug.
    expect(usdcEntry(w, NEW)).toBeNull();
  });

  it('falls back to symbol only when no contract is named', () => {
    const w = wallet([[OLD, 'USDC', '54000000']]);
    expect(usdcEntry(w)?.token).toBe(OLD);
  });
});
