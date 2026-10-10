/**
 * A stand-in for OpenRouter's balance read (GET /credits), for every test that
 * opens a research job: the research-signal guard reads the balance first and
 * opens nothing when it cannot. `set()` changes what it answers.
 */
const http = require('node:http');

async function startCredit() {
  const state = { remaining: 500, status: 200, hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits++;
    res.writeHead(state.status, { 'content-type': 'application/json' });
    if (state.status !== 200) return res.end(JSON.stringify({ error: { message: 'stand-in refusal' } }));
    res.end(JSON.stringify({ data: { total_credits: 1000, total_usage: 1000 - state.remaining } }));
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  process.env.OPENROUTER_API_URL = `http://127.0.0.1:${port}`;
  process.env.OPENROUTER_API_KEY = 'sk-test';
  return { state, set: (o) => Object.assign(state, o), close: () => server.close() };
}

module.exports = { startCredit };
