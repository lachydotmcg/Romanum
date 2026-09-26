import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { migrateHistory } from '../src/lib/history/migrate.ts';
import { grantCredits, getBalance } from '../src/lib/credits/ledger.ts';
import { createCreativeProject, transactionDatabase } from '../src/lib/creative/storage.ts';
import { createCreativeWorkflow, saveCreativeConcepts, queueCreativeJob, executeCreativeJob, cancelCreativeJob, approveCreativeConcept, readCreativeJob } from '../src/lib/creative/workflow.ts';
import { ImageProviderError } from '../src/lib/creative/image-provider.ts';

// Local-only, separate database, fixed test provider. Never imports an OpenAI
// adapter, reads API credentials, or exposes these controls through Next routes.
// The one-pixel fixture exercises asset storage but is never served as artwork.
const fixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
const ownerId = 'creation-lab';
const provider = (fail = false) => ({ id: 'local-dry-run', model: 'fixture', mode: 'test', available: true,
  async generate() { if (fail) throw new ImageProviderError('rejected'); return { bytes: fixture, mimeType: 'image/png' }; },
});
const uuid = z.uuid();
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('queue'), jobId: uuid, game: z.string().trim().min(1).max(100), gameplay: z.string().trim().min(1).max(2000), prompt: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('final'), jobId: uuid, conceptJobId: uuid }).strict(),
  z.object({ action: z.enum(['complete', 'fail', 'cancel']), jobId: uuid }).strict(),
  z.object({ action: z.literal('topup'), operationId: uuid }).strict(),
]);

export async function createLab(dataDir) {
  const pg = new PGlite(dataDir);
  const sql = client => ({ query: (q, values) => client.query(q, values), exec: async q => { await client.exec(q); } });
  const db = { ...sql(pg), transaction: fn => pg.transaction(tx => fn(sql(tx))), close: () => pg.close() };
  try {
    await migrateHistory(db);
    await grantCredits(db, { ownerId, operationId: 'lab-initial-grant-v1', amount: 20 });
  } catch (error) { await db.close(); throw error; }
  async function snapshot() {
    const balance = await getBalance(db, { ownerId });
    const { rows: jobs } = await db.query(`SELECT j.id,j.stage,j.status,j.quoted_credits,j.created_at,p.name AS game,
      EXISTS(SELECT 1 FROM creative_jobs f WHERE f.workflow_id=j.workflow_id AND f.stage='final' AND f.status IN ('queued','running','succeeded','uncertain')) AS has_final
      FROM creative_jobs j JOIN creative_projects p ON p.id=j.project_id WHERE j.owner_id=$1 ORDER BY j.created_at DESC,j.id LIMIT 60`, [ownerId]);
    const { rows: ledger } = await db.query('SELECT id,entry_type,amount,balance_after,reserved_after,created_at FROM credits_ledger WHERE owner_id=$1 ORDER BY id DESC LIMIT 60', [ownerId]);
    return { mode: 'dry-run', balance, jobs, ledger };
  }
  async function act(raw) {
    const input = actionSchema.parse(raw);
    if (input.action === 'topup') await grantCredits(db, { ownerId, operationId: input.operationId, amount: 20 });
    else if (input.action === 'queue') await db.transaction(async sql => {
      const tx = transactionDatabase(sql);
      const project = await createCreativeProject(tx, { ownerId, name: input.game, context: { game: input.game, gameplay: input.gameplay, audience: 'Not specified', artDirection: input.prompt } });
      const flow = await createCreativeWorkflow(tx, { ownerId, projectId: project.id, kind: 'thumbnail', creditBudget: 10,
        brief: { goal: 'Thumbnail concept', truthfulContent: input.gameplay, visualDirection: input.prompt } });
      await saveCreativeConcepts(tx, ownerId, flow.id, [{ key: 'concept', title: 'Thumbnail concept', hypothesis: 'Creator-provided concept for workflow testing.', prompt: input.prompt }]);
      await queueCreativeJob(tx, provider(), { ownerId, workflowId: flow.id, jobId: input.jobId, conceptKey: 'concept', stage: 'concept' });
    });
    else if (input.action === 'final') await db.transaction(async sql => {
      const tx = transactionDatabase(sql);
      const concept = await readCreativeJob(tx, ownerId, input.conceptJobId);
      await approveCreativeConcept(tx, { ownerId, workflowId: concept.workflow_id, jobId: concept.id, reviewer: 'owner', reason: 'Explicit dry-run approval; no generated artwork reviewed.' });
      await queueCreativeJob(tx, provider(), { ownerId, workflowId: concept.workflow_id, jobId: input.jobId, conceptKey: concept.concept_key, stage: 'final' });
    });
    else if (input.action === 'cancel') await cancelCreativeJob(db, ownerId, input.jobId);
    else await executeCreativeJob(db, provider(input.action === 'fail'), ownerId, input.jobId);
    return snapshot();
  }
  // Serialize local requests so the embedded connection never exposes another
  // request's in-progress transaction. A failed action does not block the queue.
  let pending = Promise.resolve();
  const enqueue = fn => { const result = pending.then(fn); pending = result.catch(() => {}); return result; };
  return { snapshot: () => enqueue(snapshot), act: input => enqueue(() => act(input)), close: async () => { await pending; await db.close(); } };
}

export async function startLab({ port = 3100, dataDir } = {}) {
  const html = await readFile(new URL('./creation-lab/index.html', import.meta.url), 'utf8');
  const lab = await createLab(dataDir);
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(24).toString('base64');
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Local access only.' });
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html.replaceAll('__NONCE__', nonce).replace('__TOKEN__', token));
    }
    if (req.headers['x-lab-token'] !== token) return send(403, { error: 'Reload the testing screen.' });
    try {
      if (req.method === 'GET' && req.url === '/state') return send(200, await lab.snapshot());
      if (req.method !== 'POST' || req.url !== '/action') return send(404, { error: 'Not found.' });
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Request rejected.' });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) return send(413, { error: 'Request too large.' }); chunks.push(chunk); }
      return send(200, await lab.act(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    } catch (error) {
      const messages = { insufficient_balance: 'Add test credits first.', approval_required: 'Complete the concept first.', budget_exceeded: 'Workflow budget reached.', conflict: 'That job has already changed.', not_found: 'Job not found.', '23505': 'That request was already submitted.' };
      return send(400, { error: messages[error?.code] ?? 'Could not run this action. Check the fields and refresh.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
    origin = `http://127.0.0.1:${server.address().port}`;
  } catch (error) { await lab.close(); throw error; }
  return { url: origin, close: async () => { await new Promise((done, fail) => server.close(e => e ? fail(e) : done())); await lab.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await mkdir('.local/creation-lab', { recursive: true });
  try {
    const app = await startLab({ dataDir: '.local/creation-lab/db' });
    console.log(`Romanum creation lab: ${app.url}\nDry-run only. No API charges. Ctrl+C to stop.`);
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
  } catch { console.error('Could not start the creation lab. Check port 3100 and whether another lab is running.'); process.exitCode = 1; }
}
