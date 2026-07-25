# Reconcile a node whose `rdk status` count exceeds the dashboard

Symptom: `rdk status` / the desktop status bar report more chunks (e.g. 74) than
the web dashboard shows (e.g. 34). The local index believes chunks are synced
that RDK Central no longer stores — private chunks hard-deleted during re-index,
or chunks stranded under a duplicate node after a re-`init`.

This is repaired with the reconcile path added in Fix 1 + the live-only counting
from Fix 3. Run it on the machine that owns the node (the one whose vault this
is — for this account, the iMac).

## Steps (on the node's machine)

1. **Update RDK** to a build containing these fixes (so `--verify` and honest
   sync marking exist). Then:

2. **Reconcile local sync state against the network:**
   ```
   rdk vault:sync --verify
   ```
   This asks Central which of the locally-"synced" chunks it still actually has,
   re-queues the ones it doesn't, and pushes them. Superseded (edited-away)
   chunks are intentionally left out — they should not be resurrected.

3. **Check the numbers reconcile:**
   ```
   rdk vault:status      # private/public are now LIVE chunks only
   rdk status
   ```
   - If the extra chunks were **superseded ghosts**, the local total drops to the
     live count and now matches the dashboard — nothing was re-uploaded.
   - If they were **genuinely missing on Central**, they re-upload under the
     current node; the dashboard total rises to match once it aggregates across
     the account's nodes (Fix 2).

4. **(Optional) Force a full re-push** if you want every live chunk re-sent:
   ```
   rdk vault:sync --force
   ```

## Why the dashboard still shows two nodes' worth (this account)

The 34 existing chunks are owned by an older node id; re-pushed/missing chunks
land under the current node id. The dashboard sums across **all** of the
account's nodes (Fix 2), so the total is correct even while ownership is split.
Fix 5 (idempotent registration) stops *new* duplicate nodes from forming.

## (Optional, admin) Consolidate existing duplicate nodes on Central

Only if you want all rows under a single node id. On the Central DB, reassign the
old node's rows to the current node (same account, so tip/earnings attribution is
unaffected):
```sql
-- Verify first:
SELECT node_id, count(*) FROM chunks
WHERE node_id IN (SELECT id FROM nodes WHERE retrodeck_user_id = '<USER_ID>')
GROUP BY node_id;

-- Then consolidate onto the current node:
UPDATE chunks SET node_id = '<CURRENT_NODE_ID>'
WHERE node_id = '<OLD_NODE_ID>';
```
