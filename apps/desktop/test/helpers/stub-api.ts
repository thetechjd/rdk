import { ENDPOINTS, type EndpointName } from '@retrodeck/payments-contract';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A real HTTP server standing in for the RetroDeck API.
 *
 * The desktop tests exercise `node-service.ts` through the REAL
 * `@rdk/node/retrodeck-client`, so the wiring between them is under test rather
 * than mocked away. That client uses `fetch` with `AbortSignal.timeout` and
 * re-issues a second real request on 401, which a function mock cannot model.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  pathname: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; json?: unknown };
type Responder = (req: RecordedRequest) => Reply | undefined;

export interface StubApi {
  url: string;
  requests: RecordedRequest[];
  /** Contract violations seen. Assert this is empty — a 400 alone can be
   *  absorbed by a client that treats failure as "not yet". */
  violations: string[];
  to(pathname: string): RecordedRequest[];
  last(pathname: string): RecordedRequest | undefined;
  once(pathname: string, reply: Reply): void;
  on(pathname: string, reply: Reply | Responder): void;
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
  const standing = new Map<string, Reply | Responder>();
  const oneShots = new Map<string, Reply[]>();

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

      res.writeHead(resolved?.status ?? (handler ? 200 : 404), {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(resolved?.json ?? (handler ? {} : { message: 'no stub' })));
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
    once(pathname, reply) {
      const list = oneShots.get(pathname) ?? [];
      list.push(reply);
      oneShots.set(pathname, list);
    },
    on(pathname, reply) {
      standing.set(pathname, reply);
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

export const PLANS = [
  { id: 'free', name: 'Free', price_monthly: 0, max_queries_day: 100, max_chunks: 1000 },
  { id: 'starter', name: 'Starter', price_monthly: 29, max_queries_day: 1000, max_chunks: 10000 },
  { id: 'pro', name: 'Pro', price_monthly: 97, max_queries_day: 10000, max_chunks: 100000 },
];

export const STRIPE_CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_test_1';
/** Crypto on the desktop is a HOSTED page — there is no local wallet. */
export const CRYPTO_SUBSCRIBE_PAGE =
  'https://dashboard.retrodeck.ai/dashboard/billing/subscribe/cryptocadet?ref=ccsub_1';
export const CRYPTO_TOPUP_PAGE =
  'https://dashboard.retrodeck.ai/dashboard/billing/cryptocadet?ref=pay_1';

export function seedHappyPath(api: StubApi): void {
  api.on('/api/v1/plans', { json: PLANS });
  api.on('/api/v1/plans/select', (req) => {
    const body = req.body as { planId?: string; method?: string } | undefined;
    if (body?.planId === 'free') return { json: { plan: PLANS[0], checkoutUrl: null } };
    if (body?.method === 'cryptocadet') {
      return { json: { plan: PLANS[2], checkoutUrl: CRYPTO_SUBSCRIBE_PAGE } };
    }
    return { json: { plan: PLANS[2], checkoutUrl: STRIPE_CHECKOUT } };
  });
  api.on('/api/v1/plans/verify-payment', { json: { plan: PLANS[2], paid: true } });
  api.on('/api/v1/balances/me', { json: { balanceUsdc: 42.5, creditLimitUsd: 10, withdrawable: 32.5 } });
  api.on('/api/v1/balances/topup', (req) => {
    const body = req.body as { method?: string } | undefined;
    return {
      json: {
        method: body?.method ?? 'stripe',
        checkoutUrl: body?.method === 'cryptocadet' ? CRYPTO_TOPUP_PAGE : STRIPE_CHECKOUT,
        paymentId: '00000000-0000-4000-8000-000000000001',
      },
    };
  });
  api.on('/api/v1/balances/verify-topup', { json: { balance: 67.5, completed: true } });
  // users/me wraps the user in an envelope — `getMe()` reads `data.user`.
  api.on('/api/v1/users/me', {
    json: {
      user: { id: 'u1', email: 'user@example.test', emailVerified: true, planId: 'pro' },
      plan: { id: 'pro', name: 'Pro', price_monthly: 97, max_queries_day: 10000, max_chunks: 100000 },
    },
  });
  api.on('/api/v1/auth/refresh', { json: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
}
