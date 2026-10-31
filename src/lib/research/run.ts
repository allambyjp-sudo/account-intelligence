import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { BriefSectionKind } from "@/lib/domain/enums";
import type { PoliteFetcher } from "@/lib/http";
import { emptyUsage, type LLMProvider } from "@/lib/llm/types";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";
import { emptyStats } from "./citations";
import { gather } from "./gather";
import { buildPack } from "./pack";
import { runChallenges, runLicensingLens, runProfile, runServicesFit, runStakeholders, runTechStack, type SectionContext } from "./sections";

export const SECTION_ORDER: BriefSectionKind[] = ["profile", "stakeholders", "tech_stack", "challenges", "licensing_lens", "services_fit"];

export interface ResearchDeps {
  db: Db;
  llm: LLMProvider;
  fetcher: PoliteFetcher;
  env: Record<string, string | undefined>;
  now?: () => Date;
}

/**
 * The deep research agent (brief, section 4.2). Stage 1 gathers and stores sources; stage 2 asks
 * the model for each brief section against those sources, checks every citation, and saves a new
 * version of each section. A failing section doesn't stop the others.
 */
export async function runResearch(deps: ResearchDeps, runId: string): Promise<t.ResearchRun> {
  const { db, llm, fetcher, env } = deps;
  const now = deps.now?.() ?? new Date();
  const [run] = await db.select().from(t.researchRuns).where(eq(t.researchRuns.id, runId)).limit(1);
  if (!run) throw new Error(`No research run ${runId}`);
  const [account] = await db.select().from(t.accounts).where(eq(t.accounts.id, run.accountId)).limit(1);
  if (!account) throw new Error(`Account ${run.accountId} no longer exists`);
  const entities = await db.select().from(t.entities).where(eq(t.entities.accountId, account.id));

  const update = (patch: Partial<t.ResearchRun>) => db.update(t.researchRuns).set(patch).where(eq(t.researchRuns.id, runId)).returning();
  await update({ status: "running", stage: "gather", startedAt: now, error: null });

  try {
    const gathered = await gather({ db, fetcher, llm, env, account, entities, now });
    if (!gathered.sources.length) {
      const [done] = await update({
        status: "failed",
        stage: null,
        finishedAt: new Date(),
        stats: { gather: gathered.stats },
        error: "No sources could be read. Check the account's website and the source settings on /sources.",
      });
      return done!;
    }

    const pack = buildPack(gathered.sources);
    const sourcesPrompt = getPrompt("research.sources_system");
    const ctx: SectionContext = {
      db,
      llm,
      account,
      entities,
      pack,
      system: `${getPrompt("system.base").template}\n\n${renderPrompt(sourcesPrompt, { company_name: account.name, sources: pack.rendered })}`,
      now,
      orgName: env.ORG_NAME ?? "Datacom",
      stats: emptyStats(),
      usage: emptyUsage(),
    };
    if (gathered.webSearchUsage) {
      ctx.usage = { ...ctx.usage, inputTokens: gathered.webSearchUsage.inputTokens, outputTokens: gathered.webSearchUsage.outputTokens, webSearches: gathered.webSearchUsage.webSearches };
    }

    const sections: Record<string, string> = {};
    let challenges: Awaited<ReturnType<typeof runChallenges>> | null = null;
    for (const section of SECTION_ORDER) {
      await update({ stage: section });
      try {
        if (section === "profile") await runProfile(ctx);
        else if (section === "stakeholders") await runStakeholders(ctx);
        else if (section === "tech_stack") await runTechStack(ctx, gathered.footprint);
        else if (section === "challenges") challenges = await runChallenges(ctx);
        else if (section === "licensing_lens") await runLicensingLens(ctx);
        else await runServicesFit(ctx, challenges);
        sections[section] = "ok";
      } catch (err) {
        sections[section] = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }

    const ok = Object.values(sections).filter((s) => s === "ok").length;
    const status = ok === SECTION_ORDER.length ? "succeeded" : ok > 0 ? "partial" : "failed";
    if (ok > 0) await db.update(t.accounts).set({ lastResearchedAt: now }).where(eq(t.accounts.id, account.id));
    const [done] = await update({
      status,
      stage: null,
      finishedAt: new Date(),
      stats: { gather: gathered.stats, sections, citations: ctx.stats, sourcesInPack: pack.entries.length },
      usage: { ...ctx.usage },
      error: status === "failed" ? "Every brief section failed. See stats for details." : null,
    });
    return done!;
  } catch (err) {
    const [done] = await update({ status: "failed", stage: null, finishedAt: new Date(), error: err instanceof Error ? err.message : String(err) });
    return done!;
  }
}

/** Creates a queued run. The caller sends the research-account job with its id. */
export async function createResearchRun(db: Db, accountId: string, requestedBy: string | null): Promise<t.ResearchRun> {
  const [run] = await db.insert(t.researchRuns).values({ accountId, requestedBy }).returning();
  return run!;
}
