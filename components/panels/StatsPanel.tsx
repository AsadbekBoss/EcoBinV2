/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import S from "./StatsPanel.module.css";
import { apiFetch } from "@/lib/api/client";
import Pagination from "@/components/ui/Pagination";
import {
  Satellite, RefreshCw, Car as CarIcon, Play, PauseCircle, WifiOff,
  Zap, Gauge, AlertTriangle, Trophy, Search, X,
  TrendingUp, Timer, AlertCircle, BarChart2,
  Activity, MapPin, Download, ChevronUp, ChevronDown,
  ChevronsUpDown, Flame, Route, Droplets,
} from "lucide-react";

const TripTrackMap = dynamic(() => import("./TripTrackMap"), { ssr: false });

/* ─── Types ─────────────────────────────────── */
type Status = "moving" | "stopped" | "offline";
type Filter = "all" | Status;
type TabId  = "fleet" | "tahlil" | "weekly";
type SortBy = "name" | "speed" | "status" | "time";
type SortDir = "asc" | "desc";

type Car = {
  id: number; name: string; lat: number; lng: number;
  speed: number; time: number | null; mileage: number | null; status: Status;
};
type Agg = {
  total: number; moving: number; stopped: number; offline: number;
  avgSpeed: number; maxSpeed: { name: string; speed: number } | null;
  totalMileage: number; onlineRate: number;
  longestOffline: { name: string; since: number } | null;
};
type Violation = {
  id: number; name: string; count: number; maxSpeed: number; kmToday: number;
  events: { speed: number; time: number; lat: number; lng: number }[];
};
type TodayCar = {
  id: number; name: string;
  kmToday: number; trips: number; violations: number;
  maxSpeed: number; idleMin: number;
  tripList: Trip[];
};
type Trip = {
  n: number; startTime: number; endTime: number;
  km: number; avgSpeed: number; maxSpeed: number; durationMin: number;
};
type WeekDay = {
  date: string; isToday: boolean;
  km: number; trips: number; idleMin: number; maxSpeed: number;
  tripList: Trip[];
};
/* ─── Helpers ───────────────────────────────── */
const REFRESH = 10, PAGE = 10, SPEED_ALERT = 90;
// REFRESH used only for interval — no UI countdown

const fmt    = (ms: number) => new Date(ms).toLocaleTimeString("uz-UZ", { hour12: false });
const fmtSig = (s: number | null) =>
  s ? new Date(s * 1000).toLocaleString("uz-UZ", {
    hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  }) : "—";
const fmtTime = (s: number) =>
  new Date(s * 1000).toLocaleTimeString("uz-UZ", { hour12: false, hour: "2-digit", minute: "2-digit" });
const stText = (s: Status) =>
  s === "moving" ? "Harakatda" : s === "stopped" ? "To'xtagan" : "Offline";
const fmtMin = (m: number) => {
  if (m < 60)   return `${m} daqiqa`;
  if (m < 1440) { const h = Math.floor(m / 60), d = m % 60; return d > 0 ? `${h} soat ${d} daqiqa` : `${h} soat`; }
  const kun = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return h > 0 ? `${kun} kun ${h} soat` : `${kun} kun`;
};

