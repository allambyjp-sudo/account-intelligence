import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

/** The rules from the brief that the database itself enforces. */
describe.skipIf(!hasTestDb)("database invariants", () => {
  let t: TestDb;
  let userId: string;
  let accountId: string;
  let excludedAccountId: string;
  let sourceId: string;
  let stakeholderId: string;

  const q = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0] as { id: string };

  beforeAll(async () => {
    t = await createTestDb();
    userId = (
      await one(
        `INSERT INTO users (entra_tenant_id, entra_object_id, email, display_name)
         VALUES ('t', 'o', 'seller@example.com', 'Seller') RETURNING id`,
      )
    ).id;
    accountId = (await one(`INSERT INTO accounts (owner_user_id, name) VALUES ($1, 'Acme (fictional)') RETURNING id`, [userId])).id;
    excludedAccountId = (
      await one(
        `INSERT INTO accounts (owner_user_id, name, email_excluded, email_excluded_reason)
         VALUES ($1, 'Agency (fictional)', true, 'Government account') RETURNING id`,
        [userId],
      )
    ).id;
    sourceId = (
      await one(
        `INSERT INTO sources (url, adapter, source_type) VALUES ('https://example.com/about', 'manual', 'web') RETURNING id`,
      )
    ).id;
    stakeholderId = (
      await one(
        `INSERT INTO stakeholders (account_id, full_name, title, function) VALUES ($1, 'Alex Example', 'CIO', 'cio') RETURNING id`,
        [accountId],
      )
    ).id;
  });
  afterAll(async () => {
    await t?.drop();
  });

  describe("everything cited", () => {
    it("rejects a verified claim with no source", async () => {
      await expect(
        q(`INSERT INTO tech_stack_items (account_id, vendor, product, category, evidence_kind, verification)
           VALUES ($1, 'Microsoft', 'Entra ID', 'identity', 'job_ad', 'verified')`, [accountId]),
      ).rejects.toThrow(/check constraint/);
    });

    it("rejects a verified claim with a source but no retrieval time", async () => {
      await expect(
        q(`INSERT INTO tech_stack_items (account_id, vendor, product, category, evidence_kind, verification, source_id)
           VALUES ($1, 'Microsoft', 'Intune', 'end_user', 'job_ad', 'verified', $2)`, [accountId, sourceId]),
      ).rejects.toThrow(/check constraint/);
    });

    it("accepts a verified claim with source and retrieval time, and an unconfirmed one without", async () => {
      await q(
        `INSERT INTO tech_stack_items (account_id, vendor, product, category, evidence_kind, verification, source_id, retrieved_at)
         VALUES ($1, 'Microsoft', 'Defender', 'security', 'job_ad', 'verified', $2, now())`,
        [accountId, sourceId],
      );
      await q(
        `INSERT INTO tech_stack_items (account_id, vendor, product, category, evidence_kind)
         VALUES ($1, 'ServiceNow', 'ITSM', 'other', 'web_footprint')`,
        [accountId],
      );
    });

    it("will not delete a source that something cites", async () => {
      await expect(q(`DELETE FROM sources WHERE id = $1`, [sourceId])).rejects.toThrow(/foreign key/);
    });
  });

  describe("professional contacts only", () => {
    it("has no way to store a personal contact", async () => {
      await expect(
        q(`INSERT INTO contact_points (stakeholder_id, kind, value, confidence) VALUES ($1, 'personal_mobile', '0400 000 000', 'inferred')`, [
          stakeholderId,
        ]),
      ).rejects.toThrow(/check constraint/);
    });

    it("never stores an inferred phone number", async () => {
      await expect(
        q(`INSERT INTO contact_points (stakeholder_id, kind, value, confidence) VALUES ($1, 'work_phone', '+61 3 9000 0000', 'inferred')`, [
          stakeholderId,
        ]),
      ).rejects.toThrow(/check constraint/);
    });

    it("requires a source for a published contact", async () => {
      await expect(
        q(`INSERT INTO contact_points (stakeholder_id, kind, value, confidence) VALUES ($1, 'work_email', 'alex@example.com', 'published')`, [
          stakeholderId,
        ]),
      ).rejects.toThrow(/check constraint/);
    });

    it("requires the pattern for a verified-pattern email", async () => {
      await expect(
        q(`INSERT INTO contact_points (stakeholder_id, kind, value, confidence) VALUES ($1, 'work_email', 'alex.example@example.com', 'verified_pattern')`, [
          stakeholderId,
        ]),
      ).rejects.toThrow(/check constraint/);
      await q(
        `INSERT INTO contact_points (stakeholder_id, kind, value, confidence, pattern)
         VALUES ($1, 'work_email', 'alex.example@example.com', 'verified_pattern', '{first}.{last}@example.com')`,
        [stakeholderId],
      );
    });

    it("rejects a malformed email", async () => {
      await expect(
        q(`INSERT INTO contact_points (stakeholder_id, kind, value, confidence) VALUES ($1, 'work_email', 'not an email', 'inferred')`, [
          stakeholderId,
        ]),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it("rejects a recommendation with no evidence", async () => {
    await expect(
      q(`INSERT INTO recommendations (account_id, kind, title, body, evidence, input_fingerprint, prompt_id, prompt_version, model)
         VALUES ($1, 'next_best_action', 'Call the CIO', 'Because.', '[]', 'fp', 'advisor.next', 1, 'm')`, [accountId]),
    ).rejects.toThrow(/check constraint/);
  });

  describe("email exclusion", () => {
    const thread = (account: string, providerId: string) =>
      q(
        `INSERT INTO email_threads (user_id, account_id, provider, provider_thread_id, subject, first_message_at, last_message_at, match_method, match_status)
         VALUES ($1, $2, 'synthetic', $3, 'Renewal', now(), now(), 'sender_domain', 'auto')`,
        [userId, account, providerId],
      );

    it("refuses to store email against an excluded account", async () => {
      await expect(thread(excludedAccountId, "x-1")).rejects.toThrow(/excluded from email ingestion/);
    });

    it("purges stored email when an account is excluded later", async () => {
      await thread(accountId, "a-1");
      await q(`UPDATE accounts SET email_excluded = true, email_excluded_reason = 'Sensitive' WHERE id = $1`, [accountId]);
      const { rows } = await q(`SELECT count(*)::int AS n FROM email_threads WHERE account_id = $1`, [accountId]);
      expect(rows[0].n).toBe(0);
    });
  });

  it("keeps signals unclassified until a classifier has run", async () => {
    await expect(
      q(`INSERT INTO signals (account_id, source_id, channel, signal_type, title, occurred_at, dedupe_key)
         VALUES ($1, $2, 'news', 'results', 'Half-year results', now(), 'k1')`, [excludedAccountId, sourceId]),
    ).rejects.toThrow(/check constraint/);
  });
});
