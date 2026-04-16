import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export function isAuthStatus(status: number) {
  return status === 401 || status === 403;
}

export async function getTokenFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  try {
    const cookieStore = await cookies();
    return cookieStore.get("monitor_token")?.value ?? null;
  } catch {
    return null;
  }
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
