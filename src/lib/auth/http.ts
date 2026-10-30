import type { NextRequest } from "next/server";

/**
 * State-changing auth routes are POST-only and check that the request came from our own pages.
 * SameSite=Lax cookies already stop most cross-site posts; this closes the rest.
 */
export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The public origin, which can differ from request.url behind a proxy. */
export function publicUrl(req: NextRequest, path: string): URL {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return new URL(path, `${proto}://${host}`);
}
