// Test stand-in for cocoa-node.mjs: answers like a node, and records whether the
// host ever sent it two operations at once and which email it registered with.
let active = 0, maxActive = 0;
process.on('message', ({ id, action, body }) => {
  active++; maxActive = Math.max(maxActive, active);
  setTimeout(() => {
    active--;
    if (action === 'ensure') process.send({ id, result: { nodeId: 'node-shared', nodeApiKey: 'rdk_live_fake', email: body.email } });
    else process.send({ id, result: { published: 0, projectId: body.projectId, maxActive } });
  }, 80);
});
process.on('disconnect', () => process.exit(0));
