/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
  if (!unitId) return NextResponse.json({ ok: false, error: "unitId kerak" });

  try {
    const base  = process.env.SMARTGPS_BASE!;
    const token = process.env.SMARTGPS_TOKEN!;

    // Login
    const loginBody = new URLSearchParams();
    loginBody.set("params", JSON.stringify({ token }));
    const login = await post(`${base}/wialon/ajax.html?svc=token/login`, loginBody);
    const sid = login?.eid || login?.sid;
    if (!sid) return NextResponse.json({ ok: false, error: "Login failed" }, { status: 401 });

    const now = Math.floor(Date.now() / 1000);
    const DAY = 86400;

    // Batch: 7 days (today + last 6 days)
    const batchItems = Array.from({ length: 7 }, (_, i) => {
      const to   = now - i * DAY;
      const from = to  - DAY;
      return {
        svc: "messages/load_interval",
        params: { itemId: unitId, timeFrom: from, timeTo: to, flags: 1, flagsMask: 1, loadCount: 10000 },
      };
    });

    const batchBody = new URLSearchParams();
    batchBody.set("sid", sid);
    batchBody.set("params", JSON.stringify(batchItems));
    const batchData = await post(`${base}/wialon/ajax.html?svc=core/batch`, batchBody);
    const results: any[] = Array.isArray(batchData) ? batchData : [];

    const TRIP_GAP = 300; // 5 daqiqa to'xtash → yangi trip

    const days = results.map((r: any, i: number) => {
      const msgs: any[] = r?.messages || [];

      let km = 0, maxSpeed = 0, idleSec = 0;
      let wasStopped = true;
      let lastStopTime: number | null = null;

      const tripList: any[] = [];
      let cur: any = null;

      for (let j = 0; j < msgs.length; j++) {
        const m  = msgs[j];
        const p  = m?.pos;
        const pp = j > 0 ? msgs[j - 1]?.pos : null;
        if (!p) continue;

        const spd = Number(p.s ?? 0);
        if (spd > maxSpeed) maxSpeed = spd;

        if (pp) {
          const d = haversineKm(pp.y, pp.x, p.y, p.x);
          if (d < 1) km += d;
        }

        const moving = spd > 1;
        if (moving && wasStopped) {
          const gap = lastStopTime && m.t ? m.t - lastStopTime : TRIP_GAP + 1;
          if (gap > TRIP_GAP) {
            if (cur) tripList.push(cur);
            cur = {
              n: tripList.length + 1,
              startTime: m.t, endTime: m.t,
              km: 0, speedSum: spd, cnt: 1, maxSpeed: spd,
            };
          }
          wasStopped = false;
          lastStopTime = null;
        } else if (!moving && !wasStopped) {
          wasStopped   = true;
          lastStopTime = m.t ?? null;
          if (cur) { idleSec += 0; } // idle counted separately
        }

        if (cur && moving) {
          cur.endTime = m.t;
          cur.speedSum += spd; cur.cnt++;
          if (spd > cur.maxSpeed) cur.maxSpeed = spd;
          if (pp) { const d = haversineKm(pp.y, pp.x, p.y, p.x); if (d < 1) cur.km += d; }
        }
      }
      if (cur) tripList.push(cur);

      const dayTs = now - i * DAY;
      const isToday = i === 0;

      return {
        date:    new Date(dayTs * 1000).toLocaleDateString("uz-UZ", { weekday: "short", month: "short", day: "numeric" }),
        isToday,
        km:       Math.round(km * 10) / 10,
        trips:    tripList.length,
        idleMin:  Math.round(idleSec / 60),
        maxSpeed: Math.round(maxSpeed),
        tripList: tripList.map(t => ({
          n:           t.n,
          startTime:   t.startTime,
          endTime:     t.endTime,
          km:          Math.round(t.km * 10) / 10,
          avgSpeed:    t.cnt > 0 ? Math.round(t.speedSum / t.cnt) : 0,
          maxSpeed:    Math.round(t.maxSpeed),
          durationMin: t.startTime && t.endTime ? Math.round((t.endTime - t.startTime) / 60) : 0,
        })),
      };
    }).reverse();

    return NextResponse.json({ ok: true, days });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
