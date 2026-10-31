import { advisorRefreshJob, memorySyncJob } from "./advisor";
import { heartbeatJob } from "./heartbeat";
import { advisoriesJob, classifySignalsJob, classifySweepJob, monitorAccountJob, monitorSweepJob, quietCheckJob } from "./monitor";
import { researchAccountJob, resolveIntakeJob } from "./research";
import type { JobDefinition } from "./types";

/** Every job the worker runs. */
export const ALL_JOBS = [
  heartbeatJob,
  resolveIntakeJob,
  researchAccountJob,
  monitorSweepJob,
  monitorAccountJob,
  classifySweepJob,
  classifySignalsJob,
  advisoriesJob,
  quietCheckJob,
  memorySyncJob,
  advisorRefreshJob,
] as unknown as JobDefinition<never>[];
