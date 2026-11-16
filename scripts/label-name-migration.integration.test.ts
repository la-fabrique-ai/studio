// @vitest-environment node
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const describeDb = process.env.JIROO_RUN_DB_TESTS === "1" ? describe : describe.skip;
const migration = readFileSync(new URL("../drizzle/0028_label_name_uniqueness.sql", import.meta.url), "utf8");
const preflight = readFileSync(new URL("./check-label-duplicates.sql", import.meta.url), "utf8");

// Every object lives in a disposable schema and every write is rolled back.
async function isolated(work: (client: Client) => Promise<void>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = `label_test_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query("CREATE TABLE labels (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), backlog_id uuid, name text NOT NULL, color text NOT NULL DEFAULT '--label-1')");
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

describeDb("label uniqueness migration", () => {
  it("reports local collisions without changing data and refuses migration until manually resolved", async () => {
    await isolated(async (client) => {
      const backlog = randomUUID();
      await client.query("INSERT INTO labels (backlog_id, name) VALUES ($1, 'Urgent'), ($1, 'URGENT'), (NULL, 'Global'), (NULL, 'GLOBAL')", [backlog]);
      const before = (await client.query("SELECT * FROM labels ORDER BY id")).rows;
      const duplicates = (await client.query(preflight)).rows;
      expect(duplicates).toEqual([expect.objectContaining({ backlog_id: backlog, name_key: "urgent", duplicate_count: "2", label_ids: expect.any(Array) })]);
      expect((await client.query("SELECT * FROM labels ORDER BY id")).rows).toEqual(before);
      await client.query("SAVEPOINT migration_attempt");
      await expect(client.query(migration)).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT migration_attempt");
      expect((await client.query("SELECT * FROM labels ORDER BY id")).rows).toEqual(before);
    });
  });

  it("preserves rows, rejects case variants locally and permits separate backlogs and global labels", async () => {
    await isolated(async (client) => {
      const backlog = randomUUID();
      await client.query("INSERT INTO labels (backlog_id, name) VALUES ($1, 'Urgent')", [backlog]);
      const before = (await client.query("SELECT * FROM labels")).rows;
      await client.query(migration);
      expect((await client.query("SELECT * FROM labels")).rows).toEqual(before);
      await client.query("SAVEPOINT duplicate_attempt");
      await expect(client.query("INSERT INTO labels (backlog_id, name) VALUES ($1, 'URGENT')", [backlog])).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_attempt");
      await client.query("INSERT INTO labels (backlog_id, name) VALUES ($1, 'urgent'), (NULL, 'Global'), (NULL, 'GLOBAL')", [randomUUID()]);
      expect((await client.query(preflight)).rows).toEqual([]);
    });
  });
});
