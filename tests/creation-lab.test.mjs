import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createLab, startLab } from '../scripts/creation-lab.mjs';

const queue = () => ({ action: 'queue', jobId: randomUUID(), game: 'Seed garden', gameplay: 'Plant and harvest seeds', prompt: 'A seedling in a terracotta pot' });
test('local lab drives the real reservation, review, final and settlement services without a provider request', async t => {
  const lab = await createLab(); t.after(() => lab.close());
  const network = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Dry-run must not call a network provider');
  t.after(() => { globalThis.fetch = network; });
  assert.equal((await lab.snapshot()).balance.available, 20);
  const concept = queue();
  let state = await lab.act(concept);
  assert.equal(state.balance.available, 19); assert.equal(state.balance.reserved, 1); assert.equal(state.balance.balance, 20);
  await assert.rejects(lab.act({ action: 'final', jobId: randomUUID(), conceptJobId: concept.jobId }), e => e.code === 'approval_required');
  state = await lab.act({ action: 'complete', jobId: concept.jobId });
  assert.equal(state.balance.balance, 19); assert.equal(state.balance.reserved, 0);
  await lab.act({ action: 'complete', jobId: concept.jobId });
  assert.equal((await lab.snapshot()).balance.balance, 19);
  const finalId = randomUUID();
  state = await lab.act({ action: 'final', jobId: finalId, conceptJobId: concept.jobId });
  assert.equal(state.balance.available, 17); assert.equal(state.balance.reserved, 2);
  state = await lab.act({ action: 'complete', jobId: finalId });
  assert.equal(state.balance.balance, 17); assert.equal(state.jobs.filter(j => j.status === 'succeeded').length, 2);
  assert.equal(state.ledger.filter(e => e.entry_type === 'capture').length, 2);
  assert.ok(!JSON.stringify(state).includes('base64'));
  const add = { action: 'topup', operationId: randomUUID() };
  await lab.act(add); state = await lab.act(add);
  assert.equal(state.balance.balance, 37);
});

test('cancel/failure return holds, malformed inputs fail, and failed requests leave the lab usable', async t => {
  const lab = await createLab(); t.after(() => lab.close());
  for (const action of ['cancel', 'fail']) {
    const input = queue(); await lab.act(input);
    const state = await lab.act({ action, jobId: input.jobId });
    assert.equal(state.balance.available, 20); assert.equal(state.balance.reserved, 0);
    assert.equal(state.jobs.find(j => j.id === input.jobId).status, action === 'fail' ? 'failed' : 'cancelled');
  }
  await assert.rejects(lab.act({ ...queue(), apiKey: 'not-accepted' }));
  await assert.rejects(lab.act({ action: 'complete', jobId: randomUUID() }), e => e.code === 'not_found');
  const input = queue(); await lab.act(input);
  await assert.rejects(lab.act(input));
  assert.equal((await lab.snapshot()).jobs.length, 3);
  assert.equal((await lab.snapshot()).balance.reserved, 1);
});

test('isolated lab data survives restarts without granting another initial balance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'romanum-lab-'));
  let lab;
  try {
    lab = await createLab(directory);
    const input = queue(); await lab.act(input);
    await lab.close(); lab = undefined;
    lab = await createLab(directory);
    const state = await lab.snapshot();
    assert.equal(state.balance.balance, 20); assert.equal(state.balance.reserved, 1);
    assert.equal(state.jobs[0].id, input.jobId); assert.equal(state.ledger.filter(e => e.entry_type === 'grant').length, 1);
    await lab.act({ action: 'cancel', jobId: input.jobId });
  } finally { if (lab) await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP lab binds loopback and enforces host, origin, CSRF token, body bounds and strict inputs', async t => {
  const app = await startLab({ port: 0 }); t.after(() => app.close());
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:/);
  const page = await fetch(app.url);
  const html = await page.text();
  assert.match(html, /No images generated or API charges/);
  assert.ok(page.headers.get('content-security-policy').includes("default-src 'none'"));
  const token = html.match(/const token = '([a-f0-9]+)'/)[1];
  assert.equal((await fetch(app.url + '/state')).status, 403);
  const wrongHost = await new Promise((done, fail) => {
    const req = request(app.url + '/state', { headers: { 'x-lab-token': token, host: 'evil.invalid' } }, res => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.on('error', fail); req.end();
  });
  assert.equal(wrongHost, 403);
  const headers = { 'x-lab-token': token, 'content-type': 'application/json', origin: app.url };
  const send = (body, extra = {}) => fetch(app.url + '/action', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await send(queue(), { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await send(queue(), { 'x-lab-token': 'wrong' })).status, 403);
  assert.equal((await send({ action: 'topup', operationId: randomUUID(), amount: 99999 })).status, 400);
  assert.equal((await send({ value: 'x'.repeat(17000) })).status, 413);
  const result = await send(queue()); assert.equal(result.status, 200);
  assert.equal((await result.json()).balance.reserved, 1);
  assert.equal((await fetch(app.url + '/asset', { headers: { 'x-lab-token': token } })).status, 404);
});
