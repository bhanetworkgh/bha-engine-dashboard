/** The shared farm event rule (8 Nov 2026, Jason on the Logstream re-tune, 4DR6). Pure. `npm run test:logstream-farm-event`. */
const assert = require('node:assert/strict');
const path = require('node:path');
const l = require(path.join(process.env.DIST || 'server-dist', 'server/src/logstream.js'));

const FARM = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';
let n = 0;
const inc = (node, at) => ({ incident_id: `INC-${++n}`, lane_id: 'bays', workflow: 'Monitoring Twin', node, error_class: 'OFFLINE', severity: 'warning', occurred_at: at });
const burst = (device, times) => Array.from({ length: times }, (_, i) => inc(`${FARM} / ${device}`, `2026-11-0${i + 1}T10:00:00Z`));

// Six devices, each failing 5 times: a whole farm drop.
const many = ['pi_gateway_01', 'relay_module_01', 'relay_module_02', 'relay_module_03', 'led_light_01', 'drain_pump_01'].flatMap((d) => burst(d, 5));
const out = l.evaluate(many, []);
assert.equal(out.filter((c) => c.kind === 'signature_research' || c.kind === 'signature_escalation').length, 0, 'no per-device crossing survives');
const alert = out.find((c) => c.kind === 'farm_event_alert');
const research = out.find((c) => c.kind === 'farm_event_research');
assert.ok(alert && research, 'one alert and one research job for the farm');
assert.equal(out.filter((c) => c.kind.startsWith('farm_event')).length, 2);
assert.equal(alert.key, `farm:${FARM}`);
assert.equal(alert.n, 6);
assert.deepEqual(alert.merged.devices, ['drain_pump_01', 'led_light_01', 'pi_gateway_01', 'relay_module_01', 'relay_module_02', 'relay_module_03']);
assert.equal(alert.merged.research, 6);
assert.equal(alert.merged.alerts, 6);
assert.equal(alert.incident_ids.length, 30);

// Four devices: below the line, per-device crossings stay.
const few = ['pi_gateway_01', 'relay_module_01', 'relay_module_02', 'relay_module_03'].flatMap((d) => burst(d, 3));
const out2 = l.evaluate(few, []);
assert.equal(out2.filter((c) => c.kind === 'signature_research').length, 4);
assert.equal(out2.filter((c) => c.kind.startsWith('farm_event')).length, 0);

// Two farms: each judged on its own.
const other = ['a', 'b', 'c', 'd', 'e'].flatMap((d) => Array.from({ length: 3 }, (_, i) => inc(`farm-two / ${d}`, `2026-11-0${i + 1}T10:00:00Z`)));
const out3 = l.evaluate([...few, ...other], []);
assert.equal(out3.filter((c) => c.kind === 'farm_event_alert').length, 1, 'only farm-two has five devices');
assert.equal(out3.filter((c) => c.kind === 'signature_research').length, 4, "the first farm's four stay per device");

// Other workflows are never merged.
assert.equal(l.farmDevice({ workflow: 'Bays — Agent Delivery', node: 'x / y' }), null);
assert.deepEqual(l.farmDevice({ workflow: 'Monitoring Twin', node: `${FARM} / led_light_01` }), { farm_id: FARM, device: 'led_light_01' });

// The alert says what it stands for.
const msg = l.alertMessage(alert, 'LST-TEST');
assert.match(msg.text, /6 devices on farm .* one shared farm event/);
assert.match(JSON.stringify(msg.blocks), /instead of 6 device alerts and 6 device research jobs/);
console.log('logstream farm event: all checks passed');
