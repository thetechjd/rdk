import { ENDPOINTS, type EndpointName } from '@retrodeck/payments-contract';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A real HTTP server standing in for the RetroDeck API.
 *
 * Deliberately a socket rather than a `fetch` stub: `retrodeckFetch` wraps every
 * call in `AbortSignal.timeout(8000)` and retries on 401 by issuing a SECOND
 * real request. A function mock can fake the response but not the transport, so
 * it cannot exercise the timeout, the retry, or the exact URL the client built.
 */

export interface RecordedRequest {
  method: string;
  /** Path including query string, e.g. `/api/v1/plans/verify-payment?ref=x`. */
  path: string;
  /** Path only, for convenient matching. */
  pathname: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (req: RecordedRequest) =>
  | { status?: number; json?: unknown; delayMs?: number }
  | undefined;

export interface StubApi {
  url: string;
  requests: RecordedRequest[];
  /** Contract violations seen. Assert this is empty — a 400 alone can be
   *  absorbed by a client that treats failure as "not yet". */
  violations: string[];
  /** Requests to a given pathname, in order. */
  to(pathname: string): RecordedRequest[];
  last(pathname: string): RecordedRequest | undefined;
  /** Queue a one-shot response for the next matching request. */
  once(pathname: string, response: { status?: number; json?: unknown }): void;
  /** Set the standing response for a pathname. */
  on(pathname: string, response: { status?: number; json?: unknown } | Responder): void;
  reset(): void;
  close(): Promise<void>;
}


/**
 * Map a request path to its contract entry, so outgoing bodies are validated
 * against the same `.strict()` schemas the server's ValidationPipe enforces.
 * Hand-written assertions can only check what the author thought to check; this
 * catches a surplus or misnamed field in every test, including ones not about it.
 */
function contractFor(method: string, pathname: string): EndpointName | undefined {
  for (const [name, spec] of Object.entries(ENDPOINTS)) {
    if (spec.method !== method) continue;
    const pattern = '^' + spec.path.replace(/:[^/]+/g, '[^/]+') + '$';
    if (new RegExp(pattern).test(pathname)) return name as EndpointName;
  }
  return undefined;
}

function contractViolation(method: string, pathname: string, body: unknown): string | null {
  const name = contractFor(method, pathname);
  if (!name) return null;
  const spec = ENDPOINTS[name];
  if (!spec.req) return null;
  const result = spec.req.safeParse(body);
  if (result.success) return null;
  return (
    `CONTRACT VIOLATION — invalid body sent to ${spec.method} ${spec.path}\n` +
    `  sent:   ${JSON.stringify(body)}\n` +
    `  errors: ${JSON.stringify(result.error.issues, null, 2)}`
  );
}

export async function startStubApi(): Promise<StubApi> {
  const requests: RecordedRequest[] = [];
  const violations: string[] = [];
  const standing = new Map<string, { status?: number; json?: unknown } | Responder>();
  const oneShots = new Map<string, Array<{ status?: number; json?: unknown }>>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const record: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        pathname: url.pathname,
        headers: req.headers as Record<string, string>,
        body,
      };
      requests.push(record);

