"use client";

import { logout } from "@/lib/auth";

type JsonLike = Record<string, unknown> | null;

let redirecting = false;

function getAuthHeader(res: Response) {
  return res.headers.get("x-monitor-auth") === "expired";
}

async function readJsonSafe(res: Response): Promise<JsonLike> {
  try {
    return (await res.clone().json()) as JsonLike;
  } catch {
    return null;
  }
}

function looksLikeAuthPayload(payload: JsonLike) {
  if (!payload || typeof payload !== "object") return false;

  if (payload["authExpired"] === true) return true;

  const message = String(
    payload["message"] || payload["error"] || payload["debug"] || ""
  ).toLowerCase();

  return (
    message.includes("token") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("sessiya")
  );
}

async function handleExpiredSession() {
  if (typeof window === "undefined" || redirecting) return;
  redirecting = true;

  try {
    sessionStorage.setItem(
      "login_toast",
      JSON.stringify({
        title: "Sessiya tugadi",
        desc: "Token eskirdi. Qayta login qiling.",
      })
    );
  } catch {}

  try {
    await logout();
  } catch {}

  try {
    sessionStorage.removeItem("monitor_session");
    localStorage.removeItem("monitor_session_persist");
  } catch {}

  window.location.replace("/login?expired=1");
}

import { TOKEN_KEY } from "@/lib/auth";

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const token = getStoredToken();

  const res = await fetch(input, {
    credentials: "include",
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });

  if (getAuthHeader(res)) {
    await handleExpiredSession();
    throw new Error("Sessiya tugadi. Qayta login qiling.");
  }

  if (res.status === 401 || res.status === 403) {
    const payload = await readJsonSafe(res);
    if (looksLikeAuthPayload(payload)) {
      await handleExpiredSession();
      throw new Error("Sessiya tugadi. Qayta login qiling.");
    }
  }

  return res;
}
