// Who may publish into a host's nodes. A host serves exactly one publisher,
// chosen by RDK_HOST_PUBLISHER, and runs its own instance (secret, master key,
// data directory, capacity), so one product's load or a leaked secret never
// reaches another product's tenants.
//   subzero: SubZero's Cocoa. Managed agent tokens, numeric project ids.
//   koryo:   Koryo's Kaia. Publisher-only credentials, workspace uuids.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PUBLISHERS = {
  subzero: {
    label: 'Cocoa',
    source: 'subzero',
    token: /^sz_agent_[a-f0-9]{64}$/,
    id: (v) => Number.isSafeInteger(v) && v >= 1,
  },
  koryo: {
    label: 'Kaia',
    source: 'koryo',
    token: /^kor_pub_[A-Za-z0-9_-]{43}$/,
    id: (v) => typeof v === 'string' && UUID.test(v),
  },
};

export function publisherFor(name = 'subzero') {
  const p = PUBLISHERS[name];
  if (!p) throw new Error(`Unknown RDK_HOST_PUBLISHER "${name}": use ${Object.keys(PUBLISHERS).join(' or ')}`);
  return p;
}

/** A /sync body must name this host's own API, a credential of its shape, and an id of its kind. */
export function validSync(publisher, apiUrl, body) {
  return body.apiUrl === apiUrl && typeof body.token === 'string' && publisher.token.test(body.token) && publisher.id(body.projectId);
}
