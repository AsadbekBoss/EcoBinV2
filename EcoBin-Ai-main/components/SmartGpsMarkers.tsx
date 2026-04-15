/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAppShell } from "@/components/ui/AppShellContext";

type Car = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  speed: number;
  time?: number | null;
  mileage?: number | null;
};

declare global {
  interface Window {
    L: any;
    MonitoringApp?: any;
    SmartGPS?: {
      focusCar?: (id: number) => void;
      openCar?: (id: number) => void;
      trackCar24h?: (id: number) => void;
      cars?: any[];
    };
    map?: any;
  }
}

function fmtTime(ts?: number | null) {
  if (!ts) return "—";
  const d = ts > 10_000_000_000 ? new Date(ts) : new Date(ts * 1000);
  return d.toLocaleString("uz-UZ", { hour12: false });
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function degDist(aLat: number, aLng: number, bLat: number, bLng: number) {
  return Math.abs(aLat - bLat) + Math.abs(aLng - bLng);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyKm(unitId: number, mileage?: number | null) {
  if (mileage == null) return null;

  const key = `daily_start_${unitId}_${todayKey()}`;
  let startStr = localStorage.getItem(key);

  if (!startStr) {
    localStorage.setItem(key, String(mileage));
    startStr = String(mileage);
  }

  const start = Number(startStr);
  const diff = mileage - start;
  return diff > 0 ? Number(diff.toFixed(2)) : 0;
}

function escapeHtml(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[ch] || ch;
  });
}