function exportCSV(cars: Car[]) {
  const header = ["#", "Mashina", "ID", "Holat", "Tezlik (km/h)", "Lat", "Lng", "So'nggi signal"];
  const rows = cars.map((c, i) => [
    i + 1, c.name, c.id, stText(c.status),
    Math.round(c.speed), c.lat.toFixed(6), c.lng.toFixed(6), fmtSig(c.time),
  ]);
  const csv = [header, ...rows].map(r => r.join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `fleet_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

/* ════════════════════════════════════════════════ */
export default function StatsPanel() {

  /* Fleet */
  const [cars, setCars]       = useState<Car[]>([]);
  const [agg,  setAgg]        = useState<Agg | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");

  /* Table */
  const [filter,  setFilter]  = useState<Filter>("all");
  const [q,       setQ]       = useState("");
  const [page,    setPage]    = useState(1);
  const [sortBy,  setSortBy]  = useState<SortBy>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  /* Tabs */
  const [tab, setTab] = useState<TabId>("fleet");

  /* Long-drive tracker: carId → timestamp when first seen "moving" */
  const movingSince = useRef<Record<number, number>>({});

  /* Violations */
  const [violations, setViolations] = useState<Violation[]>([]);
  const [vioLoaded,  setVioLoaded]  = useState(false);
  const [vioLoading, setVioLoading] = useState(false);
  const [vioErr,     setVioErr]     = useState("");
  const [vioTotal,   setVioTotal]   = useState(0);

  /* Today (fuel analysis) */
  const [todayCars,    setTodayCars]    = useState<TodayCar[] | null>(null);
  const [todayLoading, setTodayLoading] = useState(false);
  const [todayErr,     setTodayErr]     = useState("");
  const [todayLoaded,  setTodayLoaded]  = useState(false);

  /* Weekly */
  const [weeklyUnit,    setWeeklyUnit]    = useState<number>(0);
  const [weeklyData,    setWeeklyData]    = useState<WeekDay[] | null>(null);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyErr,     setWeeklyErr]     = useState("");
  const [expandedDay,   setExpandedDay]   = useState<number | null>(null);
  const [mapTrip,       setMapTrip]       = useState<{ unitId: number; from: number; to: number; n: number } | null>(null);

  const rRef = useRef<any>(null);

  /* ── Load fleet ── */
  async function load(reason: "manual" | "auto" = "manual") {
    try {
      if (reason === "manual") setLoading(true);
      setErr("");
      const r = await apiFetch("/proxy/smartgps/stats", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "API xato");
      const newCars: Car[] = j?.cars ?? [];

      // Track long-drive: update movingSince
      const now = Date.now();
      newCars.forEach(c => {
        if (c.status === "moving") {
          if (!movingSince.current[c.id]) movingSince.current[c.id] = now;
        } else {
          delete movingSince.current[c.id];
        }
      });

      setCars(newCars);
      setAgg(j?.stats ?? null);
    } catch (e: any) { setErr(e?.message || "Xatolik"); }
    finally { if (reason === "manual") setLoading(false); }
  }

  /* ── Load violations ── */
  async function loadViolations() {
    setVioLoading(true); setVioErr("");
    try {
      const r = await apiFetch("/proxy/smartgps/violations", { cache: "no-store" });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "Xato");
      setViolations(j.violations ?? []);
      setVioTotal(j.total ?? 0);
      setVioLoaded(true);
    } catch (e: any) { setVioErr(e?.message || "Xatolik"); }
    finally { setVioLoading(false); }
  }

  /* ── Load today (fuel) ── */
  async function loadToday() {
    setTodayLoading(true); setTodayErr("");
    try {
      const r = await apiFetch("/proxy/smartgps/today", { cache: "no-store" });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "Xato");
      setTodayCars(j.cars ?? []);
      setTodayLoaded(true);
    } catch (e: any) { setTodayErr(e?.message || "Xatolik"); }
    finally { setTodayLoading(false); }
  }


  /* ── Load weekly ── */
  const loadWeekly = useCallback(async (unitId: number) => {
    if (!unitId) return;
    setWeeklyLoading(true); setWeeklyErr(""); setWeeklyData(null); setExpandedDay(null);
    try {
      const r = await apiFetch(`/proxy/smartgps/weekly?unitId=${unitId}`, { cache: "no-store" });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "Xato");
      setWeeklyData(j.days ?? []);
    } catch (e: any) { setWeeklyErr(e?.message || "Xatolik"); }
    finally { setWeeklyLoading(false); }
  }, []);

  useEffect(() => {
    load("manual");
    rRef.current = setInterval(() => load("auto"), REFRESH * 1000);
    return () => { clearInterval(rRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Sort + Filter ── */
  const handleSort = (col: SortBy) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir("asc"); }
  };

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    let list = cars.filter(c => {
      if (filter !== "all" && c.status !== filter) return false;
      return !s || `${c.name} ${c.id}`.toLowerCase().includes(s);
    });
    list = [...list].sort((a, b) => {
      let va: any, vb: any;
      if (sortBy === "name")   { va = a.name; vb = b.name; }
      if (sortBy === "speed")  { va = a.speed; vb = b.speed; }
      if (sortBy === "status") { va = a.status; vb = b.status; }
      if (sortBy === "time")   { va = a.time ?? 0; vb = b.time ?? 0; }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }, [cars, filter, q, sortBy, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const curPage    = Math.min(page, totalPages);
  const paged      = useMemo(() => filtered.slice((curPage - 1) * PAGE, curPage * PAGE), [filtered, curPage]);

  useEffect(() => setPage(1), [filter, q, sortBy, sortDir]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  /* ── Derived ── */
  const top3 = useMemo(
    () => [...cars].filter(c => c.status === "moving").sort((a, b) => b.speed - a.speed).slice(0, 3),
    [cars]
  );
  const maxTop    = top3[0]?.speed || 1;
  const speeding  = useMemo(() => cars.filter(c => c.speed > SPEED_ALERT), [cars]);

  const idleCars  = useMemo(() =>
    cars.filter(c => c.status === "stopped" && c.time)
        .map(c => ({ ...c, idleMin: Math.floor((Date.now() / 1000 - c.time!) / 60) }))
        .sort((a, b) => b.idleMin - a.idleMin).slice(0, 10),
    [cars]
  );
  const topMoving   = useMemo(() => [...cars].filter(c => c.status === "moving").sort((a, b) => b.speed - a.speed).slice(0, 6), [cars]);
  const longOffline = useMemo(() => [...cars].filter(c => c.status === "offline" && c.time).sort((a, b) => a.time! - b.time!).slice(0, 6), [cars]);

  /* Long-drive list */
  const longDrive = useMemo(() => {
    const now = Date.now();
    return cars
      .filter(c => c.status === "moving" && movingSince.current[c.id])
      .map(c => ({ ...c, drivingMin: Math.floor((now - movingSince.current[c.id]) / 60000) }))
      .filter(c => c.drivingMin >= 60)
      .sort((a, b) => b.drivingMin - a.drivingMin);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cars]);

  const weeklyMax      = weeklyData ? Math.max(...weeklyData.map(d => d.km), 1) : 1;
  const weeklyTotalKm  = weeklyData ? weeklyData.reduce((s, d) => s + d.km, 0) : 0;

  /* Sort icon helper */
  const SortIcon = ({ col }: { col: SortBy }) => {
    if (sortBy !== col) return <ChevronsUpDown size={11} style={{ opacity: .4 }}/>;
    return sortDir === "asc" ? <ChevronUp size={11}/> : <ChevronDown size={11}/>;
  };

  /* ══════════════════════════════════════════════════════ */
  return (
    <>
    <div className={S.wrap}>

      {/* HEADER */}
      <div className={S.hdr}>
        <div className={S.hdrLeft}>
          <div className={S.hdrIcon}><Satellite size={20}/></div>
          <div>
            <div className={S.hdrTitle}>GPS Statistika</div>
            <div className={S.hdrSub}>Real vaqt fleet monitoring</div>
          </div>
        </div>
        <div className={S.hdrRight}>
          {speeding.length > 0 && (
            <span className={S.speedingBadge}>
              <Flame size={12}/>{speeding.length} tez!
            </span>
          )}
          <button className={S.refreshBtn} onClick={() => load("manual")} disabled={loading}>
            <RefreshCw size={13}/> Yangilash
          </button>
        </div>
      </div>

      {err && <div className={S.errBox}>{err}</div>}

      {/* TABS */}
      <div className={S.tabs}>
        {([
          { id: "fleet",  label: "Fleet",    icon: <CarIcon size={14}/> },
          { id: "tahlil", label: "Tahlil",   icon: <AlertCircle size={14}/> },
          { id: "weekly", label: "Haftaliy", icon: <BarChart2 size={14}/> },
        ] as const).map(t => (
          <button key={t.id} className={`${S.tab} ${tab === t.id ? S.tabActive : ""}`} onClick={() => setTab(t.id)}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* ════════════ FLEET TAB ════════════ */}
      {tab === "fleet" && agg && (<>

        {/* KPI */}
        <div className={S.kpiGrid}>
          {([
            { k: "all",     icon: <CarIcon size={18}/>,     num: agg.total,   label: "Jami",      pct: "100%",                                                             cls: S.kpiBlue   },
            { k: "moving",  icon: <Play size={18}/>,        num: agg.moving,  label: "Harakatda", pct: agg.total ? `${Math.round(agg.moving  / agg.total * 100)}%` : "0%", cls: S.kpiGreen  },
            { k: "stopped", icon: <PauseCircle size={18}/>, num: agg.stopped, label: "To'xtagan", pct: agg.total ? `${Math.round(agg.stopped / agg.total * 100)}%` : "0%", cls: S.kpiYellow },
            { k: "offline", icon: <WifiOff size={18}/>,     num: agg.offline, label: "Offline",   pct: agg.total ? `${Math.round(agg.offline / agg.total * 100)}%` : "0%", cls: S.kpiRed    },
          ] as const).map(item => (
            <button
              key={item.k} type="button"
              className={`${S.kpiCard} ${item.cls} ${filter === item.k ? S.kpiOn : ""}`}
              onClick={() => setFilter(f => f === item.k ? "all" : item.k as Filter)}
            >
              <div className={S.kpiTop}>
                <span className={S.kpiEmoji}>{item.icon}</span>
                <span className={S.kpiPct}>{item.pct}</span>
              </div>
              <div className={S.kpiNum}>{item.num}</div>
              <div className={S.kpiLabel}>{item.label}</div>
            </button>
          ))}
        </div>

        {/* Mid */}
        <div className={S.midGrid}>
          <div className={S.card}>
            <div className={S.cardHdr}>
              <span className={S.cardTitle}>Fleet holati</span>
              <span className={S.onlinePill}>{agg.onlineRate}% online</span>
            </div>
            <div className={S.bigBar}>
              {agg.total > 0 && <>
                {agg.moving  > 0 && <div className={S.bbGreen}  style={{ width: `${agg.moving  / agg.total * 100}%` }}/>}
                {agg.stopped > 0 && <div className={S.bbYellow} style={{ width: `${agg.stopped / agg.total * 100}%` }}/>}
                {agg.offline > 0 && <div className={S.bbRed}    style={{ width: `${agg.offline / agg.total * 100}%` }}/>}
              </>}
            </div>
            <div className={S.legend}>
              <span className={S.lgG}>● Harakatda <b>{agg.moving}</b></span>
              <span className={S.lgY}>● To'xtagan <b>{agg.stopped}</b></span>
              <span className={S.lgR}>● Offline <b>{agg.offline}</b></span>
            </div>
            <div className={S.onlineTrackWrap}>
              <span className={S.onlineLbl}>Online:</span>
              <div className={S.onlineTrack}><div className={S.onlineFill} style={{ width: `${agg.onlineRate}%` }}/></div>
              <span className={S.onlineNum}>{agg.onlineRate}%</span>
            </div>
          </div>
          <div className={S.card}>
            <div className={S.cardHdr}><span className={S.cardTitle}>Tezlik ma'lumotlari</span></div>
            <div className={S.speedGrid}>
              <div className={S.speedBox}>
                <div className={S.speedIcon}><Zap size={18}/></div>
                <div className={S.speedNum}>{agg.avgSpeed}<span>km/h</span></div>
                <div className={S.speedLbl}>O'rtacha tezlik</div>
              </div>
              {agg.maxSpeed && (
                <div className={S.speedBox}>
                  <div className={S.speedIcon}><Gauge size={18}/></div>
                  <div className={S.speedNum}>{agg.maxSpeed.speed}<span>km/h</span></div>
                  <div className={S.speedLbl}>{agg.maxSpeed.name}</div>
                </div>
              )}
            </div>
            {agg.longestOffline && (
              <div className={S.warnBox}>
                <span className={S.warnIcon}><AlertTriangle size={16}/></span>
                <div>
                  <div className={S.warnName}>{agg.longestOffline.name}</div>
                  <div className={S.warnTime}>
                    {(() => { const m = Math.floor((Date.now() / 1000 - agg.longestOffline!.since) / 60);
                      return m < 60 ? `${m} daqiqa offline` : `${Math.floor(m / 60)}s ${m % 60}d offline`; })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Top 3 */}
        {top3.length > 0 && (
          <div className={S.top3Card}>
            <div className={S.top3Hdr}><TrendingUp size={15}/>Eng tez harakatdagi mashinalar</div>
            <div className={S.top3List}>
              {top3.map((c, i) => (
                <div key={c.id} className={S.top3Row}>
                  <span className={S.medal}><Trophy size={14} className={[S.gold, S.silver, S.bronze][i]}/></span>
                  <span className={S.t3Name}>{c.name}</span>
                  <div className={S.t3BarWrap}><div className={S.t3Bar} style={{ width: `${(c.speed / maxTop) * 100}%` }}/></div>
                  <span className={S.t3Spd}>{Math.round(c.speed)} km/h</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TABLE */}
        <div className={S.tableCard}>
          <div className={S.tableHdr}>
            <div>
              <div className={S.tableTitle}>Mashinalar ro'yxati</div>
              <div className={S.tableSub}>
                {filter === "all" ? "Barchasi" : stText(filter as Status)} — <b>{filtered.length}</b> ta
              </div>
            </div>
            <div className={S.tableControls}>
              <div className={S.searchBox}>
                <span className={S.searchIco}><Search size={13}/></span>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Qidirish..." className={S.search}/>
                {q && <button className={S.clearBtn} onClick={() => setQ("")}><X size={11}/></button>}
              </div>
              <button className={S.csvBtn} onClick={() => exportCSV(filtered)} title="CSV yuklab olish">
                <Download size={14}/>
              </button>
            </div>
          </div>

          <div className={S.desktopTable}>
            <table className={S.table}>
              <thead>
                <tr>
                  <th className={S.th}>#</th>
                  {(["name", "status", "speed", "time"] as const).map((col, ci) => (
                    <th key={col} className={`${S.th} ${S.thSort}`} onClick={() => handleSort(col)}>
                      <span>{["Mashina", "Holat", "Tezlik", "So'nggi signal"][ci]}</span>
                      <SortIcon col={col}/>
                    </th>
                  ))}
                  <th className={S.th}>Koordinata</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((c, i) => (
                  <tr key={c.id} className={`${S.tr} ${c.speed > SPEED_ALERT ? S.trFast : ""}`}>
                    <td className={S.td}><span className={S.rowNum}>{(curPage - 1) * PAGE + i + 1}</span></td>
                    <td className={S.td}>
                      <div className={S.nameCell}>
                        <div className={S.ava}>{c.name.charAt(0)}</div>
                        <div><div className={S.cName}>{c.name}</div><div className={S.cId}>ID: {c.id}</div></div>
                      </div>
                    </td>
                    <td className={S.td}>
                      <span className={`${S.pill} ${c.status === "moving" ? S.pillG : c.status === "stopped" ? S.pillY : S.pillR}`}>
                        <span className={S.dot}/>{stText(c.status)}
                      </span>
                    </td>
                    <td className={S.td}>
                      <span className={`${S.speedPill} ${c.speed > SPEED_ALERT ? S.speedPillRed : ""}`}>
                        {Math.round(c.speed)} km/h
                      </span>
                    </td>
                    <td className={S.td}>{fmtSig(c.time)}</td>
                    <td className={S.td}>
                      <div className={S.coords}><span>{c.lat.toFixed(4)}</span><span>{c.lng.toFixed(4)}</span></div>
                    </td>
                  </tr>
                ))}
                {!filtered.length && <tr><td className={S.empty} colSpan={6}>Mashina topilmadi.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className={S.mobileCards}>
            {paged.map((c, i) => (
              <div key={c.id} className={`${S.mCard} ${c.speed > SPEED_ALERT ? S.mCardFast : ""}`}>
                <div className={S.mTop}>
                  <div className={S.nameCell}>
                    <div className={S.ava}>{c.name.charAt(0)}</div>
                    <div><div className={S.cName}>{c.name}</div><div className={S.cId}>ID: {c.id} • #{(curPage - 1) * PAGE + i + 1}</div></div>
                  </div>
                  <span className={`${S.pill} ${c.status === "moving" ? S.pillG : c.status === "stopped" ? S.pillY : S.pillR}`}>
                    <span className={S.dot}/>{stText(c.status)}
                  </span>
                </div>
                <div className={S.mGrid}>
                  <div className={S.mBox}><span className={S.mKey}>Tezlik</span><span className={S.mVal}>{Math.round(c.speed)} km/h</span></div>
                  <div className={S.mBox}><span className={S.mKey}>Lat</span><span className={S.mVal}>{c.lat.toFixed(4)}</span></div>
                  <div className={S.mBox}><span className={S.mKey}>Lng</span><span className={S.mVal}>{c.lng.toFixed(4)}</span></div>
                  <div className={S.mBox}><span className={S.mKey}>Signal</span><span className={S.mVal}>{fmtSig(c.time)}</span></div>
                </div>
              </div>
            ))}
            {!filtered.length && <div className={S.emptyCard}>Mashina topilmadi.</div>}
          </div>

          <Pagination page={curPage} totalPages={totalPages} onChange={setPage}/>
        </div>
      </>)}

      {/* ════════════ TAHLIL TAB ════════════ */}
      {tab === "tahlil" && (<>

        {/* Long drive alert */}
        {longDrive.length > 0 && (
          <div className={S.alertBanner}>
            <Flame size={16}/>
            <div>
              <b>{longDrive.length} ta mashina</b> uzluksiz 1+ soat harakatda:{" "}
              {longDrive.slice(0, 3).map(c => `${c.name} (${fmtMin(c.drivingMin)})`).join(", ")}
              {longDrive.length > 3 && ` va yana ${longDrive.length - 3} ta`}
            </div>
          </div>
        )}

        {/* Idle cars */}
        <div className={S.aCard}>
          <div className={S.aHdr}>
            <div className={S.aTitleWrap}>
              <span className={S.aIcon} style={{ background: "rgba(245,158,11,.12)", color: "#d97706" }}><Timer size={15}/></span>
              <div>
                <div className={S.aTitle}>Bekor yonib turgan mashinalar</div>
                <div className={S.aSub}>To'xtagan lekin signal kelayotgan</div>
              </div>
            </div>
            <span className={S.aBadgeY}>{idleCars.length} ta</span>
          </div>
          {idleCars.length === 0
            ? <div className={S.aEmpty}>Hozir bekor yonib turgan mashina yo'q</div>
            : (
              <div className={S.idleList}>
                {idleCars.map(c => {
                  const pct   = Math.min(100, (c.idleMin / 120) * 100);
                  const color = c.idleMin > 60 ? "#ef4444" : c.idleMin > 30 ? "#f59e0b" : "#22c55e";
                  return (
                    <div key={c.id} className={S.idleRow}>
                      <div className={S.ava}>{c.name.charAt(0)}</div>
                      <div className={S.idleBody}>
                        <div className={S.idleName}>{c.name}</div>
                        <div className={S.idleBarTrack}>
                          <div className={S.idleBarFill} style={{ width: `${pct}%`, background: color }}/>
                        </div>
                      </div>
                      <div className={S.idleTime} style={{ color }}>{fmtMin(c.idleMin)}</div>
                    </div>
                  );
                })}
              </div>
            )}
        </div>

        {/* Fuel waste */}
        <div className={S.aCard}>
          <div className={S.aHdr}>
            <div className={S.aTitleWrap}>
              <span className={S.aIcon} style={{ background: "rgba(234,88,12,.10)", color: "#ea580c" }}><Droplets size={15}/></span>
              <div>
                <div className={S.aTitle}>Yoqilg'i sarfi tahlili</div>
                <div className={S.aSub}>Bekorga yonib turgan mashinalar</div>
              </div>
            </div>
          </div>

          {/* Mini tabs: hozir / bugun */}
          <div className={S.fuelTabs}>
            <button
              className={`${S.fuelTab} ${!todayLoaded ? S.fuelTabActive : ""}`}
              onClick={() => setTodayLoaded(false)}
            >Hozir</button>
            <button
              className={`${S.fuelTab} ${todayLoaded ? S.fuelTabActive : ""}`}
              onClick={() => { if (!todayLoaded && !todayLoading) loadToday(); else setTodayLoaded(true); }}
            >
              Bugun (kun davomida)
              {!todayLoaded && !todayLoading && <span className={S.fuelTabNew}>yangi</span>}
            </button>
          </div>

          {/* HOZIR view */}
          {!todayLoaded && (
            idleCars.length === 0
              ? <div className={S.aEmpty}>Hozir bekor yonib turgan mashina yo'q</div>
              : <>
                  <div className={S.fuelSummary}>
                    <span className={S.fuelSumItem}>
                      <b>{idleCars.length}</b> mashina idle
                    </span>
                    <span className={S.fuelSumSep}>•</span>
                    <span className={S.fuelSumItem}>
                      Taxminan <b>~{(idleCars.reduce((s, c) => s + c.idleMin, 0) * 0.013).toFixed(1)} L</b> sarflanmoqda
                    </span>
                  </div>
                  <div className={S.fuelList}>
                    {idleCars.map(c => {
                      const litre = (c.idleMin * 0.013).toFixed(1);
                      const risk  = c.idleMin > 60 ? "high" : c.idleMin > 20 ? "mid" : "low";
                      return (
                        <div key={c.id} className={S.fuelRow}>
                          <div className={`${S.fuelDot} ${risk === "high" ? S.fuelDotH : risk === "mid" ? S.fuelDotM : S.fuelDotL}`}/>
                          <div className={S.ava}>{c.name.charAt(0)}</div>
                          <div className={S.fuelBody}>
                            <div className={S.fuelName}>{c.name}</div>
                            <div className={S.fuelMeta}>{fmtMin(c.idleMin)} davomida to'xtab turibdi</div>
                          </div>
                          <div className={S.fuelRight}>
                            <span className={`${S.fuelLitre} ${risk === "high" ? S.fuelLitreH : ""}`}>~{litre} L</span>
                            <span className={S.fuelHint}>hozircha</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
          )}

          {/* BUGUN view */}
          {todayLoaded && (
            <>
              {todayErr && <div className={S.errBox}>{todayErr}</div>}
              {todayCars && (() => {
                const withIdle = [...todayCars].filter(c => c.idleMin > 0).sort((a, b) => b.idleMin - a.idleMin);
                const totalL   = todayCars.reduce((s, c) => s + c.idleMin * 0.013, 0);
                const totalMin = todayCars.reduce((s, c) => s + c.idleMin, 0);
                if (withIdle.length === 0) return <div className={S.aEmptyGreen}>Bugun idle sarfi qayd etilmagan ✓</div>;
                const maxIdle  = withIdle[0].idleMin || 1;
                return (
                  <>
                    <div className={S.fuelSummary}>
                      <span className={S.fuelSumItem}>Jami idle: <b>{fmtMin(totalMin)}</b></span>
                      <span className={S.fuelSumSep}>•</span>
                      <span className={S.fuelSumItem}>Taxminiy sarif: <b>~{totalL.toFixed(1)} L</b></span>
                    </div>
                    <div className={S.fuelList}>
                      {withIdle.slice(0, 15).map((c, i) => {
                        const litre = (c.idleMin * 0.013).toFixed(1);
                        const risk  = c.idleMin > 120 ? "high" : c.idleMin > 30 ? "mid" : "low";
                        const pct   = Math.round((c.idleMin / maxIdle) * 100);
                        return (
                          <div key={c.id} className={S.fuelRow}>
                            <span className={S.rankNum}>{i + 1}</span>
                            <div className={S.ava}>{c.name.charAt(0)}</div>
                            <div className={S.fuelBody}>
                              <div className={S.fuelName}>{c.name}</div>
                              <div className={S.fuelBarTrack}>
                                <div className={S.fuelBarFill} style={{
                                  width: `${pct}%`,
                                  background: risk === "high" ? "#ef4444" : risk === "mid" ? "#f59e0b" : "#22c55e"
                                }}/>
                              </div>
                              <div className={S.fuelMeta}>
                                Idle: {fmtMin(c.idleMin)} • {c.trips} ta sayohat • {c.kmToday} km
                              </div>
                            </div>
                            <div className={S.fuelRight}>
                              <span className={`${S.fuelLitre} ${risk === "high" ? S.fuelLitreH : ""}`}>~{litre} L</span>
                              <span className={S.fuelHint}>isrof</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className={S.fuelRefreshRow}>
                      <button className={S.reloadBtn} onClick={loadToday} disabled={todayLoading}><RefreshCw size={12}/></button>
                      <span className={S.fuelNote}>* 0.8 L/soat idle sarfi asosida taxminiy hisob-kitob</span>
                    </div>
                  </>
                );
              })()}
            </>
          )}

          {/* Load trigger for bugun tab */}
        </div>

        {/* Activity ranking */}
        <div className={S.aCard}>
          <div className={S.aHdr}>
            <div className={S.aTitleWrap}>
              <span className={S.aIcon} style={{ background: "rgba(37,99,235,.10)", color: "#2563eb" }}><Activity size={15}/></span>
              <div>
                <div className={S.aTitle}>Faollik reytingi</div>
                <div className={S.aSub}>Joriy holat bo'yicha</div>
              </div>
            </div>
          </div>
          <div className={S.rankGrid}>
            <div className={S.rankSection}>
              <div className={S.rankSectionTitle}><TrendingUp size={13}/>Eng tez harakatdagilar</div>
              {topMoving.length === 0
                ? <div className={S.aEmpty}>Harakatdagi mashina yo'q</div>
                : topMoving.map((c, i) => (
                  <div key={c.id} className={S.rankRow}>
                    <span className={S.rankNum}>{i + 1}</span>
                    <span className={S.rankName}>{c.name}</span>
                    <span className={`${S.pill} ${S.pillG}`} style={{ fontSize: 10 }}>
                      <span className={S.dot}/>{Math.round(c.speed)} km/h
                    </span>
                  </div>
                ))
              }
            </div>
            <div className={S.rankSection}>
              <div className={S.rankSectionTitle}><WifiOff size={13}/>Eng uzoq offline</div>
              {longOffline.length === 0
                ? <div className={S.aEmpty}>Offline mashina yo'q</div>
                : longOffline.map((c, i) => {
                  const m = c.time ? Math.floor((Date.now() / 1000 - c.time) / 60) : 0;
                  return (
                    <div key={c.id} className={S.rankRow}>
                      <span className={S.rankNum}>{i + 1}</span>
                      <span className={S.rankName}>{c.name}</span>
                      <span className={`${S.pill} ${S.pillR}`} style={{ fontSize: 10 }}>
                        <span className={S.dot}/>{fmtMin(m)}
                      </span>
                    </div>
                  );
                })
              }
            </div>
          </div>
        </div>

        {/* Speed violations */}
        <div className={S.aCard}>
          <div className={S.aHdr}>
            <div className={S.aTitleWrap}>
              <span className={S.aIcon} style={{ background: "rgba(239,68,68,.10)", color: "#dc2626" }}><AlertTriangle size={15}/></span>
              <div>
                <div className={S.aTitle}>Bugungi tezlik buzishlari</div>
                <div className={S.aSub}>90 km/h dan oshgan holatlar</div>
              </div>
            </div>
            <div className={S.aHdrRight}>
              {vioLoaded && <span className={S.aBadgeR}>{violations.length}/{vioTotal} mashina</span>}
              {!vioLoaded && (
                <button className={S.loadBtn} onClick={loadViolations} disabled={vioLoading}>
                  {vioLoading ? "Yuklanmoqda…" : "Yuklash"}
                </button>
              )}
              {vioLoaded && <button className={S.reloadBtn} onClick={loadViolations} disabled={vioLoading}><RefreshCw size={12}/></button>}
            </div>
          </div>
          {vioErr && <div className={S.errBox}>{vioErr}</div>}
          {!vioLoaded && !vioLoading && <div className={S.aEmpty}>Ma'lumotlarni yuklash uchun "Yuklash" tugmasini bosing</div>}
          {vioLoaded && violations.length === 0 && <div className={S.aEmptyGreen}>Bugun hech qanday tezlik buzilishi qayd etilmagan ✓</div>}
          {vioLoaded && violations.length > 0 && (
            <div className={S.vioList}>
              {violations.slice(0, 12).map(v => (
                <div key={v.id} className={S.vioRow}>
                  <div className={S.vioAva}>{v.name.charAt(0)}</div>
                  <div className={S.vioBody}>
                    <div className={S.vioName}>{v.name}</div>
                    <div className={S.vioMeta}><MapPin size={10}/>{v.kmToday} km bugun</div>
                  </div>
                  <div className={S.vioRight}>
                    <div className={S.vioCount}>{v.count}×</div>
                    <div className={S.vioMax}>max {v.maxSpeed} km/h</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </>)}

      {/* ════════════ WEEKLY TAB ════════════ */}
      {tab === "weekly" && (
        <div className={S.aCard}>
          <div className={S.aHdr}>
            <div className={S.aTitleWrap}>
              <span className={S.aIcon} style={{ background: "rgba(37,99,235,.10)", color: "#2563eb" }}><BarChart2 size={15}/></span>
              <div>
                <div className={S.aTitle}>Haftalik mileage tahlili</div>
                <div className={S.aSub}>Oxirgi 7 kun: masofa, sayohat, idle vaqt</div>
              </div>
            </div>
            {weeklyData && <span className={S.aBadgeB}>{weeklyTotalKm.toFixed(1)} km jami</span>}
          </div>

          <div className={S.carSelectWrap}>
            <CarIcon size={14} className={S.carSelectIcon}/>
            <select
              className={S.carSelect}
              value={weeklyUnit || ""}
              onChange={e => { const id = Number(e.target.value); setWeeklyUnit(id); if (id) loadWeekly(id); }}
            >
              <option value="">— Mashina tanlang —</option>
              {cars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {weeklyErr && <div className={S.errBox}>{weeklyErr}</div>}
          {!weeklyData && !weeklyLoading && !weeklyErr && <div className={S.aEmpty}>Yuqoridan mashina tanlang</div>}

          {weeklyData && (<>
            {/* Bar chart */}
            <div className={S.chartWrap}>
              {weeklyData.map((d, i) => (
                <div key={i} className={`${S.chartCol} ${d.isToday ? S.chartColToday : ""}`}>
                  <div className={S.chartBarArea}>
                    <div
                      className={`${S.chartBarFill} ${d.isToday ? S.chartBarToday : ""}`}
                      style={{ height: weeklyMax > 0 ? `${(d.km / weeklyMax) * 100}%` : "0%" }}
                    />
                  </div>
                  <div className={S.chartKm}>{d.km > 0 ? d.km : "—"}</div>
                  <div className={S.chartDate}>{d.date}</div>
                </div>
              ))}
            </div>

            {/* Day rows — clickable to expand trips */}
            <div className={S.weekTable}>
              <div className={S.weekHead}>
                {["Sana", "Masofa", "Sayohat", "Idle", "Max tezlik"].map(h => (
                  <div key={h} className={S.weekTh}>{h}</div>
                ))}
              </div>
              {weeklyData.map((d, i) => (
                <React.Fragment key={i}>
                  <div
                    className={`${S.weekRow} ${d.isToday ? S.weekRowToday : ""} ${d.trips > 0 ? S.weekRowClickable : ""}`}
                    onClick={() => d.trips > 0 && setExpandedDay(expandedDay === i ? null : i)}
                  >
                    <div className={S.weekTd}>
                      {d.date}
                      {d.isToday && <span className={S.todayBadge}>bugun</span>}
                    </div>
                    <div className={S.weekTd}><b>{d.km}</b> km</div>
                    <div className={S.weekTd}>{d.trips} ta</div>
                    <div className={S.weekTd}>{d.idleMin > 0 ? fmtMin(d.idleMin) : "—"}</div>
                    <div className={S.weekTd}>
                      {d.maxSpeed > 0 ? `${d.maxSpeed} km/h` : "—"}
                      {d.trips > 0 && (
                        <span className={S.expandIcon}>
                          {expandedDay === i ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}
                        </span>
                      )}
                    </div>
                  </div>

                  {expandedDay === i && d.tripList && d.tripList.length > 0 && (
                    <div className={S.tripExpand}>
                      {d.tripList.map(t => (
                        <div
                          key={t.n}
                          className={`${S.tripRow} ${S.tripRowClickable}`}
                          onClick={() => weeklyUnit && setMapTrip({
                            unitId: weeklyUnit,
                            from:   t.startTime,
                            to:     t.endTime,
                            n:      t.n,
                          })}
                          title="Xaritada ko'rish"
                        >
                          <div className={S.tripIcon}><Route size={13}/></div>
                          <div className={S.tripBody}>
                            <div className={S.tripTitle}>Sayohat #{t.n}</div>
                            <div className={S.tripTime}>
                              {fmtTime(t.startTime)} → {fmtTime(t.endTime)}
                              <span className={S.tripDur}>{fmtMin(t.durationMin)}</span>
                            </div>
                          </div>
                          <div className={S.tripStats}>
                            <span className={S.tripKm}>{t.km} km</span>
                            <span className={S.tripSpd}>{t.avgSpeed} km/h avg</span>
                          </div>
                          <div className={S.tripMapBtn}><MapPin size={12}/></div>
                        </div>
                      ))}
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </>)}
        </div>
      )}
    </div>

    {/* Trip track map overlay */}
    {mapTrip && (
      <TripTrackMap
        unitId={mapTrip.unitId}
        from={mapTrip.from}
        to={mapTrip.to}
        tripNum={mapTrip.n}
        onClose={() => setMapTrip(null)}
      />
    )}
    </>
  );
}
