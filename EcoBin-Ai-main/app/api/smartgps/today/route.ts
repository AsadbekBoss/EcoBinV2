/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

const SPEED_LIMIT = 90;
const TRIP_GAP_SEC = 300; // 5 daqiqa to'xtagan → yangi trip

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
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
    const lb = new URLSearchParams();
    lb.set("params", JSON.stringify({ token }));
    const login = await post(`${base}/wialon/ajax.html?svc=token/login`, lb);
    const sid = login?.eid || login?.sid;
    if (!sid) return NextResponse.json({ ok: false, error: "Login failed" }, { status: 401 });

    // 2. Get all units
    const ub = new URLSearchParams();
    ub.set("sid", sid);
    ub.set("params", JSON.stringify({
      spec: { itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
      force: 1, flags: 1, from: 0, to: 0,
    }));
    const ud = await post(`${base}/wialon/ajax.html?svc=core/search_items`, ub);
    const units: any[] = Array.isArray(ud?.items) ? ud.items : [];
    if (units.length === 0) return NextResponse.json({ ok: true, cars: [] });

    // 3. Today range
    const now        = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400);

    // 4. Batch fetch
    const batchItems = units.map((u: any) => ({
      svc: "messages/load_interval",
      params: { itemId: Number(u.id), timeFrom: todayStart, timeTo: now, flags: 1, flagsMask: 1, loadCount: 3000 },
    }));
    const bb = new URLSearchParams();
    bb.set("sid", sid);
    bb.set("params", JSON.stringify(batchItems));
    const bd = await post(`${base}/wialon/ajax.html?svc=core/batch`, bb);
    const results: any[] = Array.isArray(bd) ? bd : [];

    // 5. Process each unit
    const cars: any[] = [];
    for (let i = 0; i < units.length; i++) {
      const u    = units[i];
      const msgs: any[] = results[i]?.messages || [];

      let km = 0, violations = 0, maxSpeed = 0;
      let trips = 0;
      let wasStopped  = true;
      let lastMoveEnd: number | null = null;
      let idleSec = 0;

      const tripList: any[] = [];
      let currentTrip: any = null;

      for (let j = 0; j < msgs.length; j++) {
        const m  = msgs[j];
        const p  = m?.pos;
        const pp = j > 0 ? msgs[j - 1]?.pos : null;
        if (!p) continue;

        const spd = Number(p.s ?? 0);
        if (spd > maxSpeed) maxSpeed = spd;
        if (spd > SPEED_LIMIT) violations++;

        if (pp) {
          const d = haversineKm(pp.y, pp.x, p.y, p.x);
          if (d < 1) km += d;
        }

        const moving = spd > 1;

        // Trip detection
        if (moving && wasStopped) {
          // Check gap since last stop
          const gap = lastMoveEnd && m.t ? m.t - lastMoveEnd : TRIP_GAP_SEC + 1;
          if (gap > TRIP_GAP_SEC) {
            if (currentTrip) {
              idleSec += currentTrip.startTime && m.t ? m.t - currentTrip.endTime : 0;
              tripList.push(currentTrip);
            }
            currentTrip = {
              index:     trips + 1,
              startTime: m.t,
              endTime:   m.t,
              startLat:  p.y, startLng: p.x,
              endLat:    p.y, endLng: p.x,
              km:        0,
              maxSpeed:  spd,
              speedSum:  spd,
              count:     1,
            };
            trips++;
          }
          wasStopped = false;
        } else if (!moving && !wasStopped) {
          wasStopped  = true;
          lastMoveEnd = m.t ?? null;
        }

        if (currentTrip && moving) {
          currentTrip.endTime = m.t;
          currentTrip.endLat  = p.y;
          currentTrip.endLng  = p.x;
          if (spd > currentTrip.maxSpeed) currentTrip.maxSpeed = spd;
          currentTrip.speedSum += spd;
          currentTrip.count++;
          if (pp) {
            const d = haversineKm(pp.y, pp.x, p.y, p.x);
            if (d < 1) currentTrip.km += d;
          }
        }
      }
      if (currentTrip) tripList.push(currentTrip);

      // Finalize trips
      const finalTrips = tripList.map(t => ({
        index:    t.index,
        startTime: t.startTime,
        endTime:   t.endTime,
        km:        Math.round(t.km * 10) / 10,
        avgSpeed:  t.count > 0 ? Math.round(t.speedSum / t.count) : 0,
        maxSpeed:  Math.round(t.maxSpeed),
        durationMin: t.startTime && t.endTime ? Math.round((t.endTime - t.startTime) / 60) : 0,
      }));

      cars.push({
        id:         Number(u.id),
        name:       String(u.nm),
        kmToday:    Math.round(km * 10) / 10,
        trips:      trips,
        violations,
        maxSpeed:   Math.round(maxSpeed),
        idleMin:    Math.round(idleSec / 60),
        tripList:   finalTrips,
      });
    }

    cars.sort((a, b) => b.kmToday - a.kmToday);
    return NextResponse.json({ ok: true, cars });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
