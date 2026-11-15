// update_slack_app's change logic (15 Nov 2026): applyChanges is pure, so it is pinned here with no Slack and no
// database. Run: SERVER_DIST=<compiled server> node server/test/slack-app-update.test.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = process.env.SERVER_DIST || path.join(__dirname, '..', '..', 'server-dist');
const { applyChanges } = require(path.join(dist, 'server', 'src', 'slackAppUpdate.js'));

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };

const genie = () => ({
  display_information: { name: 'Genie' },
  features: {
    bot_user: { display_name: 'Genie', always_online: false },
    slash_commands: [
      { command: '/askgenie', url: 'https://g.example/slack/commands', description: 'chats with genie' },
      { command: '/askgenieprivately', url: 'https://g.example/slack/commands', description: 'dm' },
    ],
  },
  oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'commands'] } },
  settings: { event_subscriptions: { request_url: 'https://g.example/slack/events', bot_events: ['app_mention', 'message.im'] }, interactivity: { is_enabled: true, request_url: 'https://g.example/slack/interactive' } },
});

check('removing both commands drops slash_commands and leaves everything else', () => {
  const before = genie();
  const r = applyChanges(before, { remove_commands: ['/askgenie', 'askgenieprivately'] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.manifest.features.slash_commands, undefined);
  assert.deepEqual(r.changes, [{ field: 'features.slash_commands', before: ['/askgenie', '/askgenieprivately'], after: [] }]);
  assert.equal(r.manifest.settings.event_subscriptions.request_url, 'https://g.example/slack/events');
  assert.equal(before.features.slash_commands.length, 2, 'the input is not changed');
});

check('a command the app does not have is named, not ignored', () => {
  const r = applyChanges(genie(), { remove_commands: ['/nope'] });
  assert.match(r.problems.join(), /\/nope is not a command of this app/);
});

check('display limits are Slack\'s', () => {
  assert.match(applyChanges(genie(), { display: { description: 'x'.repeat(141) } }).problems.join(), /at most 140/);
  assert.match(applyChanges(genie(), { display: { long_description: 'short' } }).problems.join(), /175 to 4,000/);
  assert.match(applyChanges(genie(), { display: { background_color: 'green' } }).problems.join(), /hex colour/);
  const ok = applyChanges(genie(), { display: { description: 'The orchestrator', background_color: '#1D2E1C' } });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.changes.length, 2);
});

check('agent mode, home tab and scopes', () => {
  const r = applyChanges(genie(), {
    home_tab: true,
    assistant: { description: 'Ask Genie anything about the engine', suggested_prompts: [{ title: 'Status', message: 'How is the engine?' }] },
    bot_scopes_add: ['assistant:write', 'chat:write'],
    bot_scopes_remove: ['commands'],
    bot_events_add: ['assistant_thread_started', 'app_home_opened'],
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.manifest.features.app_home.home_tab_enabled, true);
  assert.equal(r.manifest.features.assistant_view.assistant_description, 'Ask Genie anything about the engine');
  assert.deepEqual(r.manifest.oauth_config.scopes.bot, ['app_mentions:read', 'chat:write', 'assistant:write']);
  assert.deepEqual(r.manifest.settings.event_subscriptions.bot_events, ['app_mention', 'message.im', 'assistant_thread_started', 'app_home_opened']);
});

check('asking for what is already held is no change', () => {
  const r = applyChanges(genie(), { bot_display_name: 'Genie' });
  assert.deepEqual(r.changes, []);
});

check('a request URL must be https', () => {
  assert.match(applyChanges(genie(), { event_url: 'http://x/slack/events' }).problems.join(), /https URL/);
});

console.log(`\n${n} checks passed`);
