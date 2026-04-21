/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useMemo, useState } from "react";
import Style from "./trashbins.module.css";
import { apiFetch } from "@/lib/api/client";
import Pagination from "@/components/ui/Pagination";

type BinStatus = "EMPTY" | "FULL";

type DriverShort = {
  id: number;
  fullname?: string;
  fullName?: string;
  username?: string;
};

type Trashbin = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  fillLevel: number;
  status: BinStatus;
  imageUrl?: string | null;
  cameraId?: string | null;
  drivers?: DriverShort[];
};

type Driver = {
  id: number;
  fullname?: string;
  fullName?: string;
  username: string;
  role?: "SUPER_ADMIN" | "ADMIN" | "DRIVER" | string;
};

type FormState = {
  name: string;
  latitude: string;
  longitude: string;
  fillLevel: string;
  cameraId: string;
  binCount: string;
  driverIds: string[];
};

type TrashbinPayload = {
  name: string;
  latitude: number;
  longitude: number;
  fillLevel: number;
  cameraId?: string;
  status: BinStatus;
  driverIds: number[];
};

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickList(j: unknown): any[] {
  if (Array.isArray(j)) return j;
  if (j && typeof j === "object") {
    const obj = j as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as any[];
    if (Array.isArray(obj.content)) return obj.content as any[];
    if (Array.isArray(obj.data)) return obj.data as any[];
  }
  return [];
}

function normalizeRole(input: unknown): "SUPER_ADMIN" | "ADMIN" | "DRIVER" | "" {
  const r = String(input ?? "").trim().toUpperCase();
  if (r === "SUPER_ADMIN" || r === "ROLE_SUPER_ADMIN") return "SUPER_ADMIN";
  if (r === "ADMIN" || r === "ROLE_ADMIN") return "ADMIN";
  if (r === "DRIVER" || r === "ROLE_DRIVER") return "DRIVER";
  return "";
}

const EMPTY_FORM: FormState = {
  name: "",
  latitude: "",
  longitude: "",
  fillLevel: "0",
  cameraId: "",
  binCount: "",
  driverIds: [],
};

