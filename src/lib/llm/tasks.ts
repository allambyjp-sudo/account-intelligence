import { EFFORTS, LLM_TASKS, type Effort, type LLMTask } from "./types";

/**
 * Per-task model settings. Every task defaults to ANTHROPIC_MODEL (claude-opus-5-5). Override one
 * task with LLM_MODEL_<TASK> and LLM_EFFORT_<TASK>, e.g. LLM_MODEL_CLASSIFY=claude-haiku-5-5 to
 * classify news more cheaply once volumes are known.
 */
export const DEFAULT_MODEL = "claude-opus-5-5";

const DEFAULT_EFFORT: Record<LLMTask, Effort> = {
  research: "high",
  classify: "low",
  advisor: "high",
  meeting_prep: "high",
  email_match: "low",
  email_summary: "low",
  smoke: "low",
};

/** Output budgets include thinking tokens, which Opus 5.5 always uses. */
const DEFAULT_MAX_TOKENS: Record<LLMTask, number> = {
  research: 64_000,
  classify: 4_000,
  advisor: 32_000,
  meeting_prep: 32_000,
  email_match: 4_000,
  email_summary: 8_000,
  smoke: 4_000,
};

export interface TaskSettings {
  model: string;
  effort: Effort;
  maxTokens: number;
}

type Env = Record<string, string | undefined>;

export function taskSettings(task: LLMTask, env: Env = process.env): TaskSettings {
  const key = task.toUpperCase();
  const effort = env[`LLM_EFFORT_${key}`] ?? DEFAULT_EFFORT[task];
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`LLM_EFFORT_${key} must be one of ${EFFORTS.join(", ")}; got "${effort}"`);
  }
  return {
    model: env[`LLM_MODEL_${key}`] || env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    effort: effort as Effort,
    maxTokens: DEFAULT_MAX_TOKENS[task],
  };
}

export const ALL_TASKS = LLM_TASKS;
