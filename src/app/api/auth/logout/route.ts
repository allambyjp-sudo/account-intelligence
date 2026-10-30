import { NextResponse, type NextRequest } from "next/server";
import { isSameOrigin, publicUrl } from "@/lib/auth/http";
import { SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });
  const res = NextResponse.redirect(publicUrl(req, "/signin?signedOut=1"), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
