import assert from "node:assert/strict";
import test from "node:test";
import { checkFixFiles, checkFixStatement, checkReadQuery, redactRow } from "./supportSqlGuard";

test("the agent may run one plain read", () => {
  assert.deepEqual(checkReadQuery("SELECT id, status FROM events WHERE id = 5;"), { ok: true, sql: "SELECT id, status FROM events WHERE id = 5" });
  assert.equal(checkReadQuery("with x as (select 1) select * from x").ok, true);
  // updated_at isn't the UPDATE keyword
  assert.equal(checkReadQuery("select updated_at from users").ok, true);
});

test("anything that writes, chains or escapes is refused", () => {
  for (const sql of [
    "UPDATE events SET status = 'x' WHERE id = 1",
    "select 1; drop table users",
    "with d as (delete from riders returning *) select * from d",
    "select pg_sleep(30)",
    "select pg_read_file('/etc/passwd')",
    "select 1 -- comment",
    "select /* hi */ 1",
    "explain select 1",
    "select set_config('x','y',false)",
    "",
    42,
  ]) {
    assert.equal(checkReadQuery(sql).ok, false, String(sql));
  }
});

test("a data fix is one targeted write with an expected row count", () => {
  const ok = checkFixStatement("UPDATE registrations SET status = 'confirmed' WHERE id = 77", 1);
  assert.equal(ok.ok, true);
  assert.equal((ok as any).expectedRows, 1);
  assert.equal(checkFixStatement("delete from checkins", 3).ok, false, "DELETE needs WHERE");
  assert.equal(checkFixStatement("update riders set bib_number = null where id = 1; drop table riders", 1).ok, false);
  assert.equal(checkFixStatement("alter table riders add column x int", 1).ok, false);
  assert.equal(checkFixStatement("UPDATE riders SET x = 1 WHERE id = 1", 0).ok, false);
  assert.equal(checkFixStatement("UPDATE riders SET x = 1 WHERE id = 1", 501).ok, false);
  assert.equal(checkFixStatement("insert into rental_transponders (club_id, transponder_number) values (1, 'abc')", 1).ok, true);
});

test("secret columns are hidden and long values shortened", () => {
  const row = redactRow({ id: 1, password_hash: "x", token: "y", approval_token_hash: null, name: "a".repeat(600) });
  assert.equal(row.password_hash, "[hidden]");
  assert.equal(row.token, "[hidden]");
  assert.equal(row.approval_token_hash, null);
  assert.match(String(row.name), /… \(600 chars\)$/);
});

test("code fixes stay in the app's source folders", () => {
  assert.equal(checkFixFiles([{ path: "artifacts/api-server/src/routes/x.ts", content: "ok" }]).ok, true);
  for (const path of [".github/workflows/x.yml", "../etc/passwd", ".env", "scripts/x.mjs", "artifacts/race-platform/dist/a.js", "/abs.ts"]) {
    assert.equal(checkFixFiles([{ path, content: "x" }]).ok, false, path);
  }
  assert.equal(checkFixFiles(Array.from({ length: 6 }, (_, i) => ({ path: `lib/f${i}.ts`, content: "" }))).ok, false);
  assert.equal(checkFixFiles([]).ok, false);
});
