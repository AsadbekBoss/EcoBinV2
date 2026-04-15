/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

const OFFLINE_AFTER_SEC = 300; // 5 daqiqa signal yo'q → offline

async function safeJson(r: Response) {
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function loginToken(base: string, token: string) {
  const body = new URLSearchParams();
  body.set("params", JSON.stringify({ token }));
  const r = await fetch(`${base}/wialon/ajax.html?svc=token/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return safeJson(r);
}

async function wialonCall(base: string, sid: string, svc: string, params: any) {
  const body = new URLSearchParams();
  body.set("sid", sid);
  body.set("params", JSON.stringify(params));
  const r = await fetch(`${base}/wialon/ajax.html?svc=${svc}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return safeJson(r);
}

export async function GET() {
  try {
    const base  = process.env.SMARTGPS_BASE!;
    const token = process.env.SMARTGPS_TOKEN!;

    // 1) Login
    const loginData = await loginToken(base, token);
    const sid = loginData?.eid || loginData?.sid;
    if (!sid || loginData?.error) {
      return NextResponse.json({ ok: false, error: "Login failed" }, { status: 401 });
    }

    // 2) Barcha unitlarni olish (flags: 1025 = basic info + last pos)
    const unitsData = await wialonCall(base, sid, "core/search_items", {
      spec: {
        itemsType: "avl_unit",
        propName:  "sys_name",
        propValueMask: "*",
        sortType: "sys_name",
      },
      force: 1,
      flags: 1025,
      from: 0,
      to: 0,
    });

    const items: any[] = Array.isArray(unitsData?.items) ? unitsData.items : [];
    const nowSec = Math.floor(Date.now() / 1000);

    // 3) Har bir unit uchun status hisobla
    const cars = items
      .map((u: any) => {
        const p = u?.pos || u?.lmsg?.pos;
        if (!p) return null;

        const timeSec: number | null = u?.lmsg?.t ?? null;
        const speed    = Number(p?.s ?? 0);
        const mileage  =
          u?.mileage ?? u?.lmsg?.mileage ??
          u?.lmsg?.p?.mileage ?? u?.lmsg?.p?.odometer ?? null;

        const offline  = !timeSec || (nowSec - timeSec) > OFFLINE_AFTER_SEC;
        const moving   = !offline && speed > 1;
        const status   = offline ? "offline" : moving ? "moving" : "stopped";

        return {
          id:      Number(u?.id),
          name:    String(u?.nm ?? `CAR-${u?.id}`),
          lat:     Number(p?.y),
          lng:     Number(p?.x),
          speed,
          time:    timeSec,
          mileage: mileage == null ? null : Number(mileage),
          status,
        };
      })
      .filter((c: any) => c && Number.isFinite(c.id) && Number.isFinite(c.lat));

    // 4) Agregat statistika
    const total   = cars.length;
    const moving  = cars.filter((c: any) => c.status === "moving").length;
    const stopped = cars.filter((c: any) => c.status === "stopped").length;
    const offline = cars.filter((c: any) => c.status === "offline").length;

    const movingCars = cars.filter((c: any) => c.status === "moving");
    const avgSpeed   = movingCars.length
      ? Math.round(movingCars.reduce((s: number, c: any) => s + c.speed, 0) / movingCars.length)
      : 0;

    const maxSpeedCar = cars.reduce(
      (best: any, c: any) => (!best || c.speed > best.speed ? c : best),
      null
    );

    const totalMileage = cars
      .filter((c: any) => c.mileage != null)
      .reduce((s: number, c: any) => s + c.mileage, 0);

    // Eng uzoq offline turgan mashina
    const longestOffline = cars
      .filter((c: any) => c.status === "offline" && c.time)
      .sort((a: any, b: any) => a.time - b.time)[0] ?? null;

    return NextResponse.json({
      ok: true,
      updatedAt: nowSec,
      stats: {
        total,
        moving,
        stopped,
        offline,
        avgSpeed,
        maxSpeed: maxSpeedCar ? { name: maxSpeedCar.name, speed: Math.round(maxSpeedCar.speed) } : null,
        totalMileage: Math.round(totalMileage),
        onlineRate: total > 0 ? Math.round(((moving + stopped) / total) * 100) : 0,
        longestOffline: longestOffline
          ? { name: longestOffline.name, since: longestOffline.time }
          : null,
      },
      cars,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
