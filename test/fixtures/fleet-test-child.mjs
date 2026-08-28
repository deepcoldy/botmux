// Test child for the fleet supervisor integration test. Behavior via env:
//   FLEET_TEST_MODE=stay    → run forever (default)
//   FLEET_TEST_MODE=graceful→ exit 90 immediately (clean shutdown sentinel)
//   FLEET_TEST_MODE=crash   → exit 1 immediately (crash → should restart)
// Prints its pid so the test can target it.
const mode = process.env.FLEET_TEST_MODE || 'stay';
console.log('fleet-test-child pid=' + process.pid + ' mode=' + mode + ' botIndex=' + process.env.BOTMUX_BOT_INDEX);
if (mode === 'graceful') process.exit(90);
if (mode === 'crash') process.exit(1);
// stay: keep alive; respond to SIGTERM by exiting 90 (like a graceful daemon)
process.on('SIGTERM', () => process.exit(90));
setInterval(() => {}, 1000);
