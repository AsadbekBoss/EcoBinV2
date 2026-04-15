/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

async function post(url: string, body: URLSearchParams) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const unitId = Number(searchParams.get("unitId"));
  if (!unitId) return NextResponse.json({ error: "unitId kerak" }, { status: 400 });

  const now   = Math.floor(Date.now() / 1000);
  const from  = Number(searchParams.get("from"))  || now - 86400;
  const to    = Number(searchParams.get("to"))    || now;

  try {
    const base  = process.env.SMARTGPS_BASE!;
    const token = process.env.SMARTGPS_TOKEN!;

    // Login
    const lb = new URLSearchParams();
    lb.set("params", JSON.stringify({ token }));
    const login = await post(`${base}/wialon/ajax.html?svc=token/login`, lb);
    const sid = login?.eid || login?.sid;
    if (!sid) return NextResponse.json({ error: "Login failed" }, { status: 401 });

    // Load messages for the given time range
    const mb = new URLSearchParams();
    mb.set("sid", sid);
    mb.set("params", JSON.stringify({
      itemId: unitId, timeFrom: from, timeTo: to,
      flags: 1, flagsMask: 1, loadCount: 5000,
    }));
    const data = await post(`${base}/wialon/ajax.html?svc=messages/load_interval`, mb);
    const msgs: any[] = data?.messages || [];

    const points = msgs
      .filter((m: any) => m?.pos)
      .map((m: any) => ({
        lat:   m.pos.y,
        lng:   m.pos.x,
        speed: Number(m.pos.s ?? 0),
        time:  m.t ?? null,
      }));

    return NextResponse.json({ ok: true, points });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