export default function SmartGpsMarkers() {
  const { theme, isMobile } = useAppShell();
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<Car | null>(null);
  const [trackStatus, setTrackStatus] = useState<"idle"|"loading"|"ok"|"empty"|"error">("idle");
  const [trackMsg, setTrackMsg] = useState("");
  const [trackDailyKm, setTrackDailyKm] = useState<number | null>(null);

  // Leaflet
  const layerRef = useRef<any>(null);
  const markersRef = useRef<Map<number, any>>(new Map());

  // Direction (bearing degrees, 0=North) per car id
  const headingRef = useRef<Map<number, number>>(new Map());

  // Data cache
  const lastGoodCarsRef = useRef<Map<number, Car>>(new Map());
  const lastSeenAtRef = useRef<Map<number, number>>(new Map());
  const failStreakRef = useRef(0);

  // Timers
  const pollTimerRef = useRef<any>(null);

  // Track
  const trackLayerRef = useRef<any>(null); // dedicated layer group — always on map
  const trackDrawingRef = useRef(false);

  // Drag
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(null);
  const dragState = useRef({ active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 });
  const touchStartY = useRef(0);

  // Animation
  const animRef = useRef<
    Map<
      number,
      { from: [number, number]; to: [number, number]; t0: number; dur: number }
    >
  >(new Map());
  const rafRef = useRef<number | null>(null);

  // Focused car highlight
  const focusMarkerRef = useRef<any>(null);
  const focusPopupRef = useRef<any>(null);
  const focusTimerRef = useRef<any>(null);

  const POLL_MS = 5000;
  const ANIM_MS = 900;
  const OFFLINE_AFTER_SEC = 120;
  const REMOVE_AFTER_MS = 90_000;
  const FAR_JUMP_DEG = 0.02;

  function ensureFocusStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById("smartgps-focus-style")) return;

    const style = document.createElement("style");
    style.id = "smartgps-focus-style";
    style.textContent = `
      .smartgpsFocusWrap{
        background: transparent !important;
        border: none !important;
      }

      .smartgpsFocusDot{
        position: relative;
        width: 30px;
        height: 30px;
        border-radius: 999px;
        background: #f59e0b;
        border: 4px solid #ffffff;
        box-shadow:
          0 0 0 6px rgba(245,158,11,.22),
          0 12px 26px rgba(0,0,0,.24);
      }

      .smartgpsFocusDot::after{
        content: "";
        position: absolute;
        inset: -10px;
        border-radius: 999px;
        border: 2px solid rgba(245,158,11,.55);
        animation: smartgpsPulse 1.15s ease-out infinite;
      }

      @keyframes smartgpsPulse{
        from{
          transform: scale(.72);
          opacity: .95;
        }
        to{
          transform: scale(1.65);
          opacity: 0;
        }
      }

      .smartgpsFocusPopup .leaflet-popup-content-wrapper{
        border-radius: 14px;
        padding: 0;
        box-shadow: 0 16px 36px rgba(15,23,42,.18);
      }

      .smartgpsFocusPopup .leaflet-popup-content{
        margin: 0;
      }

      .smartgpsFocusPopupInner{
        padding: 10px 12px;
        min-width: 170px;
      }

      .smartgpsFocusPopupInner b{
        display: block;
        font-size: 13px;
        color: #0f172a;
        margin-bottom: 3px;
      }

      .smartgpsFocusPopupInner span{
        display: block;
        font-size: 11px;
        color: #64748b;
      }
    `;
    document.head.appendChild(style);
  }

  /** Ikki GPS nuqta o'rtasidagi yo'nalish (0=North, 90=East, 180=South, 270=West) */
  function calcBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const lat1R = lat1 * Math.PI / 180;
    const lat2R = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2R);
    const x = Math.cos(lat1R) * Math.sin(lat2R) - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  /** Mashina ikonkasi — harakatlanayotgan bo'lsa yo'nalish strelkasi bilan */
  function makeCarIcon(speed: number, heading: number) {
    const L = window.L;
    const moving = speed > 3;

    // Strelka rangi tezlikka qarab
    const arrowColor = speed > 90 ? "#ef4444"
      : speed > 60 ? "#f59e0b"
      : speed > 20 ? "#22c55e"
      : "#3b82f6";

    const arrowSvg = moving ? `
      <div style="
        position:absolute;top:50%;left:50%;
        transform:translate(-50%,-50%) rotate(${heading}deg);
        width:54px;height:54px;
        pointer-events:none;
      ">
        <svg width="54" height="54" viewBox="0 0 54 54" fill="none">
          <!-- strelka uchi — markazdan 30px yuqorida -->
          <polygon points="27,4 22,16 27,13 32,16"
            fill="${arrowColor}" opacity="0.96"
            filter="drop-shadow(0 1px 2px rgba(0,0,0,.40))"
          />
        </svg>
      </div>` : "";

    return L.divIcon({
      className: "",
      html: `
        <div style="position:relative;width:54px;height:54px;">
          ${arrowSvg}
          <div style="
            position:absolute;top:50%;left:50%;
            transform:translate(-50%,-50%);
            width:34px;height:34px;border-radius:14px;
            display:grid;place-items:center;
            background:${moving ? "rgba(37,99,235,.22)" : "rgba(100,116,139,.18)"};
            border:1px solid rgba(255,255,255,.70);
            box-shadow:0 10px 24px rgba(0,0,0,.28);
            backdrop-filter:blur(6px);
          ">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M3 7h11v9H3V7Z" stroke="white" stroke-width="1.6" opacity=".95"/>
              <path d="M14 10h4l3 3v3h-7v-6Z" stroke="white" stroke-width="1.6" opacity=".95"/>
              <path d="M7 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" fill="white"/>
              <path d="M18 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" fill="white"/>
            </svg>
          </div>
        </div>`,
      iconSize: [54, 54],
      iconAnchor: [27, 27],
    });
  }

  const getCarIcon = () => makeCarIcon(0, 0);

  async function waitForMap(timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const L = window?.L;
      const map = window?.MonitoringApp?.map || window?.map;
      if (L && map) return { L, map };
      await new Promise((r) => setTimeout(r, 120));
    }
    return null;
  }

  function normalizeTimeSeconds(ts?: number | null) {
    if (!ts) return null;
    return ts > 10_000_000_000 ? Math.floor(ts / 1000) : Math.floor(ts);
  }

  function isOfflineByTime(ts?: number | null) {
    const tSec = normalizeTimeSeconds(ts);
    if (!tSec) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - tSec > OFFLINE_AFTER_SEC;
  }

  function normalizeIncomingCar(raw: any): Car | null {
    if (!raw) return null;

    const car: Car = {
      id: Number(raw?.id),
      name: String(raw?.name ?? raw?.title ?? `CAR-${raw?.id ?? "?"}`),
      lat: Number(raw?.lat),
      lng: Number(raw?.lng),
      speed: Number(raw?.speed ?? 0),
      time: raw?.time == null ? null : Number(raw.time),
      mileage: raw?.mileage == null ? null : Number(raw.mileage),
    };

    if (
      !Number.isFinite(car.id) ||
      !Number.isFinite(car.lat) ||
      !Number.isFinite(car.lng)
    ) {
      return null;
    }

    return car;
  }

  function carFromDetail(detail: any): Car | null {
    const id = Number(detail?.id);
    if (Number.isFinite(id)) {
      const cached = lastGoodCarsRef.current.get(id);
      if (cached) return cached;
    }

    const byCar = normalizeIncomingCar(detail?.car);
    if (byCar) return byCar;

    const byDetail = normalizeIncomingCar(detail);
    if (byDetail) return byDetail;

    return null;
  }

  function syncSmartGPSApi() {
    if (typeof window === "undefined") return;

    if (!window.SmartGPS) window.SmartGPS = {};

    window.SmartGPS.cars = Array.from(lastGoodCarsRef.current.values());

    window.SmartGPS.focusCar = async (id: number) => {
      setVisible(true);

      let car = lastGoodCarsRef.current.get(Number(id));
      if (!car) {
        await drawCarsOnce();
        car = lastGoodCarsRef.current.get(Number(id));
      }

      if (car) {
        await highlightCarOnMap(car);
      }
    };

    window.SmartGPS.openCar = async (id: number) => {
      setVisible(true);

      let car = lastGoodCarsRef.current.get(Number(id));
      if (!car) {
        await drawCarsOnce();
        car = lastGoodCarsRef.current.get(Number(id));
      }

      if (car) {
        setActive(car);
        await highlightCarOnMap(car);
      }
    };

    window.SmartGPS.trackCar24h = async (id: number) => {
      setVisible(true);
      await drawTrack24h(Number(id));
    };
  }

  async function fetchCarsRobust(): Promise<Car[] | null> {
    try {
      const res = await apiFetch("/api/smartgps/units", { cache: "no-store" });
      if (!res.ok) {
        failStreakRef.current += 1;
        console.warn("SmartGPS units res not ok:", res.status);
        return null;
      }

      const data = await res.json();

      const carsCandidate =
        data?.cars ?? data?.units ?? data?.items ?? data?.data?.cars ?? null;

      if (!Array.isArray(carsCandidate)) {
        failStreakRef.current += 1;
        console.warn("SmartGPS units JSON format unexpected:", data);
        return null;
      }

      const cleaned: Car[] = carsCandidate
        .map((c: any) => ({
          mileage: c?.mileage == null ? null : Number(c.mileage),
          id: Number(c?.id),
          name: String(c?.name ?? c?.title ?? `CAR-${c?.id ?? "?"}`),
          lat: Number(c?.lat),
          lng: Number(c?.lng),
          speed: Number(c?.speed ?? 0),
          time:
            c?.time === undefined || c?.time === null ? null : Number(c.time),
        }))
        .filter(
          (c: Car) =>
            Number.isFinite(c.id) &&
            Number.isFinite(c.lat) &&
            Number.isFinite(c.lng)
        );

      if (cleaned.length === 0) {
        failStreakRef.current += 1;
        console.warn("SmartGPS units 200 but empty cars[]");
        return null;
      }

      failStreakRef.current = 0;
      return cleaned;
    } catch (e) {
      failStreakRef.current += 1;
      console.warn("SmartGPS units fetch error:", e);
      return null;
    }
  }

  function clearTrack() {
    try { trackLayerRef.current?.clearLayers?.(); } catch {}
  }

  // Haversine — ikki GPS nuqta orasidagi masofa (km)
  function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Tezlikka qarab rang qaytaradi
  function speedColor(kmh: number): string {
    if (kmh < 5)  return "#94a3b8"; // kulrang  — to'xtagan
    if (kmh < 30) return "#3b82f6"; // ko'k     — sekin
    if (kmh < 60) return "#22c55e"; // yashil   — normal
    if (kmh < 90) return "#f59e0b"; // sariq    — tez
    return "#ef4444";               // qizil    — juda tez
  }

  async function drawTrack24h(unitId: number) {
    if (trackDrawingRef.current) return;
    trackDrawingRef.current = true;
    setTrackStatus("loading");
    setTrackMsg("");

    const ctx = await waitForMap();
    if (!ctx) {
      setTrackStatus("error");
      setTrackMsg("Xarita topilmadi");
      trackDrawingRef.current = false;
      return;
    }
    const { L, map } = ctx;

    if (!trackLayerRef.current) {
      trackLayerRef.current = L.layerGroup().addTo(map);
    } else if (!map.hasLayer(trackLayerRef.current)) {
      trackLayerRef.current.addTo(map);
    }

    try {
      const res = await apiFetch(`/api/smartgps/track?unitId=${unitId}`, { cache: "no-store" });

      if (!res.ok) {
        setTrackStatus("error");
        setTrackMsg(`Server xato: ${res.status}`);
        trackDrawingRef.current = false;
        return;
      }

      const data = await res.json();

      // Barcha nuqtalar (masofa hisoblash uchun)
      const allPts = (data?.points || [])
        .filter((p: any) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))
        .map((p: any) => ({
          lat:   Number(p.lat),
          lng:   Number(p.lng),
          speed: Number(p.speed ?? 0),
          time:  p.time ?? null,
        }));

      // Har 2-nuqtani olish (xarita uchun performance)
      const pts: { lat: number; lng: number; speed: number; time: number | null }[] =
        allPts.filter((_: any, i: number) => i % 2 === 0);

      if (!pts.length) {
        setTrackStatus("empty");
        setTrackMsg(`Ma'lumot yo'q (${allPts.length} nuqta keldi)`);
        setTrackDailyKm(null);
        trackDrawingRef.current = false;
        return;
      }

      // Bugungi yo'l — barcha nuqtalar bo'yicha Haversine yig'indisi
      let totalKm = 0;
      for (let i = 1; i < allPts.length; i++) {
        const d = haversineKm(
          allPts[i - 1].lat, allPts[i - 1].lng,
          allPts[i].lat,     allPts[i].lng
        );
        // 1 km dan katta "sakrash"larni o'tkazib yuborish (GPS xatosi)
        if (d < 1) totalKm += d;
      }
      setTrackDailyKm(Math.round(totalKm * 10) / 10);

      clearTrack();

      // ── Tezlikka qarab rangli segmentlar ──
      // Ketma-ket bir xil rangli nuqtalarni bitta polyline ga birlashtirish
      let segColor  = speedColor(pts[0].speed);
      let segCoords: [number, number][] = [[pts[0].lat, pts[0].lng]];
      let allCoords: [number, number][] = [[pts[0].lat, pts[0].lng]];

      const flushSeg = (nextCoord?: [number, number]) => {
        if (segCoords.length >= 2) {
          L.polyline(segCoords, {
            color: segColor,
            weight: 5,
            opacity: 0.92,
            smoothFactor: 1,
          }).addTo(trackLayerRef.current);
        }
        if (nextCoord) segCoords = [segCoords[segCoords.length - 1], nextCoord];
        else segCoords = [];
      };

      for (let i = 1; i < pts.length; i++) {
        const coord: [number, number] = [pts[i].lat, pts[i].lng];
        const col = speedColor(pts[i].speed);
        allCoords.push(coord);

        if (col !== segColor) {
          flushSeg(coord);
          segColor = col;
        } else {
          segCoords.push(coord);
        }
      }
      flushSeg(); // oxirgi segment

      // ── Har ~20-nuqtada tezlik markeri (hover tooltip) ──
      const step = Math.max(1, Math.floor(pts.length / 80));
      for (let i = 0; i < pts.length; i += step) {
        const pt = pts[i];
        const col = speedColor(pt.speed);

        // Vaqtni formatlash
        let timeStr = "";
        if (pt.time) {
          const d = pt.time > 10_000_000_000 ? new Date(pt.time) : new Date(pt.time * 1000);
          timeStr = d.toLocaleTimeString("uz-UZ", { hour12: false, hour: "2-digit", minute: "2-digit" });
        }

        const marker = L.circleMarker([pt.lat, pt.lng], {
          radius:      5,
          color:       "#ffffff",
          weight:      2,
          fillColor:   col,
          fillOpacity: 1,
        });

        marker.bindTooltip(
          `<div style="font-family:sans-serif;font-size:13px;font-weight:700;line-height:1.5;padding:2px 4px">
            <span style="color:${col}">●</span> <b>${Math.round(pt.speed)} km/h</b>
            ${timeStr ? `<br/><span style="font-size:11px;color:#64748b">${timeStr}</span>` : ""}
          </div>`,
          { direction: "top", sticky: false, opacity: 0.97 }
        );

        marker.addTo(trackLayerRef.current);
      }

      // Xaritani track bo'yicha moslashtirish
      try {
        const bounds = L.latLngBounds(allCoords);
        map.fitBounds(bounds, { padding: [40, 40] });
      } catch {}

      const maxSpd = Math.round(Math.max(...pts.map(p => p.speed)));
      setTrackStatus("ok");
      setTrackMsg(`${pts.length} nuqta • maks ${maxSpd} km/h`);
    } catch (e) {
      setTrackStatus("error");
      setTrackMsg(e instanceof Error ? e.message : "Noma'lum xato");
    } finally {
      trackDrawingRef.current = false;
    }
  }

  function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
  }

  function easeInOut(t: number) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function startRafLoop() {
    if (rafRef.current) return;

    const tick = () => {
      const now = performance.now();

      for (const [id, anim] of animRef.current.entries()) {
        const m = markersRef.current.get(id);
        if (!m) {
          animRef.current.delete(id);
          continue;
        }

        const p = clamp((now - anim.t0) / anim.dur, 0, 1);
        const e = easeInOut(p);

        const lat = lerp(anim.from[0], anim.to[0], e);
        const lng = lerp(anim.from[1], anim.to[1], e);
        m.setLatLng([lat, lng]);

        if (p >= 1) animRef.current.delete(id);
      }

      if (animRef.current.size > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  function animateMarkerTo(
    id: number,
    from: [number, number],
    to: [number, number],
    dur = ANIM_MS
  ) {
    animRef.current.set(id, { from, to, t0: performance.now(), dur });
    startRafLoop();
  }

  async function clearFocusedCar() {
    const ctx = await waitForMap(500);
    const map = ctx?.map;

    try {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    } catch {}

    try {
      if (focusMarkerRef.current && map && map.hasLayer(focusMarkerRef.current)) {
        map.removeLayer(focusMarkerRef.current);
      }
    } catch {}
    focusMarkerRef.current = null;

    try {
      if (focusPopupRef.current && map) {
        map.closePopup(focusPopupRef.current);
      }
    } catch {}
    focusPopupRef.current = null;
  }

  async function highlightCarOnMap(car: Car) {
    const ctx = await waitForMap();
    if (!ctx) return;

    const { L, map } = ctx;
    ensureFocusStyles();
    await clearFocusedCar();

    map.flyTo([car.lat, car.lng], Math.max(map.getZoom(), 16), {
      animate: true,
      duration: 0.8,
    });

    focusMarkerRef.current = L.marker([car.lat, car.lng], {
      interactive: false,
      zIndexOffset: 9000,
      icon: L.divIcon({
        className: "smartgpsFocusWrap",
        html: `<div class="smartgpsFocusDot"></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
    }).addTo(map);

    const offline = isOfflineByTime(car.time ?? null);
    const stateText = offline
      ? "OFFLINE"
      : Math.round(car.speed || 0) > 2
      ? "HARAKATDA"
      : "TO‘XTAGAN";

    focusPopupRef.current = L.popup({
      closeButton: false,
      autoClose: true,
      closeOnClick: true,
      offset: [0, -18],
      className: "smartgpsFocusPopup",
    })
      .setLatLng([car.lat, car.lng])
      .setContent(`
        <div class="smartgpsFocusPopupInner">
          <b>${escapeHtml(car.name)}</b>
          <span>${Math.round(car.speed || 0)} km/soat • ${escapeHtml(stateText)}</span>
        </div>
      `);

    focusPopupRef.current.openOn(map);

    focusTimerRef.current = setTimeout(() => {
      clearFocusedCar();
    }, 5000);
  }

  function clearCarsLayer() {
    try {
      layerRef.current?.clearLayers?.();
    } catch {}
    markersRef.current.clear();
    lastSeenAtRef.current.clear();
    lastGoodCarsRef.current.clear();
    headingRef.current.clear();
    animRef.current.clear();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  async function drawCarsOnce() {
    const ctx = await waitForMap();
    if (!ctx) return;

    const { L, map } = ctx;
    if (!layerRef.current) layerRef.current = L.layerGroup().addTo(map);

    const carsFresh = await fetchCarsRobust();

    const cars: Car[] = carsFresh ?? Array.from(lastGoodCarsRef.current.values());
    if (!cars.length) return;

    if (carsFresh) {
      lastGoodCarsRef.current.clear();
      carsFresh.forEach((c) => lastGoodCarsRef.current.set(c.id, c));
      syncSmartGPSApi();
    }

    const now = performance.now();

    for (const c of cars) {
      let m = markersRef.current.get(c.id);

      lastSeenAtRef.current.set(c.id, now);

      const currentHeading = headingRef.current.get(c.id) ?? 0;

      if (!m) {
        const icon = makeCarIcon(c.speed, currentHeading);
        m = L.marker([c.lat, c.lng], { icon, zIndexOffset: 5000 });

        m.on("click", async () => {
          const latest = lastGoodCarsRef.current.get(c.id) ?? c;
          setActive(latest);
          await highlightCarOnMap(latest);
          await drawTrack24h(latest.id);
        });

        m.addTo(layerRef.current);
        markersRef.current.set(c.id, m);
      } else {
        const prev = m.getLatLng();
        const jump = degDist(prev.lat, prev.lng, c.lat, c.lng);

        // Yangi yo'nalishni hisoblash (faqat sezilarli siljish bo'lsa)
        let newHeading = currentHeading;
        if (jump > 0.00005 && c.speed > 3) {
          newHeading = calcBearing(prev.lat, prev.lng, c.lat, c.lng);
          headingRef.current.set(c.id, newHeading);
        }

        // Marker ikonini yangilash (yo'nalish yoki tezlik o'zgarsa)
        m.setIcon(makeCarIcon(c.speed, newHeading));

        if (jump > FAR_JUMP_DEG || !carsFresh) {
          m.setLatLng([c.lat, c.lng]);
        } else {
          animateMarkerTo(c.id, [prev.lat, prev.lng], [c.lat, c.lng], ANIM_MS);
        }

        m.off("click");
        m.on("click", async () => {
          const latest = lastGoodCarsRef.current.get(c.id) ?? c;
          setActive(latest);
          await highlightCarOnMap(latest);
          await drawTrack24h(latest.id);
        });
      }
    }

    for (const [id, marker] of markersRef.current.entries()) {
      const lastSeen = lastSeenAtRef.current.get(id) ?? 0;
      if (now - lastSeen > REMOVE_AFTER_MS) {
        try {
          layerRef.current.removeLayer(marker);
        } catch {}
        markersRef.current.delete(id);
        lastSeenAtRef.current.delete(id);
        lastGoodCarsRef.current.delete(id);
        animRef.current.delete(id);
      }
    }

    syncSmartGPSApi();
  }

  useEffect(() => {
    ensureFocusStyles();
    syncSmartGPSApi();
  }, []);

  useEffect(() => {
    const onToggle = () => setVisible((v) => !v);
    window.addEventListener("smartgps:toggle", onToggle);
    return () => window.removeEventListener("smartgps:toggle", onToggle);
  }, []);

  useEffect(() => {
    const onFocus = async (e: any) => {
      const car = carFromDetail(e?.detail);
      if (!car) return;

      setVisible(true);
      await highlightCarOnMap(car);
    };

    const onOpen = async (e: any) => {
      const car = carFromDetail(e?.detail);
      if (!car) return;

      setVisible(true);
      setActive(car);
      await highlightCarOnMap(car);
      await drawTrack24h(car.id);
    };

    const onTrack = async (e: any) => {
      const id = Number(e?.detail?.id);
      if (!Number.isFinite(id)) return;
      setVisible(true);
      await drawTrack24h(id);
    };

    const onHighlight = async (e: any) => {
      const car = carFromDetail(e?.detail);
      if (!car) return;

      setVisible(true);
      await highlightCarOnMap(car);
    };

    window.addEventListener("smartgps:focus", onFocus as any);
    window.addEventListener("smartgps:open", onOpen as any);
    window.addEventListener("smartgps:track24h", onTrack as any);
    window.addEventListener("smartgps:highlight", onHighlight as any);

    return () => {
      window.removeEventListener("smartgps:focus", onFocus as any);
      window.removeEventListener("smartgps:open", onOpen as any);
      window.removeEventListener("smartgps:track24h", onTrack as any);
      window.removeEventListener("smartgps:highlight", onHighlight as any);
    };
  }, []);

  useEffect(() => {
    (async () => {
      if (!visible) {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        clearTrack();
        await clearFocusedCar();
        clearCarsLayer();
        return;
      }

      await drawCarsOnce();

      pollTimerRef.current = setInterval(() => {
        drawCarsOnce().catch(() => {});
      }, POLL_MS);
    })();

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [visible]);

  useEffect(() => {
    // Tanlangan mashina tashqarisidagilarni yashir/ko'rsat
    for (const [id, marker] of markersRef.current.entries()) {
      const el = marker.getElement?.();
      if (!el) continue;
      el.style.display = active && id !== active.id ? "none" : "";
    }
  }, [active]);

  // Modal yopilganda track o'chadi — bu funksiya close tugmasidan chaqiriladi
  function closeModal() {
    setActive(null);
    clearTrack();
    setTrackStatus("idle");
    setTrackMsg("");
    setTrackDailyKm(null);
    setDragPos(null);
  }

  // Drag handlers
  function onDragStart(e: React.MouseEvent<HTMLDivElement>) {
    const el = (e.currentTarget as HTMLElement).closest("[data-modal-panel]") as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragState.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    };
    e.preventDefault();

    function onMove(ev: MouseEvent) {
      if (!dragState.current.active) return;
      const dx = ev.clientX - dragState.current.startX;
      const dy = ev.clientY - dragState.current.startY;
      const left = Math.max(0, Math.min(window.innerWidth - 340, dragState.current.startLeft + dx));
      const top = Math.max(0, Math.min(window.innerHeight - 80, dragState.current.startTop + dy));
      setDragPos({ left, top });
    }

    function onUp() {
      dragState.current.active = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearTrack();
      clearFocusedCar();
      clearCarsLayer();
    };
  }, []);

  const activeOffline = active ? isOfflineByTime(active.time ?? null) : false;
  const activeSpeed = active ? Math.round(active.speed || 0) : 0;
  const activeStateText = !active
    ? ""
    : activeOffline
    ? "OFFLINE"
    : activeSpeed > 2
    ? "HARAKATDA"
    : "TO‘XTAGAN";

  const isDark = theme === "dark";
  const modalSurface = isDark ? "rgba(15,27,47,.96)" : "rgba(255,255,255,.96)";
  const modalBorder = isDark ? "1px solid rgba(255,255,255,.10)" : "1px solid rgba(255,255,255,.6)";
  const modalText = isDark ? "#edf4ff" : "#0f172a";
  const modalMuted = isDark ? "#9aa9c2" : "#475569";
  const headerBg = isDark
    ? "linear-gradient(90deg, rgba(37,99,235,.20), rgba(16,185,129,.16))"
    : "linear-gradient(90deg, rgba(37,99,235,.12), rgba(34,197,94,.10))";
  const softPanel = isDark ? "rgba(18,33,58,.94)" : "rgba(15,23,42,.06)";
  const strongPanel = isDark ? "rgba(18,33,58,.98)" : "#ffffff";
  const buttonText = isDark ? "#edf4ff" : "#0f172a";

  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        width: "100%",
        background: modalSurface,
        color: modalText,
        borderRadius: "20px 20px 0 0",
        boxShadow: "0 -8px 40px rgba(0,0,0,.28)",
        border: modalBorder,
        backdropFilter: "blur(18px)",
        overflow: "hidden",
      }
    : {
        position: "fixed",
        ...(dragPos
          ? { left: dragPos.left, top: dragPos.top }
          : { bottom: 24, right: 24 }),
        zIndex: 9999,
        width: 340,
        background: modalSurface,
        color: modalText,
        borderRadius: 18,
        boxShadow: "0 8px 40px rgba(0,0,0,.32)",
        border: modalBorder,
        backdropFilter: "blur(14px)",
        overflow: "hidden",
      };

  const cardStyle: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    background: isDark ? "rgba(255,255,255,.05)" : "rgba(15,23,42,.04)",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "7px 10px",
    borderRadius: 10,
    background: isDark ? "rgba(255,255,255,.05)" : "rgba(15,23,42,.04)",
  };

  return (
    <>
      {active && (
        <div data-modal-panel="true" style={panelStyle}>

          {/* Mobile: drag pill + swipe to close */}
          {isMobile && (
            <div
              onTouchStart={(e) => { touchStartY.current = e.touches[0].clientY; }}
              onTouchEnd={(e) => {
                const dy = e.changedTouches[0].clientY - touchStartY.current;
                if (dy > 72) closeModal();
              }}
              style={{ display: "flex", justifyContent: "center", padding: "10px 0 4px" }}
            >
              <div style={{
                width: 40, height: 4, borderRadius: 4,
                background: isDark ? "rgba(255,255,255,.22)" : "rgba(15,23,42,.18)",
              }} />
            </div>
          )}

          {/* Header */}
          <div
            onMouseDown={isMobile ? undefined : onDragStart}
            style={{
              padding: isMobile ? "10px 16px 12px" : "13px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              background: headerBg,
              borderBottom: isDark ? "1px solid rgba(255,255,255,.08)" : "1px solid rgba(15,23,42,.06)",
              cursor: isMobile ? "default" : "grab",
              userSelect: "none",
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontWeight: 900,
                fontSize: isMobile ? 17 : 15,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: modalText,
              }}>
                {active.name}
              </div>
              <div style={{ fontSize: 12, color: modalMuted, marginTop: 2 }}>
                ID: {active.id}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <div style={{
                padding: "5px 10px",
                borderRadius: 999,
                fontWeight: 800,
                fontSize: 11,
                color: activeOffline ? "#fca5a5" : activeSpeed > 2 ? "#6ee7b7" : isDark ? "#cbd5e1" : "#334155",
                background: activeOffline
                  ? (isDark ? "rgba(239,68,68,.18)" : "rgba(239,68,68,.14)")
                  : activeSpeed > 2
                  ? (isDark ? "rgba(34,197,94,.18)" : "rgba(34,197,94,.14)")
                  : (isDark ? "rgba(148,163,184,.16)" : "rgba(15,23,42,.08)"),
                border: isDark ? "1px solid rgba(255,255,255,.10)" : "1px solid rgba(15,23,42,.10)",
              }}>
                {activeStateText}
              </div>

              <button
                onClick={() => closeModal()}
                style={{
                  width: 34, height: 34,
                  borderRadius: 10,
                  border: isDark ? "1px solid rgba(255,255,255,.10)" : "1px solid rgba(15,23,42,.12)",
                  background: strongPanel,
                  color: buttonText,
                  cursor: "pointer",
                  fontSize: 16,
                  display: "grid",
                  placeItems: "center",
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Info rows */}
          <div style={{ padding: isMobile ? "14px 16px" : "12px 14px", display: "grid", gap: 8 }}>
            {/* Top 2 cards: Tezlik + Bugungi yo’l */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={cardStyle}>
                <div style={{ fontSize: 11, color: modalMuted, fontWeight: 600 }}>Tezlik</div>
                <div style={{ fontWeight: 800, fontSize: 15, color: modalText }}>{activeSpeed} km/h</div>
              </div>
              <div style={cardStyle}>
                <div style={{ fontSize: 11, color: modalMuted, fontWeight: 600 }}>Bugungi yo’l</div>
                <div style={{ fontWeight: 800, fontSize: 15, color: modalText }}>
                  {trackDailyKm != null
                    ? `${trackDailyKm} km`
                    : trackStatus === "idle"
                    ? <span style={{ fontSize: 11, color: modalMuted }}>Track bosing</span>
                    : trackStatus === "loading"
                    ? "..."
                    : "—"}
                </div>
              </div>
            </div>

            <div style={rowStyle}>
              <span style={{ fontSize: 12, color: modalMuted, fontWeight: 600 }}>Oxirgi vaqt</span>
              <span style={{ fontWeight: 700, fontSize: 13, color: modalText }}>{fmtTime(active.time ?? null)}</span>
            </div>

            <div style={rowStyle}>
              <span style={{ fontSize: 12, color: modalMuted, fontWeight: 600 }}>Koordinata</span>
              <span style={{ fontWeight: 600, fontSize: 12, color: modalText }}>
                {active.lat.toFixed(5)}, {active.lng.toFixed(5)}
              </span>
            </div>

            {/* Buttons: 2x2 grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginTop: 4,
            }}>
              <button
                onClick={async () => { await highlightCarOnMap(active); }}
                style={{
                  padding: "11px 8px",
                  borderRadius: 12,
                  border: "none",
                  background: "linear-gradient(135deg,#3b82f6,#2563eb)",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: 13,
                }}
              >
                📍 Ko’rsat
              </button>

              <button
                onClick={() => drawTrack24h(active.id)}
                disabled={trackStatus === "loading"}
                style={{
                  padding: "11px 8px",
                  borderRadius: 12,
                  border: isDark ? "1px solid rgba(255,255,255,.12)" : "1px solid rgba(15,23,42,.12)",
                  background: trackStatus === "ok"
                    ? (isDark ? "rgba(239,68,68,.20)" : "rgba(239,68,68,.14)")
                    : trackStatus === "error" || trackStatus === "empty"
                    ? "rgba(239,68,68,.12)"
                    : softPanel,
                  color: buttonText,
                  cursor: trackStatus === "loading" ? "wait" : "pointer",
                  fontWeight: 800,
                  fontSize: 13,
                }}
              >
                {trackStatus === "loading" ? "⏳..." : "🧵 Track"}
              </button>

            </div>

            {trackMsg ? (
              <div style={{
                fontSize: 12,
                padding: "6px 10px",
                borderRadius: 8,
                background: trackStatus === "ok"
                  ? (isDark ? "rgba(255,255,255,.06)" : "rgba(15,23,42,.04)")
                  : trackStatus === "error" || trackStatus === "empty"
                  ? "rgba(239,68,68,.10)"
                  : "rgba(37,99,235,.08)",
                color: trackStatus === "error" || trackStatus === "empty" ? "#dc2626" : modalMuted,
              }}>
                Track: {trackMsg}
              </div>
            ) : null}

            {/* Tezlik legendasi — faqat track chizilganda */}
            {trackStatus === "ok" && (
              <div style={{
                padding: "8px 10px",
                borderRadius: 10,
                background: isDark ? "rgba(255,255,255,.05)" : "rgba(15,23,42,.04)",
                fontSize: 11,
                fontWeight: 700,
              }}>
                <div style={{ color: modalMuted, marginBottom: 5 }}>Tezlik ranglari:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px" }}>
                  {[
                    { color: "#94a3b8", label: "0–5 km/h" },
                    { color: "#3b82f6", label: "5–30 km/h" },
                    { color: "#22c55e", label: "30–60 km/h" },
                    { color: "#f59e0b", label: "60–90 km/h" },
                    { color: "#ef4444", label: "90+ km/h"  },
                  ].map(({ color, label }) => (
                    <span key={label} style={{ display: "flex", alignItems: "center", gap: 4, color: modalText }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0, display: "inline-block" }}/>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {isMobile && <div style={{ height: 8 }} />}
          </div>
        </div>
      )}
    </>
  );
}
