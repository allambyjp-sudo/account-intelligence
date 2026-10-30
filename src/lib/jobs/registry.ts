import { heartbeatJob } from "./heartbeat";
import type { JobDefinition } from "./types";

/** Every job the worker runs. Phase 2 adds research; Phase 3 adds the pollers. */
export const ALL_JOBS: JobDefinition<never>[] = [heartbeatJob as JobDefinition<never>];
