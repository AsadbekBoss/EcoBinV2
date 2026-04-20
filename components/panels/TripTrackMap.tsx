/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import S from "./TripTrackMap.module.css";

interface Props {
  unitId: number;
  from: number;   // unix seconds
  to: number;     // unix seconds
  tripNum: number;
  onClose: () => void;
}

interface Pt { lat: number; lng: number; speed: number; time: number | null; }

/* Speed → colour */
function speedColor(s: number): string {
  if (s < 30)  return "#22c55e";   // green  – slow
  if (s < 60)  return "#f59e0b";   // amber  – normal
  if (s < 90)  return "#f97316";   // orange – fast
  return         "#ef4444";        // red    – overspeed
}

export default function TripTrackMap({ unitId, from, to, tripNum, onClose }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef    = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState("");
  const [stats,   setStats]   = useState<{ km: number; maxSpeed: number; pts: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setLoading(true);
      setErr("");

      // Leaflet yuklanmagan bo'lsa dinamik yuklash
      if (typeof (window as any).L === "undefined") {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector('script[src*="leaflet"]');
          if (existing) { resolve(); return; }
          const s = document.createElement("script");
          s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Leaflet CDN yuklanmadi"));
          document.head.appendChild(s);
        });
      }
      // CSS ham kerak bo'lsa qo'shish
      if (!document.querySelector('link[href*="leaflet"]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      const L = (window as any).L;
      if (!L) { setErr("Leaflet yuklanmadi"); setLoading(false); return; }

      // Fetch track points
      let points: Pt[] = [];
      try {
        const r = await apiFetch(`/proxy/smartgps/track?unitId=${unitId}&from=${from}&to=${to}`, { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || "API xato");
        points = j.points ?? [];
      } catch (e: any) {
        if (!cancelled) { setErr(e.message || "Xatolik"); setLoading(false); }
        return;
      }

      if (cancelled) return;

      if (points.length === 0) {
        setErr("Bu sayohat uchun GPS nuqtalar topilmadi");
        setLoading(false);
        return;
      }

      // Build map
      if (!mapDivRef.current) return;

      // Destroy previous instance
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const map = L.map(mapDivRef.current, { zoomControl: true, attributionControl: false });
      mapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map);

      // Draw coloured polyline segments
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
          color:  speedColor(b.speed),
          weight: 4,
          opacity: 0.85,
        }).addTo(map);
      }

      // Start marker (green)
      const startIcon = L.divIcon({
        className: "",
        html: `<div style="width:14px;height:14px;border-radius:50%;background:#22c55e;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
        iconAnchor: [7, 7],
      });
      // End marker (red)
      const endIcon = L.divIcon({
        className: "",
        html: `<div style="width:14px;height:14px;border-radius:50%;background:#ef4444;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
        iconAnchor: [7, 7],
      });

      const first = points[0];
      const last  = points[points.length - 1];
      L.marker([first.lat, first.lng], { icon: startIcon })
        .bindPopup("Boshlanish").addTo(map);
      L.marker([last.lat,  last.lng],  { icon: endIcon })
        .bindPopup("Tugash").addTo(map);

      // Fit bounds
      const latlngs = points.map(p => [p.lat, p.lng] as [number, number]);
      map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] });

      // Calc rough stats
      let km = 0;
      let maxSpd = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const R = 6371;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const aa =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        const d = R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
        if (d < 1) km += d;
        if (b.speed > maxSpd) maxSpd = b.speed;
      }

      if (!cancelled) {
        setStats({ km: Math.round(km * 10) / 10, maxSpeed: Math.round(maxSpd), pts: points.length });
        setLoading(false);
      }
    }

    init();

    return () => {
      cancelled = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId, from, to]);

  return (
    <div className={S.overlay}>
      <div className={S.panel}>
        {/* Header */}
        <div className={S.hdr}>
          <span className={S.title}>Sayohat #{tripNum} — marshrut</span>
          {stats && (
            <div className={S.statsPills}>
              <span className={S.pill}>{stats.km} km</span>
              <span className={S.pillRed}>{stats.maxSpeed} km/h max</span>
              <span className={S.pillGray}>{stats.pts} nuqta</span>
            </div>
          )}
          <button className={S.closeBtn} onClick={onClose} aria-label="Yopish">✕</button>
        </div>

        {/* Legend */}
        <div className={S.legend}>
          <span className={S.lgItem}><span className={S.lgDot} style={{background:"#22c55e"}}/>&lt;30</span>
          <span className={S.lgItem}><span className={S.lgDot} style={{background:"#f59e0b"}}/>&lt;60</span>
          <span className={S.lgItem}><span className={S.lgDot} style={{background:"#f97316"}}/>&lt;90</span>
          <span className={S.lgItem}><span className={S.lgDot} style={{background:"#ef4444"}}/>90+</span>
          <span className={S.lgSep}/>
          <span className={S.lgItem}><span className={S.lgDotCircle} style={{background:"#22c55e"}}/>Start</span>
          <span className={S.lgItem}><span className={S.lgDotCircle} style={{background:"#ef4444"}}/>Finish</span>
        </div>

        {/* Map area */}
        <div className={S.mapWrap}>
          {loading && (
            <div className={S.mapOverlay}>
              <div className={S.spinner}/>
              <span>Yuklanmoqda…</span>
            </div>
          )}
          {err && !loading && (
            <div className={S.mapOverlay}>
              <span className={S.errText}>{err}</span>
            </div>
          )}
          <div ref={mapDivRef} className={S.map}/>
        </div>
      </div>
    </div>
  );
}
