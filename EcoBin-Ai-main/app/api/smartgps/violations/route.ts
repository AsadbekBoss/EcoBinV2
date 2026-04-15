/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

const SPEED_LIMIT = 90;

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

export async function GET() {
  try {
    const base  = process.env.SMARTGPS_BASE!;
    const token = process.env.SMARTGPS_TOKEN!;

    // 1. Login
    const loginBody = new URLSearchParams();
    loginBody.set("params", JSON.stringify({ token }));
    const login = await post(`${base}/wialon/ajax.html?svc=token/login`, loginBody);
    const sid = login?.eid || login?.sid;
    if (!sid) return NextResponse.json({ ok: false, error: "Login failed" }, { status: 401 });

    // 2. Get all units
    const unitsBody = new URLSearchParams();
    unitsBody.set("sid", sid);
    unitsBody.set("params", JSON.stringify({
      spec: { itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
      force: 1, flags: 1, from: 0, to: 0,
    }));
    const unitsData = await post(`${base}/wialon/ajax.html?svc=core/search_items`, unitsBody);
    const units: any[] = Array.isArray(unitsData?.items) ? unitsData.items : [];

    if (units.length === 0) {
      return NextResponse.json({ ok: true, violations: [], limit: SPEED_LIMIT, total: 0 });
    }

    // 3. Today range
    const now        = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400);

    // 4. Batch: one messages/load_interval per unit
    const batchItems = units.map((u: any) => ({
      svc: "messages/load_interval",
      params: {
        itemId:    Number(u.id),
        timeFrom:  todayStart,
        timeTo:    now,
        flags:     1,
        flagsMask: 1,
        loadCount: 2000,
      },
    }));

    const batchBody = new URLSearchParams();
    batchBody.set("sid", sid);
    batchBody.set("params", JSON.stringify(batchItems));
    const batchData = await post(`${base}/wialon/ajax.html?svc=core/batch`, batchBody);
    const results: any[] = Array.isArray(batchData) ? batchData : [];

    // 5. Process each unit
    const violations: any[] = [];

    for (let i = 0; i < units.length; i++) {
      const u    = units[i];
      const msgs: any[] = results[i]?.messages || [];

      let km       = 0;
      let vioCount = 0;
      let maxSpeed = 0;
      const events: any[] = [];

      for (let j = 0; j < msgs.length; j++) {
        const p  = msgs[j]?.pos;
        const pp = j > 0 ? msgs[j - 1]?.pos : null;

        if (p && pp) {
          const d = haversineKm(pp.y, pp.x, p.y, p.x);
          if (d < 1) km += d;
        }

        if (p) {
          const spd = Number(p.s ?? 0);
          if (spd > SPEED_LIMIT) {
            vioCount++;
            if (spd > maxSpeed) maxSpeed = spd;
            if (events.length < 5) {
              events.push({ speed: Math.round(spd), time: msgs[j].t, lat: p.y, lng: p.x });
            }
          }
        }
      }

      if (vioCount > 0) {
        violations.push({
          id:       Number(u.id),
          name:     String(u.nm),
          count:    vioCount,
          maxSpeed: Math.round(maxSpeed),
          kmToday:  Math.round(km * 10) / 10,
          events,
        });
      }
    }

    violations.sort((a, b) => b.count - a.count);

    return NextResponse.json({ ok: true, violations, limit: SPEED_LIMIT, total: units.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
