import test from 'node:test';
import assert from 'node:assert/strict';
import { failureReason } from './node-errors.mjs';
test('Node failures become short codes, never their message',()=> {
  const cases = [
    ['Chunk 0: `local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at "/var/lib/kaia/models/Xenova/all-MiniLM-L6-v2/tokenizer.json".', 'embedding_model_missing'],
    ['Fatal: Index rate limit exceeded for node local', 'rate_limited'],
    ['Shared node registration failed: HTTP 401', 'registration_http_401'],
    ['Support publication HTTP 409: {"error":"revision already claimed, or not queued"}', 'publisher_http_409'],
    ['Support job targets a different node or unsafe visibility', 'claim_rejected'],
    ['RDK metadata sync failed', 'metadata_sync_failed'],
    ['Central pinDocument: 402 Payment Required', 'pin_failed'],
    ['fetch failed', 'network'],
    ['Unexpected token } in JSON at position 3', 'invalid_json'],
    ['something secret: sk-live-abc', 'unknown'],
  ];
  for (const [message, reason] of cases) assert.equal(failureReason(new Error(message)), reason, message);
  assert.equal(failureReason(undefined), 'unknown');
});