export default function TrashbinsPanel() {
  const [bins, setBins] = useState<Trashbin[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");

  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driversErr, setDriversErr] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [editing, setEditing] = useState<Trashbin | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Driver picker sub-modal
  const [driverPickerOpen, setDriverPickerOpen] = useState(false);
  const [driverSearch, setDriverSearch] = useState("");

  async function loadBins() {
    setLoading(true);
    setErr(null);
    try {
      const r = await apiFetch("/proxy/trashbins?page=0&size=1000", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr((j as any)?.message || (j as any)?.error || `Trashbins error: ${r.status}`);
        setBins([]);
        return;
      }
      setBins(pickList(j) as Trashbin[]);
    } catch (e: any) {
      setErr(e?.message || "Network error");
      setBins([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadDriversMaybe() {
    setDriversErr(null);
    try {
      const r = await apiFetch("/proxy/users/drivers", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDrivers([]);
        setDriversErr((j as any)?.message || (j as any)?.error || `Drivers error: ${r.status}`);
        return;
      }
      const list = pickList(j) as Driver[];
      setDrivers(list.filter((u) => { const role = normalizeRole(u?.role); return role === "DRIVER" || !role; }));
    } catch (e: any) {
      setDrivers([]);
      setDriversErr(e?.message || "Drivers list load error");
    }
  }

  useEffect(() => { loadBins(); loadDriversMaybe(); }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const stats = useMemo(() => {
    const total = bins.length;
    const full = bins.filter((b) => String(b?.status || "") === "FULL" || num(b.fillLevel) >= 90).length;
    return { total, full, empty: total - full };
  }, [bins]);

  const filteredBins = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return bins;
    return bins.filter((b) => {
      const driverNames = Array.isArray(b.drivers)
        ? b.drivers.map((d) => d.fullname || d.fullName || d.username || "").join(" ")
        : "";
      return [String(b.id ?? ""), String(b.name ?? ""), String(b.cameraId ?? ""), String(b.status ?? ""), String(b.fillLevel ?? ""), driverNames]
        .join(" ").toLowerCase().includes(s);
    });
  }, [bins, q]);

  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(filteredBins.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const pagedBins = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredBins.slice(start, start + PAGE_SIZE);
  }, [filteredBins, currentPage]);

  useEffect(() => { setPage(1); }, [q]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  function resetForm() { setForm(EMPTY_FORM); }

  function closeModal() {
    if (saving) return;
    setOpen(false);
    setEditing(null);
    resetForm();
    setDriverPickerOpen(false);
    setDriverSearch("");
  }

  function openCreate() {
    setErr(null); setOkMsg(null); setEditing(null);
    resetForm(); setOpen(true);
  }

  function openEdit(b: Trashbin) {
    setErr(null); setOkMsg(null); setEditing(b);
    setForm({
      name: b.name ?? "",
      latitude: String(b.latitude ?? ""),
      longitude: String(b.longitude ?? ""),
      fillLevel: String(b.fillLevel ?? "0"),
      cameraId: String(b.cameraId ?? ""),
      binCount: "",
      driverIds: Array.isArray(b.drivers) ? b.drivers.map((d) => String(d.id)) : [],
    });
    setOpen(true);
  }

  function toggleDriver(id: string) {
    setForm((prev) => ({
      ...prev,
      driverIds: prev.driverIds.includes(id)
        ? prev.driverIds.filter((x) => x !== id)
        : [...prev.driverIds, id],
    }));
  }

  function removeDriver(id: string) {
    setForm((prev) => ({ ...prev, driverIds: prev.driverIds.filter((x) => x !== id) }));
  }

  function buildCreatePayload(): TrashbinPayload {
    const driverIds = form.driverIds.map(Number).filter((id) => Number.isFinite(id) && id > 0);
    const fillLevel = num(form.fillLevel, NaN);
    return {
      name: form.name.trim(),
      latitude: num(form.latitude, NaN),
      longitude: num(form.longitude, NaN),
      fillLevel,
      cameraId: form.cameraId.trim(),
      status: fillLevel >= 90 ? "FULL" : "EMPTY",
      driverIds,
    };
  }

  function buildEditPayload(): TrashbinPayload | null {
    if (!editing) return null;
    const driverIds = form.driverIds.map(Number).filter((id) => Number.isFinite(id) && id > 0);
    const fillLevel = num(form.fillLevel, NaN);
    return {
      name: editing.name,
      latitude: Number(editing.latitude),
      longitude: Number(editing.longitude),
      fillLevel,
      cameraId: editing.cameraId || undefined,
      status: fillLevel >= 90 ? "FULL" : "EMPTY",
      driverIds,
    };
  }

  function validateCreate(p: TrashbinPayload) {
    if (!p.name) return "Name kiriting";
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return "Latitude/Longitude noto'g'ri";
    if (!Number.isFinite(p.fillLevel) || p.fillLevel < 0 || p.fillLevel > 100) return "Fill Level 0–100 bo'lishi kerak";
    if (!p.cameraId) return "Camera ID kiriting";
    if (!p.driverIds.length) return "Kamida bitta haydovchi tanlang";
    return null;
  }

  function validateEdit(p: TrashbinPayload) {
    if (!Number.isFinite(p.fillLevel) || p.fillLevel < 0 || p.fillLevel > 100) return "Fill Level 0–100 bo'lishi kerak";
    if (!p.driverIds.length) return "Kamida bitta haydovchi tanlang";
    return null;
  }

  async function createBin() {
    if (saving) return;
    setSaving(true); setErr(null); setOkMsg(null);
    const payload = buildCreatePayload();
    const ve = validateCreate(payload);
    if (ve) { setErr(ve); setSaving(false); return; }
    try {
      const r = await apiFetch("/proxy/trashbins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr((j as any)?.message || (j as any)?.error || `Create error: ${r.status}`); return; }
      setOkMsg("✅ Trashbin yaratildi");
      closeModal(); await loadBins();
    } catch (e: any) {
      setErr(e?.message || "Network error");
    } finally { setSaving(false); }
  }

  async function updateBin() {
    if (!editing || saving) return;
    setSaving(true); setErr(null); setOkMsg(null);
    const payload = buildEditPayload();
    if (!payload) { setErr("Edit ma'lumoti topilmadi"); setSaving(false); return; }
    const ve = validateEdit(payload);
    if (ve) { setErr(ve); setSaving(false); return; }
    try {
      const r = await apiFetch(`/proxy/trashbins/${editing.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr((j as any)?.message || (j as any)?.error || `Update error: ${r.status}`); return; }
      setOkMsg("✅ Trashbin yangilandi");
      closeModal(); await loadBins();
    } catch (e: any) {
      setErr(e?.message || "Network error");
    } finally { setSaving(false); }
  }

  async function deleteBin(id: number) {
    if (!confirm(`Trashbin #${id} ni o'chirasanmi?`)) return;
    setErr(null); setOkMsg(null);
    try {
      const r = await apiFetch(`/proxy/trashbins/${id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr((j as any)?.message || (j as any)?.error || `Delete error: ${r.status}`); return; }
      setOkMsg("🗑️ Trashbin o'chirildi"); await loadBins();
    } catch (e: any) { setErr(e?.message || "Network error"); }
  }

  function driverName(d: DriverShort | Driver) {
    return (d as any).fullname || (d as any).fullName || d.username || `#${d.id}`;
  }

  const selectedDriverObjs = useMemo(
    () => drivers.filter((d) => form.driverIds.includes(String(d.id))),
    [drivers, form.driverIds]
  );

  const filteredDrivers = useMemo(() => {
    const s = driverSearch.trim().toLowerCase();
    if (!s) return drivers;
    return drivers.filter((d) =>
      `${driverName(d)} ${d.username}`.toLowerCase().includes(s)
    );
  }, [drivers, driverSearch]);

  return (
    <div className={Style.wrap}>
      <div className={Style.headRow}>
        <div>
          <div className={Style.hTitle}>🗑️ Trashbins</div>
          <div className={Style.hSub}>Yaratish / ko'rish / nazorat</div>
        </div>
        <div className={Style.headActions}>
          <input
            className={`${Style.input} ${Style.searchTop}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Qidirish: nomi, ID, camera, driver..."
          />
          <button className={Style.btnGhost} onClick={loadBins} disabled={loading}>↻ Yangilash</button>
          <button className={Style.btnPrimary} onClick={openCreate}>+ Qo'shish</button>
        </div>
      </div>

      <div className={Style.cardsRow}>
        <div className={Style.cardMini}>
          <div className={Style.cardMiniTop}>Jami</div>
          <div className={Style.cardMiniVal}>{stats.total}</div>
        </div>
        <div className={Style.cardMini}>
          <div className={Style.cardMiniTop}>FULL (≥90%)</div>
          <div className={Style.cardMiniVal}>{stats.full}</div>
        </div>
        <div className={Style.cardMini}>
          <div className={Style.cardMiniTop}>EMPTY (&lt;90%)</div>
          <div className={Style.cardMiniVal}>{stats.empty}</div>
        </div>
      </div>

      {err   && <div className={Style.alertErr}>⚠️ {err}</div>}
      {okMsg && <div className={Style.alertOk}>{okMsg}</div>}

      <div className={Style.card}>
        <div className={Style.cardHead}>
          <div>
            <div className={Style.cardTitle}>Ro'yxat</div>
            <div className={Style.cardHint}>
              Ko'rinmoqda <span className={Style.mono}>{filteredBins.length}</span> / <span className={Style.mono}>{bins.length}</span>
            </div>
          </div>
          <div className={Style.cardHint}>Sahifa <span className={Style.mono}>{currentPage}/{totalPages}</span></div>
        </div>

        <div className={Style.tableWrap}>
          <table className={Style.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Nomi</th>
                <th>Status</th>
                <th>Fill</th>
                <th>Lat</th>
                <th>Lng</th>
                <th>Haydovchilar</th>
                <th>Amallar</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className={Style.tEmpty}>Yuklanmoqda…</td></tr>
              ) : bins.length === 0 ? (
                <tr><td colSpan={8} className={Style.tEmpty}>Hozircha trashbin yo'q</td></tr>
              ) : (
                pagedBins.map((b) => {
                  const isFull = b.status === "FULL" || num(b.fillLevel) >= 90;
                  return (
                    <tr key={b.id}>
                      <td className={Style.mono}>{b.id}</td>
                      <td>{b.name}</td>
                      <td>
                        <span className={isFull ? Style.badgeRed : Style.badgeGreen}>
                          {isFull ? "FULL" : "EMPTY"}
                        </span>
                      </td>
                      <td className={Style.mono}>{num(b.fillLevel)}%</td>
                      <td className={Style.mono}>{Number(b.latitude).toFixed(5)}</td>
                      <td className={Style.mono}>{Number(b.longitude).toFixed(5)}</td>
                      <td>
                        {b.drivers?.length ? (
                          <div className={Style.driverBadges}>
                            {b.drivers.map((d) => (
                              <span key={d.id} className={Style.driverBadge}>{driverName(d)}</span>
                            ))}
                          </div>
                        ) : <span className={Style.mono}>—</span>}
                      </td>
                      <td className={Style.actions}>
                        <button className={Style.btnSmall} onClick={() => openEdit(b)}>✏️ Edit</button>
                        <button className={Style.btnDanger} onClick={() => deleteBin(b.id)}>🗑️ Delete</button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
      </div>

      {/* ===== MAIN MODAL ===== */}
      {open && (
        <div className={Style.backdrop} onMouseDown={() => { if (!saving) closeModal(); }}>
          <div className={Style.modal} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">

            {/* Header */}
            <div className={Style.modalHead}>
              <div>
                <div className={Style.modalTitle}>
                  {editing ? "✏️ Trashbin tahrirlash" : "+ Yangi trashbin qo'shish"}
                </div>
                <div className={Style.modalSub}>
                  {editing ? "Faqat fill level va haydovchilar o'zgaradi" : "Yangi trashbin ma'lumotlarini kiriting"}
                </div>
              </div>
              <button className={Style.iconBtn} onClick={closeModal} type="button">✕</button>
            </div>

            {driversErr && (
              <div className={Style.note}>ℹ️ Haydovchilar ro'yxatini olishda muammo: {driversErr}</div>
            )}

            {/* Body */}
            <div className={Style.modalBody}>
              <div className={Style.grid}>

                {/* Name */}
                <div className={Style.field}>
                  <div className={Style.label}>Nomi</div>
                  <input
                    className={Style.input}
                    value={form.name}
                    onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                    placeholder="Bin-01"
                    disabled={!!editing}
                  />
                </div>

                {/* Camera ID */}
                <div className={Style.field}>
                  <div className={Style.label}>Camera ID</div>
                  <input
                    className={Style.input}
                    value={form.cameraId}
                    onChange={(e) => setForm((s) => ({ ...s, cameraId: e.target.value }))}
                    placeholder="CAM-001"
                    disabled={!!editing}
                  />
                </div>

                {/* Latitude */}
                <div className={Style.field}>
                  <div className={Style.label}>Latitude</div>
                  <input
                    className={Style.input}
                    value={form.latitude}
                    onChange={(e) => setForm((s) => ({ ...s, latitude: e.target.value }))}
                    placeholder="41.3111"
                    disabled={!!editing}
                  />
                </div>

                {/* Longitude */}
                <div className={Style.field}>
                  <div className={Style.label}>Longitude</div>
                  <input
                    className={Style.input}
                    value={form.longitude}
                    onChange={(e) => setForm((s) => ({ ...s, longitude: e.target.value }))}
                    placeholder="69.2797"
                    disabled={!!editing}
                  />
                </div>

                {/* Qutilar soni */}
                <div className={Style.field}>
                  <div className={Style.label}>Qutilar soni</div>
                  <input
                    className={Style.input}
                    type="number"
                    min={1}
                    value={form.binCount}
                    onChange={(e) => setForm((s) => ({ ...s, binCount: e.target.value }))}
                    placeholder="4"
                  />
                </div>

                {/* Fill Level */}
                <div className={Style.field}>
                  <div className={Style.label}>To'lish darajasi (0–100)</div>
                  <input
                    className={Style.input}
                    type="number"
                    min={0}
                    max={100}
                    value={form.fillLevel}
                    onChange={(e) => setForm((s) => ({ ...s, fillLevel: e.target.value }))}
                    placeholder="0"
                  />
                  <div className={Style.hint}>
                    Status:{" "}
                    <span className={num(form.fillLevel) >= 90 ? Style.textRed : Style.textGreen}>
                      {num(form.fillLevel) >= 90 ? "FULL" : "EMPTY"}
                    </span>
                  </div>
                </div>

                {/* Personnel Assignment */}
                <div className={`${Style.field} ${Style.fieldFull}`}>
                  <div className={Style.sectionLabel}>
                    <span className={Style.sectionNum}>03</span>
                    <span>Haydovchi biriktirish</span>
                  </div>

                  {/* Selected driver cards */}
                  <div className={Style.driverCards}>
                    {selectedDriverObjs.map((d) => (
                      <div key={d.id} className={Style.driverCard}>
                        <div className={Style.driverCardIco}>🚚</div>
                        <div className={Style.driverCardInfo}>
                          <div className={Style.driverCardName}>{driverName(d)}</div>
                          <div className={Style.driverCardSub}>{d.username}</div>
                        </div>
                        <button
                          className={Style.driverCardCheck}
                          type="button"
                          onClick={() => removeDriver(String(d.id))}
                          title="Olib tashlash"
                        >
                          ✓
                        </button>
                      </div>
                    ))}

                    {/* + Assign button */}
                    <button
                      className={Style.assignBtn}
                      type="button"
                      onClick={() => { setDriverSearch(""); setDriverPickerOpen(true); }}
                    >
                      + Haydovchi biriktirish
                    </button>
                  </div>
                </div>

              </div>
            </div>

            {/* Footer actions */}
            <div className={Style.modalActions}>
              <button className={Style.btnDiscard} onClick={closeModal} type="button" disabled={saving}>
                ✕ Bekor qilish
              </button>
              <button
                className={Style.btnRegister}
                onClick={editing ? updateBin : createBin}
                disabled={saving}
                type="button"
              >
                {saving ? "Saqlanmoqda…" : editing ? "🖊 Saqlash" : "🗑 Ro'yxatga olish"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== DRIVER PICKER SUB-MODAL ===== */}
      {open && driverPickerOpen && (
        <div
          className={Style.pickerBackdrop}
          onMouseDown={() => setDriverPickerOpen(false)}
        >
          <div className={Style.pickerModal} onMouseDown={(e) => e.stopPropagation()}>
            <div className={Style.pickerHead}>
              <div>
                <div className={Style.pickerTitle}>Haydovchi tanlash</div>
                <div className={Style.pickerSub}>Mavjud haydovchilardan birini tanlang</div>
              </div>
              <button className={Style.iconBtn} type="button" onClick={() => setDriverPickerOpen(false)}>✕</button>
            </div>

            <div className={Style.pickerSearch}>
              <span className={Style.pickerSearchIco}>🔍</span>
              <input
                className={Style.pickerSearchInput}
                value={driverSearch}
                onChange={(e) => setDriverSearch(e.target.value)}
                placeholder="Ismi yoki username bo'yicha qidirish..."
                autoFocus
              />
            </div>

            {filteredDrivers.length > 0 && (
              <div className={Style.pickerLabel}>MAVJUD HAYDOVCHILAR</div>
            )}

            <div className={Style.pickerList}>
              {filteredDrivers.length === 0 ? (
                <div className={Style.pickerEmpty}>Haydovchi topilmadi</div>
              ) : (
                filteredDrivers.map((d) => {
                  const selected = form.driverIds.includes(String(d.id));
                  return (
                    <div
                      key={d.id}
                      className={`${Style.pickerItem} ${selected ? Style.pickerItemSelected : ""}`}
                      onClick={() => toggleDriver(String(d.id))}
                    >
                      <div className={Style.pickerItemIco}>🚚</div>
                      <div className={Style.pickerItemInfo}>
                        <div className={Style.pickerItemName}>{driverName(d)}</div>
                        <div className={Style.pickerItemSub}>@{d.username}</div>
                      </div>
                      <div className={`${Style.pickerRadio} ${selected ? Style.pickerRadioChecked : ""}`}>
                        {selected && <span className={Style.pickerRadioDot}/>}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className={Style.pickerFoot}>
              <button
                className={Style.pickerCancelBtn}
                type="button"
                onClick={() => setDriverPickerOpen(false)}
              >
                Orqaga qaytish
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