      // Mirror the server: a body the contract rejects gets a 400, never a
      // hang. Throwing here would leave the socket open and surface as an
      // opaque AbortSignal timeout 8 seconds later.
      const violation = contractViolation(record.method, record.pathname, body);
      if (violation) {
        violations.push(violation);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: violation }));
        return;
      }

      const queued = oneShots.get(url.pathname);
      const handler = queued?.length ? queued.shift()! : standing.get(url.pathname);
      const resolved = typeof handler === 'function' ? handler(record) : handler;

      const status = resolved?.status ?? (handler ? 200 : 404);
      const payload = resolved?.json ?? (handler ? {} : { message: `no stub for ${url.pathname}` });

      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    violations,
    to: (pathname) => requests.filter((r) => r.pathname === pathname),
    last(pathname) {
      const all = this.to(pathname);
      return all[all.length - 1];
    },
    once(pathname, response) {
      const list = oneShots.get(pathname) ?? [];
      list.push(response);
      oneShots.set(pathname, list);
    },
    on(pathname, response) {
      standing.set(pathname, response);
    },
    reset() {
      requests.length = 0;
      violations.length = 0;
      standing.clear();
      oneShots.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── canonical fixtures, mirroring the real API ──────────────────────────────

export const PLANS = [
  { id: 'free', name: 'Free', price_monthly: 0, price_yearly: 0, max_queries_day: 100, max_chunks: 1000 },
  { id: 'starter', name: 'Starter', price_monthly: 29, price_yearly: 290, max_queries_day: 1000, max_chunks: 10000 },
  { id: 'pro', name: 'Pro', price_monthly: 97, price_yearly: 970, max_queries_day: 10000, max_chunks: 100000 },
  { id: 'enterprise', name: 'Enterprise', price_monthly: 297, price_yearly: 2970, max_queries_day: 50000, max_chunks: 1000000 },
];

export const CRYPTO_PLAN_OFFER = {
  subscriptionRef: '00000000-0000-4000-8000-000000000002',
  collector: '0x00000000000000000000000000000000000000b2',
  token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  amountPerPeriod: '97000000',
  cap: '1164000000',
  periodSeconds: 2592000,
  interval: 'monthly',
  chainId: 84532,
  server: 'https://api.v4.cryptocadet.app',
};

export const CRYPTO_TOPUP = {
  quote: {
    quoteId: 'quote_1',
    chainId: 84532,
    token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    recipient: '0x00000000000000000000000000000000000000a1',
    amount: '25000000',
    purpose: 'per_call',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    serverSig: 'c2ln',
  },
  server: 'https://api.v4.cryptocadet.app',
  recipient: '0x00000000000000000000000000000000000000a1',
  token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  amount: '25000000',
  chainId: 84532,
};

/** Wire up the happy path for every endpoint the CLI touches. */
export function seedHappyPath(api: StubApi): void {
  api.on('/api/v1/plans', { json: PLANS });
  api.on('/api/v1/plans/select', (req) => {
    const body = req.body as { planId?: string; method?: string } | undefined;
    if (body?.planId === 'free') return { json: { plan: PLANS[0], checkoutUrl: null } };
    if (body?.method === 'cryptocadet') {
      return { json: { plan: PLANS[2], checkoutUrl: null, cryptocadet: CRYPTO_PLAN_OFFER } };
    }
    return { json: { plan: PLANS[2], checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' } };
  });
  api.on('/api/v1/plans/verify-payment', { json: { plan: PLANS[2], paid: true } });
  api.on('/api/v1/plans/activate-crypto', {
    json: { registered: true, subscriptionId: 'ccsub_1', status: 'registered' },
  });
  api.on('/api/v1/balances/me', {
    json: {
      balanceUsdc: 42.5,
      creditLimitUsd: 10,
      alertThreshold: 5,
      withdrawable: 32.5,
      tipsEarned: { allTime: 3.21, last30Days: 0.44 },
    },
  });
  api.on('/api/v1/balances/topup', (req) => {
    const body = req.body as { method?: string } | undefined;
    if (body?.method === 'cryptocadet') {
      return { json: { method: 'cryptocadet', checkoutUrl: null, paymentId: 'pay_1', cryptocadet: CRYPTO_TOPUP } };
    }
    return {
      json: {
        method: 'stripe',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_2',
        paymentId: '00000000-0000-4000-8000-000000000001',
      },
    };
  });
  api.on('/api/v1/balances/verify-topup', { json: { balance: 67.5, completed: true } });
  api.on('/api/v1/balances/set-limit', { json: { creditLimit: 20 } });
  api.on('/api/v1/balances/set-alert', { json: { alertThreshold: 5 } });
  api.on('/api/v1/auth/refresh', { json: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
}
