import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import {
  ProjectError,
  createProject,
  listProjects,
  projectInputSchema,
  projectUpdateSchema,
  readProject,
  updateProject,
} from "../src/lib/projects/store.ts";

// Private projects run on the application schema in an isolated in-memory
// database, migrated 001-015. Fixtures are invented test data; no provider is
// called and no image is generated.
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}

const draft = { game: "Island tycoon", gameplay: "Build and trade on a floating island", audience: "Playful builders", artDirection: "Bright flat shapes", constraints: [] };
const actor = "owner:a";
const rejection = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected a ProjectError"), (thrown) => thrown);
  assert.ok(error instanceof ProjectError, `expected ProjectError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return error;
};
// now() is read from the clock, so a short pause keeps created/updated ordering distinct.
const pause = () => new Promise((resolve) => setTimeout(resolve, 8));

test("a draft project may leave gameplay, audience and art direction empty", async (t) => {
  const db = await database(t);
  const spelledOut = await createProject(db, { ownerId: actor, name: "First idea", context: { game: "Island tycoon", gameplay: "", audience: "", artDirection: "", constraints: [] } });
  assert.equal(spelledOut.revision, 1);
  assert.equal(spelledOut.archived, false);
  assert.equal(spelledOut.context.gameplay, "");
  assert.equal(new Date(spelledOut.updatedAt).toISOString(), spelledOut.updatedAt);

  // Omitted draft fields default to empty strings; constraints still default to [].
  const omitted = await createProject(db, { ownerId: actor, name: "Second idea", context: { game: "Island tycoon" } });
  assert.deepEqual(omitted.context, { game: "Island tycoon", gameplay: "", audience: "", artDirection: "", constraints: [] });

  // A game title is required, and every field stays bounded once written.
  await rejection(createProject(db, { ownerId: actor, name: "No game", context: { gameplay: "Only gameplay" } }), "invalid_input");
  await rejection(createProject(db, { ownerId: actor, name: "Too long", context: { game: "g".repeat(101) } }), "invalid_input");
  await rejection(createProject(db, { ownerId: actor, name: "Too long", context: { game: "Game", gameplay: "g".repeat(2001) } }), "invalid_input");
  await rejection(createProject(db, { ownerId: actor, name: "Too long", context: { game: "Game", audience: "a".repeat(501) } }), "invalid_input");
  await rejection(createProject(db, { ownerId: actor, name: "Too long", context: { game: "Game", artDirection: "d".repeat(1001) } }), "invalid_input");
  await rejection(createProject(db, { ownerId: actor, name: "Too long", context: { game: "Game", constraints: Array.from({ length: 13 }, () => "note") } }), "invalid_input");
});

test("a summary carries the gameplay line cut to 200 characters and nothing invented", async (t) => {
  const db = await database(t);
  const long = "g".repeat(500);
  const longProject = await createProject(db, { ownerId: actor, name: "Long", context: { game: "Game", gameplay: long } });
  let [listed] = await listProjects(db, actor);
  assert.equal(listed.id, longProject.id);
  assert.equal(listed.description.length, 200);
  assert.equal(listed.description, long.slice(0, 200));
  assert.equal("context" in listed, false, "summaries do not leak the full context");

  await pause();
  const blank = await createProject(db, { ownerId: actor, name: "Blank", context: { game: "Game" } });
  [listed] = await listProjects(db, actor);
  assert.equal(listed.id, blank.id);
  assert.equal(listed.description, "");

  const short = await updateProject(db, { ownerId: actor, id: blank.id, revision: 1, name: "Short", context: { game: "Game", gameplay: "Tiny loop" }, archived: false });
  assert.equal(short.context.gameplay, "Tiny loop");
  [listed] = await listProjects(db, actor);
  assert.equal(listed.description, "Tiny loop");
});

test("create, read, list and update are scoped to one owner and ordered by update", async (t) => {
  const db = await database(t);
  const first = await createProject(db, { ownerId: actor, name: "Alpha", context: draft });
  await pause();
  const second = await createProject(db, { ownerId: actor, name: "Beta", context: draft });
  assert.deepEqual((await listProjects(db, actor)).map((project) => project.id), [second.id, first.id]);

  const read = await readProject(db, actor, first.id);
  assert.deepEqual(read, { ...first });
  assert.equal(await readProject(db, "owner:b", first.id), null);
  assert.deepEqual(await listProjects(db, "owner:b"), []);

  // Another owner cannot read or update the project; the owner can.
  await rejection(updateProject(db, { ownerId: "owner:b", id: first.id, revision: 1, name: "Stolen", context: draft, archived: false }), "not_found");
  await pause();
  const updated = await updateProject(db, { ownerId: actor, id: first.id, revision: 1, name: "Alpha revised", context: { ...draft, gameplay: "Changed" }, archived: false });
  assert.equal(updated.id, first.id);
  assert.equal(updated.name, "Alpha revised");
  assert.equal(updated.revision, 2);
  assert.ok(Date.parse(updated.updatedAt) > Date.parse(first.updatedAt));
  assert.deepEqual((await listProjects(db, actor)).map((project) => project.id), [first.id, second.id]);
  // The update is durable, including its context.
  assert.deepEqual((await readProject(db, actor, first.id)).context, { ...draft, gameplay: "Changed" });
});

test("malformed and unknown project IDs are not found", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: actor, name: "Alpha", context: draft });
  for (const id of ["not-a-uuid", "", "123", randomUUID(), { id: project.id }]) assert.equal(await readProject(db, actor, id), null);
  for (const id of ["not-a-uuid", randomUUID()]) {
    await rejection(updateProject(db, { ownerId: actor, id, revision: 1, name: "Alpha", context: draft, archived: false }), "not_found");
  }
  assert.equal((await readProject(db, actor, project.id)).revision, 1);
});

test("strict schemas reject owner injection and extra keys", () => {
  const context = { game: "Island tycoon" };
  assert.equal(projectInputSchema.safeParse({ name: "Alpha", context }).success, true);
  for (const injected of [{ ownerId: "attacker" }, { owner_id: "attacker" }, { extra: 1 }]) {
    assert.equal(projectInputSchema.safeParse({ name: "Alpha", context, ...injected }).success, false);
  }
  assert.equal(projectInputSchema.safeParse({ name: "Alpha", context: { ...context, owner_id: "attacker" } }).success, false);
  assert.equal(projectInputSchema.safeParse({ context }).success, false);
  assert.equal(projectInputSchema.safeParse({ name: "   ", context }).success, false);
  assert.equal(projectInputSchema.safeParse({ name: "n".repeat(101), context }).success, false);

  const update = { name: "Alpha", context, revision: 1, archived: false };
  assert.equal(projectUpdateSchema.safeParse(update).success, true);
  assert.equal(projectUpdateSchema.safeParse({ ...update, ownerId: "attacker" }).success, false);
  assert.equal(projectUpdateSchema.safeParse({ ...update, revision: 0 }).success, false);
  assert.equal(projectUpdateSchema.safeParse({ ...update, revision: 1.5 }).success, false);
  assert.equal(projectUpdateSchema.safeParse({ ...update, revision: "1" }).success, false);
  assert.equal(projectUpdateSchema.safeParse({ ...update, archived: "true" }).success, false);
  assert.equal(projectUpdateSchema.safeParse({ name: "Alpha", context, revision: 1 }).success, false);
});

test("invalid input is refused before anything is written", async (t) => {
  const db = await database(t);
  await rejection(createProject(db, { ownerId: actor, name: "", context: draft }), "invalid_input");
  await rejection(createProject(db, { ownerId: actor, name: "n".repeat(101), context: draft }), "invalid_input");
  await rejection(createProject(db, { ownerId: "", name: "Alpha", context: draft }), "invalid_input");
  await rejection(createProject(db, { ownerId: "x".repeat(201), name: "Alpha", context: draft }), "invalid_input");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_projects")).rows[0].count, 0);
});

test("duplicate concurrent updates cannot overwrite each other", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: actor, name: "Race", context: draft });
  const attempt = (name) => updateProject(db, { ownerId: actor, id: project.id, revision: 1, name, context: draft, archived: false });
  const settled = await Promise.allSettled([attempt("First writer"), attempt("Second writer")]);
  const won = settled.filter((result) => result.status === "fulfilled");
  const lost = settled.filter((result) => result.status === "rejected");
  assert.equal(won.length, 1, "exactly one update wins");
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, "conflict");

  const stored = await readProject(db, actor, project.id);
  assert.equal(stored.revision, 2);
  assert.equal(stored.name, won[0].value.name);
  await rejection(attempt("Stale writer"), "conflict");
  assert.equal((await updateProject(db, { ownerId: actor, id: project.id, revision: 2, name: "Third writer", context: draft, archived: false })).revision, 3);
});

test("archiving hides a project from the default listing but keeps its context", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: actor, name: "Keep", context: draft });
  const archived = await updateProject(db, { ownerId: actor, id: project.id, revision: 1, name: "Keep", context: { ...draft, gameplay: "Archived but kept" }, archived: true });
  assert.equal(archived.archived, true);
  assert.equal(archived.revision, 2);

  assert.deepEqual(await listProjects(db, actor), []);
  assert.deepEqual((await listProjects(db, actor, { archived: true })).map((entry) => entry.id), [project.id]);
  const stored = await readProject(db, actor, project.id);
  assert.equal(stored.archived, true);
  assert.equal(stored.context.gameplay, "Archived but kept");

  // A stale request against the archived revision fails rather than reviving it.
  await rejection(updateProject(db, { ownerId: actor, id: project.id, revision: 1, name: "Keep", context: draft, archived: false }), "conflict");
  const restored = await updateProject(db, { ownerId: actor, id: project.id, revision: 2, name: "Keep", context: stored.context, archived: false });
  assert.equal(restored.archived, false);
  assert.equal(restored.revision, 3);
  assert.equal(restored.context.gameplay, "Archived but kept");
  assert.deepEqual((await listProjects(db, actor)).map((entry) => entry.id), [project.id]);
  assert.deepEqual(await listProjects(db, actor, { archived: true }), []);
});

test("an owner may keep at most 100 projects, archived ones included", async (t) => {
  const db = await database(t);
  for (let index = 0; index < 100; index++) await createProject(db, { ownerId: actor, name: `Project ${index}`, context: draft });
  assert.equal((await listProjects(db, actor)).length, 100);
  await rejection(createProject(db, { ownerId: actor, name: "Overflow", context: draft }), "limit");

  const [oldest] = await listProjects(db, actor);
  await updateProject(db, { ownerId: actor, id: oldest.id, revision: 1, name: "Archived", context: draft, archived: true });
  // Archiving frees nothing: the project still counts.
  await rejection(createProject(db, { ownerId: actor, name: "Still full", context: draft }), "limit");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_projects WHERE owner_id=$1", [actor])).rows[0].count, 100);

  // The cap is per owner, and a refused create leaves nothing behind.
  const other = await createProject(db, { ownerId: "owner:b", name: "Not full", context: draft });
  assert.equal(other.revision, 1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM creative_projects")).rows[0].count, 101);
});

test("a chat can only link a project owned by the same owner", async (t) => {
  const db = await database(t);
  const project = await createProject(db, { ownerId: actor, name: "Linked", context: draft });
  const attach = (ownerId, projectId) => db.query("INSERT INTO chats(id, owner_id, title, project_id) VALUES ($1,$2,$3,$4)", [randomUUID(), ownerId, "Chat", projectId]);

  await attach(actor, project.id);
  await attach(actor, null);
  await assert.rejects(attach("owner:b", project.id), /foreign key|violates/i);
  await assert.rejects(attach("owner:b", randomUUID()), /foreign key|violates/i);

  // Projects are archived, never deleted while a chat still points at one.
  await assert.rejects(db.query("DELETE FROM creative_projects WHERE id=$1", [project.id]), /foreign key|violates/i);
  await updateProject(db, { ownerId: actor, id: project.id, revision: 1, name: "Linked", context: draft, archived: true });
  assert.equal((await readProject(db, actor, project.id)).archived, true);
});
