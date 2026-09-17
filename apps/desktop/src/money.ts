/**
 * A USDC amount for display: at least 2 decimal places, up to 4.
 *
 * Tips start at $0.0001, so rounding to cents rendered real earnings as
 * "$0.00" (and three places as "$0.000"). Four places is the precision at
 * which the smallest possible tip is still visible; whole-cent amounts keep
 * their usual two places ($5.00, not $5.0000).
 */
const FORMAT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function usdc(amount: number): string {
  return FORMAT.format(Number.isFinite(amount) ? amount : 0);
}
