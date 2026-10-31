import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { PoliteFetcher } from "@/lib/http";
import { abnSearch, asxCompanies, mergeCandidates, nzbnSearch } from "@/lib/sources/adapters/registries";
import { upsertSource } from "@/lib/sources/store";
import { SourceDisabledError, SourceNotConfiguredError, type AdapterContext } from "@/lib/sources/types";

/**
 * Intake and entity resolution (brief, section 4.1). A seller types a name; the worker searches the
 * registries and the ASX list; the seller picks the right entity (or enters it by hand); the
 * account is created and research starts.
 */
export async function resolveIntake(db: Db, fetcher: PoliteFetcher, env: Record<string, string | undefined>, intakeId: string) {
  const [req] = await db.select().from(t.intakeRequests).where(eq(t.intakeRequests.id, intakeId)).limit(1);
  if (!req || req.status !== "resolving") return;
  const ctx: AdapterContext = { fetcher, env, now: () => new Date() };
  const notes: string[] = [];
  const lists: t.IntakeCandidate[][] = [];

  const run = async (label: string, fn: () => Promise<t.IntakeCandidate[]>) => {
    try {
      lists.push(await fn());
    } catch (err) {
      if (err instanceof SourceNotConfiguredError) notes.push(`${label} isn't connected yet (${err.missing}).`);
      else if (err instanceof SourceDisabledError) notes.push(`${label} is turned off.`);
      else notes.push(`${label} couldn't be searched: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (req.country !== "NZ") {
    await run("ABN Lookup", () => abnSearch.fetch({ name: req.query }, ctx));
    await run("The ASX company list", () => asxCompanies.fetch({ name: req.query }, ctx));
  }
  if (req.country !== "AU") await run("The NZBN register", () => nzbnSearch.fetch({ name: req.query }, ctx));

  const candidates = mergeCandidates(lists).slice(0, 12);
  await db.update(t.intakeRequests).set({ status: "ready", candidates, notes }).where(eq(t.intakeRequests.id, intakeId));
}

export const confirmSchema = z
  .object({
    intakeId: z.uuid(),
    candidateKey: z.string().optional(),
    accountName: z.string().trim().min(2).max(120),
    legalName: z.string().trim().max(200).optional(),
    country: z.enum(["AU", "NZ"]).optional(),
    abn: z.string().regex(/^\d{11}$/).optional(),
    nzbn: z.string().regex(/^\d{13}$/).optional(),
    exchange: z.enum(["ASX", "NZX"]).optional(),
    ticker: z.string().regex(/^[A-Z0-9]{1,6}$/).optional(),
    websiteUrl: z.url({ protocol: /^https?$/ }).optional(),
    careersUrl: z.url({ protocol: /^https?$/ }).optional(),
    isKeyAccount: z.boolean().default(false),
  })
  .refine((v) => !v.ticker === !v.exchange, { message: "Give both the exchange and the ticker, or neither" });
export type ConfirmInput = z.infer<typeof confirmSchema>;

export type ConfirmResult = { accountId: string; created: boolean };

/** Creates the account and its primary entity from the chosen candidate or manual details. */
export async function confirmIntake(db: Db, userId: string, input: ConfirmInput): Promise<ConfirmResult> {
  const [req] = await db
    .select()
    .from(t.intakeRequests)
    .where(and(eq(t.intakeRequests.id, input.intakeId), eq(t.intakeRequests.userId, userId)))
    .limit(1);
  if (!req) throw new Error("That intake request doesn't exist");
  const cand = input.candidateKey ? req.candidates.find((c) => c.key === input.candidateKey) : undefined;
  if (input.candidateKey && !cand) throw new Error("That candidate isn't part of this request");

  const abn = cand?.abn ?? input.abn;
  const nzbn = cand?.nzbn ?? input.nzbn;
  const ticker = cand?.ticker ?? input.ticker;
  const exchange = cand?.exchange ?? input.exchange;

  // One account per real-world entity per seller.
  const idClauses = [abn ? eq(t.entities.abn, abn) : undefined, nzbn ? eq(t.entities.nzbn, nzbn) : undefined, ticker ? eq(t.entities.ticker, ticker) : undefined].filter(
    (c): c is NonNullable<typeof c> => Boolean(c),
  );
  if (idClauses.length) {
    const [dup] = await db
      .select({ id: t.accounts.id })
      .from(t.entities)
      .innerJoin(t.accounts, eq(t.entities.accountId, t.accounts.id))
      .where(and(eq(t.accounts.ownerUserId, userId), or(...idClauses)))
      .limit(1);
    if (dup) {
      await db.update(t.intakeRequests).set({ status: "completed", accountId: dup.id }).where(eq(t.intakeRequests.id, req.id));
      return { accountId: dup.id, created: false };
    }
  }

  const domain = input.websiteUrl ? new URL(input.websiteUrl).host.replace(/^www\./, "").toLowerCase() : null;
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(t.accounts)
      .values({
        ownerUserId: userId,
        name: input.accountName,
        isKeyAccount: input.isKeyAccount,
        websiteUrl: input.websiteUrl ?? null,
        careersUrl: input.careersUrl ?? null,
      })
      .returning();

    // A registry match is a cited, verified entity. Manual entry is unconfirmed until research checks it.
    const source = cand
      ? await upsertSource(tx as unknown as Db, {
          adapter: cand.adapter,
          sourceType: "registry",
          url: cand.sourceUrl,
          title: `${cand.adapter === "asx_companies" ? "ASX listing" : cand.country === "NZ" ? "NZBN register" : "ABN Lookup"}: ${cand.legalName}`,
          publisher: cand.adapter === "asx_companies" ? "ASX" : cand.country === "NZ" ? "New Zealand Companies Office" : "Australian Business Register",
          publishedAt: null,
          retrievedAt: req.updatedAt,
          entities: [{ name: cand.legalName }],
          text: [cand.legalName, cand.abn && `ABN ${cand.abn}`, cand.nzbn && `NZBN ${cand.nzbn}`, cand.ticker && `${cand.exchange}:${cand.ticker}`, cand.entityType, cand.status, cand.state]
            .filter(Boolean)
            .join("\n"),
        })
      : null;

    await tx.insert(t.entities).values({
      accountId: account!.id,
      legalName: cand?.legalName ?? input.legalName ?? input.accountName,
      country: cand?.country ?? input.country ?? "AU",
      abn: abn ?? null,
      acn: cand?.acn ?? null,
      nzbn: nzbn ?? null,
      exchange: exchange ?? null,
      ticker: ticker ?? null,
      industry: cand?.industry ?? null,
      domain,
      headquarters: cand?.state ? [cand.state, cand.postcode].filter(Boolean).join(" ") : null,
      isPrimary: true,
      sourceId: source?.id ?? null,
      retrievedAt: source?.retrievedAt ?? null,
      verification: source ? "verified" : "unconfirmed",
      confidence: cand ? "high" : "low",
    });
    await tx.update(t.intakeRequests).set({ status: "completed", accountId: account!.id }).where(eq(t.intakeRequests.id, req.id));
    return { accountId: account!.id, created: true };
  });
}
