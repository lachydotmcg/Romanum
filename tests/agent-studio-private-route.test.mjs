import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { privateStudioResponse, studioPageContext, STUDIO_WORKFLOW_ENABLED } from '../src/lib/agent-api-studio-workflow/private-route.ts';
import { createCreativeProject } from '../src/lib/creative/storage.ts';
import { closeAccount } from '../src/lib/accounts/closure.ts';
import { workflowFixture, reviewedWorkflow } from '../scripts/fixtures/agent-studio-workflow.mjs';

const origin = 'https://romanum.test';
async function setup(t) {
  const fixture = await workflowFixture();
  t.after(() => fixture.close());
  let account = { ownerId: fixture.ownerId }, resolutions = 0;
  const deps = { enabled:true, account:async()=>account, database:async()=>fixture.database, origin:()=>origin, workflow:async owner=>{ resolutions++; return owner===fixture.ownerId?fixture.workflow:null; } };
  const request = async (operation, fields={}, headers={}) => privateStudioResponse(new Request(`${origin}/api/agent-studio/${fixture.project.id}`, { method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json',...headers }, body:JSON.stringify({ operation,key:`route:${operation}`,projectId:fixture.project.id,...fields }) }),deps,fixture.project.id);
  const get = (projectId=fixture.project.id, query='') => privateStudioResponse(new Request(`${origin}/api/agent-studio/${projectId}${query}`),deps,projectId);
  return { ...fixture,deps,request,get,setSession:value=>{ account=value; },resolutions:()=>resolutions };
}
const writes = fixture => fixture.transport.toolCalls.filter(call=>call.params.name==='multi_edit').length;
async function until(predicate) { for(let n=0;n<200;n++) { if(await predicate()) return; await new Promise(resolve=>setTimeout(resolve,5)); } assert.fail('Authored fixture checkpoint missing.'); }

test('private gate defaults disabled and never resolves storage or a Studio workflow',async()=>{
  assert.equal(STUDIO_WORKFLOW_ENABLED,false);
  let auth=0;
  const deps={account:async()=>{auth++;return{ownerId:'fixture-owner'};},database:async()=>{assert.fail('Disabled route opened storage.');},workflow:async()=>{assert.fail('Disabled route opened Studio.');},origin:()=>origin};
  const response=await privateStudioResponse(new Request(`${origin}/api/agent-studio/${randomUUID()}`),deps,randomUUID());
  assert.equal(response.status,503); assert.equal(auth,1);
  assert.equal(response.headers.get('Cache-Control'),'no-store'); assert.equal(response.headers.get('Vary'),'Cookie');
  deps.account=async()=>null;
  assert.equal((await privateStudioResponse(new Request(origin),deps,randomUUID())).status,401);
});

test('mutation requires exact Origin and rejects cross-site before auth or dispatch',async t=>{
  const fixture=await setup(t);
  for(const headers of [{Origin:''},{Origin:'https://foreign.test'},{'Sec-Fetch-Site':'cross-site'}]) assert.equal((await fixture.request('select',{studioId:'studio-b'},headers)).status,403);
  assert.equal(fixture.resolutions(),0); assert.equal(writes(fixture),0);
  assert.equal((await fixture.request('select',{studioId:'studio-b'})).status,200);
});

test('path ownership and payload project scope reject foreign reads, actions and injections',async t=>{
  const fixture=await setup(t);
  const foreign=await createCreativeProject(fixture.database,{ownerId:'foreign-fixture-owner',name:'Foreign authored project',context:{game:'Foreign authored project'}});
  assert.equal((await fixture.get(foreign.id)).status,404); assert.equal(fixture.resolutions(),0);
  assert.equal((await fixture.request('select',{studioId:'studio-b',projectId:foreign.id})).status,400);
  assert.equal((await fixture.get(fixture.project.id,`?projectId=${foreign.id}`)).status,400);
  assert.equal((await fixture.request('select',{studioId:'studio-b',ownerId:'foreign-fixture-owner'})).status,400);
  fixture.setSession({ownerId:'foreign-fixture-owner'});
  for(const operation of ['review','execute','cancel','recover']) assert.equal((await fixture.request(operation,{actionId:randomUUID()})).status,404);
  assert.equal((await fixture.get()).status,404); assert.equal(writes(fixture),0);
  fixture.setSession(null); assert.equal((await fixture.get()).status,401);
});

test('private page uses signed-in ownership and defaults to the disabled notice',async t=>{
  const fixture=await setup(t);
  const owned=await studioPageContext({...fixture.deps,enabled:undefined},fixture.project.id);
  assert.equal(owned.state,'disabled'); assert.equal(owned.project.id,fixture.project.id);
  assert.equal((await studioPageContext(fixture.deps,'malformed')).state,'not_found');
  fixture.setSession({ownerId:'foreign-fixture-owner'}); assert.equal((await studioPageContext(fixture.deps,fixture.project.id)).state,'not_found');
  fixture.setSession(null); assert.equal((await studioPageContext(fixture.deps,fixture.project.id)).state,'sign_in');
});

test('reload reads do not repeat approval or execution and SQL alone decides expired lease recovery',async t=>{
  const fixture=await setup(t);
  const {actionId,proposed}=await reviewedWorkflow(fixture);
  const fields={actionId,digest:proposed.body.result.digest,approve:true};
  const approved=await fixture.request('review',fields); assert.equal(approved.status,409); // Existing review, different receipt cannot renew it.
  fixture.transport.hold.add('multi_edit');
  const executing=fixture.request('execute',{actionId});
  await until(()=>writes(fixture)===1);
  for(let n=0;n<3;n++) {
    const snapshot=await(await fixture.get()).json();
    const action=snapshot.checkpoint.actions.find(item=>item.actionId===actionId);
    assert.equal(action.status,'running'); assert.equal(action.recoverable,false); assert.ok(action.leaseExpiresAt);
  }
  await fixture.database.query("UPDATE studio_workflow_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[actionId]);
  assert.equal((await(await fixture.get()).json()).checkpoint.actions[0].recoverable,false);
  await fixture.database.query("UPDATE studio_workflow_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[actionId]);
  assert.equal((await(await fixture.get()).json()).checkpoint.actions[0].recoverable,true);
  const recovered=await fixture.request('recover',{actionId}); assert.equal((await recovered.json()).result.status,'uncertain');
  assert.equal((await(await executing).json()).result.status,'uncertain');
  assert.equal((await(await fixture.request('execute',{actionId})).json()).result.status,'uncertain');
  assert.equal(writes(fixture),1);
});

test('unresolved write remains visible past32 newer reads and durable status survives disconnect',async t=>{
  const fixture=await setup(t);
  const {actionId,selected}=await reviewedWorkflow(fixture);
  for(let n=0;n<34;n++) assert.equal((await fixture.send('inspect',{selectionId:selected.body.result.selectionId},`extra-inspect:${n}`)).status,200);
  const visible=await(await fixture.get()).json();
  assert.equal(visible.checkpoint.actions.length,32); assert.equal(visible.checkpoint.actions[0].actionId,actionId);
  fixture.transport.close();
  const response=await fixture.get(); assert.equal(response.status,200);
  const saved=await response.json(); assert.equal(saved.connectionAvailable,false); assert.equal(saved.checkpoint.selection,null);
  assert.equal(saved.checkpoint.actions[0].actionId,actionId); assert.equal(saved.discovery.sessions.length,0);
  const cancelled=await fixture.request('cancel',{actionId}); assert.equal((await cancelled.json()).result.status,'cancelled'); assert.equal(writes(fixture),0);
});

test('interrupted inspection exposes recovery and can be cancelled without replay',async t=>{
  const fixture=await setup(t);
  const selected=await fixture.send('select',{studioId:'studio-b'});
  fixture.transport.hold.add('get_studio_state');
  const inspecting=fixture.send('inspect',{selectionId:selected.body.result.selectionId});
  await until(()=>fixture.transport.toolCalls.some(call=>call.params.name==='get_studio_state'));
  const action=(await(await fixture.get()).json()).checkpoint.actions[0];
  assert.equal(action.proposal.effect,'read'); assert.equal(action.status,'running');
  await fixture.database.query("UPDATE studio_workflow_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[action.actionId]);
  assert.equal((await(await fixture.get()).json()).checkpoint.actions[0].recoverable,true);
  const cancelled=await fixture.request('cancel',{actionId:action.actionId}); assert.equal((await cancelled.json()).result.status,'cancelled');
  assert.equal((await inspecting).body.result.status,'cancelled');
  assert.equal(fixture.transport.toolCalls.filter(call=>call.params.name==='get_studio_state').length,1);
});

test('closure preserves pending Studio evidence atomically; cancelled work then cascades normally',async t=>{
  const fixture=await setup(t); const accountId=randomUUID();
  await fixture.database.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name) VALUES($1,771001,$2,'authored','Authored account')",[accountId,fixture.ownerId]);
  const {actionId}=await reviewedWorkflow(fixture);
  await assert.rejects(closeAccount(fixture.database,{id:accountId,ownerId:fixture.ownerId}),error=>error.code==='55000');
  assert.equal((await fixture.database.query('SELECT id FROM accounts WHERE id=$1',[accountId])).rows.length,1);
  assert.equal((await fixture.workflow.read(fixture.project.id,actionId)).status,'approved');
  await fixture.send('cancel',{actionId});
  await closeAccount(fixture.database,{id:accountId,ownerId:fixture.ownerId});
  for(const table of ['studio_workflow_selections','studio_workflow_actions','studio_workflow_requests']) assert.equal((await fixture.database.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
  assert.equal((await fixture.send('select',{studioId:'studio-b'},'stale-after-closure')).status,404);
});

test('closed-owner guard rejects stale Studio row updates and service mutations',async t=>{
  const fixture=await setup(t); const {actionId}=await reviewedWorkflow(fixture);
  await fixture.database.query('INSERT INTO account_closures(owner_id,account_id) VALUES($1,$2)',[fixture.ownerId,randomUUID()]);
  await assert.rejects(fixture.database.query('UPDATE studio_workflow_actions SET error_code=$2 WHERE id=$1',[actionId,'stale']),error=>error.code==='55000');
  assert.equal((await fixture.send('cancel',{actionId})).status,404); assert.equal(writes(fixture),0);
});

test('transactional rollback refuses unresolved actions, removes only isolated schema and permits reapplication',async t=>{
  const fixture=await setup(t); const {actionId}=await reviewedWorkflow(fixture);
  const rollback=await readFile(new URL('../src/lib/agent-api-studio-workflow/rollback.sql',import.meta.url),'utf8');
  await assert.rejects(fixture.database.transaction(sql=>sql.exec(rollback)),error=>error.code==='55000');
  assert.equal((await fixture.workflow.read(fixture.project.id,actionId)).status,'approved');
  await fixture.send('cancel',{actionId});
  await fixture.database.transaction(sql=>sql.exec(rollback));
  assert.equal((await fixture.database.query("SELECT to_regclass('studio_workflow_actions') AS table")).rows[0].table,null);
  assert.equal((await fixture.database.query('SELECT id FROM creative_projects WHERE id=$1',[fixture.project.id])).rows.length,1);
  assert.ok((await fixture.database.query("SELECT to_regprocedure('romanum_reject_closed_owner()') AS function")).rows[0].function);
  const schema=await readFile(new URL('../src/lib/agent-api-studio-workflow/schema.sql',import.meta.url),'utf8');
  await fixture.database.transaction(sql=>sql.exec(schema));
  assert.equal((await fixture.send('select',{studioId:'studio-b'},'after-rollback')).status,200);
});
