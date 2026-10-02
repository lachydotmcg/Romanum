import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const root=fileURLToPath(new URL("../src/",import.meta.url));
const sourceUrl=pathToFileURL(root).href;
const virtual=source=>({url:`data:text/javascript,${encodeURIComponent(source)}`,shortCircuit:true});
const hooks=registerHooks({
  resolve(specifier,context,nextResolve){
    // Mock only request-cookie and database seams; actual routes, guard, session lookup, SQL and UI are loaded.
    if(specifier==="next/headers") return virtual('export async function cookies(){return {get(){return globalThis.__adminTestToken ? {value:globalThis.__adminTestToken} : undefined}}}');
    if(context.parentURL?.endsWith("/admin/server.ts") && specifier==="../history/database.ts") return virtual('export async function historyDatabase(){return globalThis.__adminTestDatabase}');
    if(["next/link","next/navigation"].includes(specifier)) return nextResolve(`${specifier}.js`,context);
    if(specifier.startsWith("@/") || (context.parentURL?.startsWith(sourceUrl)&&specifier.startsWith("."))){
      const base=specifier.startsWith("@/") ? path.resolve(root,specifier.slice(2)) : fileURLToPath(new URL(specifier,context.parentURL));
      const candidate=[base,`${base}.ts`,`${base}.tsx`].find(file=>existsSync(file)&&statSync(file).isFile());
      if(candidate)return {url:pathToFileURL(candidate).href,shortCircuit:true};
    }
    return nextResolve(specifier,context);
  },
  load(url,context,nextLoad){
    if(url.startsWith(sourceUrl)&&/\.tsx?$/.test(url))return {format:"module",shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText};
    return nextLoad(url,context);
  }
});
const {GET}=await import("../src/app/api/admin/route.ts");
const {default:AdminPage}=await import("../src/app/admin/page.tsx");
hooks.deregister();

test("actual page and API share owner enforcement, live rendering and private response isolation",async t=>{
  const engine=await PGlite.create();
  t.after(()=>engine.close());
  const adapt=client=>({query:(text,values)=>client.query(text,values),exec:async text=>{await client.exec(text);}});
  const database={...adapt(engine),transaction:operation=>engine.transaction(client=>operation(adapt(client))),close:()=>engine.close()};
  await migrateHistory(database);
  const id="b90e15ba-7711-437d-b0ce-4f563197da20";
  const token="e".repeat(43);
  await engine.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name,created_at) VALUES($1,142277800,$2,'Fixture owner','Fixture owner',now()-interval '1 day')",[id,id]);
  await engine.query("INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[createHash("sha256").update(token).digest("hex"),id]);
  const before={account:process.env.ROMANUM_ADMIN_ACCOUNT_ID,roblox:process.env.ROMANUM_ADMIN_ROBLOX_USER_ID};
  globalThis.__adminTestDatabase=database;
  process.env.ROMANUM_ADMIN_ACCOUNT_ID=id;
  process.env.ROMANUM_ADMIN_ROBLOX_USER_ID="142277800";
  const request=()=>new Request("http://localhost:3000/api/admin?page=999999");
  const page=()=>AdminPage({searchParams:Promise.resolve({page:"999999"})});
  const notFound=error=>error.digest==="NEXT_HTTP_ERROR_FALLBACK;404";
  try{
    globalThis.__adminTestToken=token;
    const response=await GET(request());
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"private, no-store, max-age=0");
    assert.equal(response.headers.get("vary"),"Cookie");
    const body=await response.json();
    assert.equal(body.mode,"live");
    assert.equal(body.report.registeredUsers,1);
    assert.equal(body.report.activeUsers24h,0);
    assert.equal(body.report.savedMessages,0);
    assert.equal(body.report.providerCostNanoUsd,0);
    assert.equal(body.report.creditsSpent24h,0);
    assert.equal(body.report.users[0].balance,null);
    assert.equal(body.report.pagination.page,1);
    const markup=renderToStaticMarkup(await page());
    assert.ok(markup.includes("Owner-only"));
    assert.ok(markup.includes("Database snapshot:"));
    assert.ok(markup.includes("Fixture owner"));
    assert.doesNotMatch(markup,/synthetic fixture|Sample data|Fixed fixture snapshot/);
    await engine.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name,created_at) SELECT md5(n::text)::uuid,n+1000,'fixture:'||n,'Fixture '||n,'Fixture '||n,now()-interval '1 day' FROM generate_series(1,100) AS n");
    const first=(await (await GET(new Request("http://localhost:3000/api/admin?page=1"))).json()).report;
    const last=(await (await GET(request())).json()).report;
    assert.equal(first.registeredUsers,101);
    assert.equal(first.users.length,100);
    assert.equal(last.users.length,1);
    assert.equal(last.pagination.page,2);
    assert.ok(!first.users.some(user=>user.id===last.users[0].id));
    assert.ok(renderToStaticMarkup(await page()).includes("page 2 of 2"));
    for(const cookie of [null,"ordinary-user","f".repeat(43)]){
      globalThis.__adminTestToken=cookie;
      const denied=await GET(new Request("http://localhost:3000/api/admin",{headers:{"x-admin":"true","x-user-role":"admin"}}));
      assert.equal(denied.status,404);
      assert.deepEqual(await denied.json(),{error:"Not found."});
      await assert.rejects(page(),notFound);
    }
    globalThis.__adminTestToken=token;
    delete process.env.ROMANUM_ADMIN_ACCOUNT_ID;
    assert.equal((await GET(request())).status,404);
    await assert.rejects(page(),notFound);
    process.env.ROMANUM_ADMIN_ACCOUNT_ID=id;
    await engine.query("DELETE FROM accounts WHERE id=$1",[id]);
    assert.equal((await GET(request())).status,404);
    await assert.rejects(page(),notFound);
  }finally{
    for(const [key,value] of [["ROMANUM_ADMIN_ACCOUNT_ID",before.account],["ROMANUM_ADMIN_ROBLOX_USER_ID",before.roblox]]) if(value===undefined)delete process.env[key];else process.env[key]=value;
    delete globalThis.__adminTestToken; delete globalThis.__adminTestDatabase;
  }
});
