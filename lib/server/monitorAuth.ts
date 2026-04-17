import { NextResponse } from "next/server";

export function isAuthStatus(status: number) {
  return status === 401 || status === 403;
}

export function getTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

export function authExpiredJson(payload: Record<string, unknown>, status = 401) {
  return NextResponse.json(
    {
      authExpired: true,
      ...payload,
    },
    {
      status,
      headers: {
        "x-monitor-auth": "expired",
      },
    }
  );
}

export function authExpiredText(
  body: string,
  status: number,
  contentType = "application/json"
) {
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "x-monitor-auth": "expired",
    },
  });
}
