const channelCount = Number(process.argv[2] ?? 129);
const capabilityId = process.argv[3] ?? 'fixture.secret.v1';
const channels = [];
let successes = 0;
let failures = 0;

process.on('message', (message, handle) => {
  if (message?.type !== 'protected_mcp_secret_channel_result') return;
  if (message.ok && handle) {
    successes += 1;
    channels.push(handle);
  } else {
    failures += 1;
    handle?.destroy?.();
  }
  if (successes + failures !== channelCount) return;
  process.stdout.write(`${JSON.stringify({ successes, failures })}\n`);
  for (const channel of channels) channel.destroy();
  process.disconnect?.();
});

for (let index = 0; index < channelCount; index += 1) {
  process.send({
    type: 'protected_mcp_secret_channel_request',
    requestId: String(index),
    capabilityId,
  });
}
