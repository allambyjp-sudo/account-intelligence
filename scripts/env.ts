/** Load .env when present (Node 21.7+). Real environment variables always win. */
export function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env file: rely on the environment
  }
}
