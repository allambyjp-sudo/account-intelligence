import { heartbeatJob } from "./heartbeat";
import { researchAccountJob, resolveIntakeJob } from "./research";
import type { JobDefinition } from "./types";

/** Every job the worker runs. */
export const ALL_JOBS = [heartbeatJob, resolveIntakeJob, researchAccountJob] as unknown as JobDefinition<never>[];
