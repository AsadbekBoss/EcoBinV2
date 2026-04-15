"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { getSession, login, redirectByRole, seedUsersIfEmpty } from "@/lib/auth";
import styles from "./login.module.css";

type ToastType = "ok" | "err" | "info";
type ToastState = { open: boolean; type: ToastType; title: string; desc?: string };

const slides = ["/login-1.png", "/login-2.png", "/login-3.png"];

export default function LoginPage() {
  const r = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow]         = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading]   = useState(false);
  const [idx, setIdx]           = useState(0);
  const [visible, setVisible]   = useState(true);

  const [toast, setToast] = useState<ToastState>({ open: false, type: "info", title: "" });
  const toastTimer = useRef<number | null>(null);

  const pushToast = useCallback((type: ToastType, title: string, desc?: string) => {
    setToast({ open: true, type, title, desc });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast((p) => ({ ...p, open: false })), 3000);
  }, []);

  useEffect(() => {
    seedUsersIfEmpty();
    try {
      const raw = sessionStorage.getItem("login_toast");
      if (raw) {
        sessionStorage.removeItem("login_toast");
        const info = JSON.parse(raw);
        pushToast("info", String(info?.title || "Ma'lumot"), info?.desc ? String(info.desc) : undefined);
      }
    } catch {}
    const s = getSession();
    if (s?.role) r.replace(redirectByRole(s.role));
  }, [r, pushToast]);

  useEffect(() => {
    const iv = window.setInterval(() => {
      setVisible(false);
      window.setTimeout(() => { setIdx((p) => (p + 1) % slides.length); setVisible(true); }, 400);
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  async function submit() {
    if (loading) return;
    const u = username.trim();
    if (!u || !password) { pushToast("info", "Username va parolni kiriting"); return; }
    try {
      setLoading(true);
      const s = await login(u, password, remember);
      pushToast("ok", "Xush kelibsiz!");
      setTimeout(() => r.replace(redirectByRole(s.role)), 500);
    } catch (e: unknown) {
      pushToast("err", "Kirish amalga oshmadi", e instanceof Error ? e.message : "Login yoki parol noto'g'ri");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.shell}>

      {/* Toast */}
      <div className={`${styles.toast} ${toast.open ? styles.toastShow : ""} ${styles[toast.type]}`}>
        <span className={styles.toastIco}>
          {toast.type === "ok"  ? <i className="ri-checkbox-circle-fill" /> :
           toast.type === "err" ? <i className="ri-error-warning-fill" />   :
                                  <i className="ri-information-fill" />}
        </span>
        <div className={styles.toastBody}>
          <p className={styles.toastTitle}>{toast.title}</p>
          {toast.desc && <p className={styles.toastDesc}>{toast.desc}</p>}
        </div>
        <button className={styles.toastClose} onClick={() => setToast((p) => ({ ...p, open: false }))}>
          <i className="ri-close-line" />
        </button>
      </div>

      {/* Mobile background slides */}
      <div className={styles.mobileBg}>
        <div className={`${styles.mobileBgSlide} ${visible ? styles.slideIn : styles.slideOut}`}>
          <Image src={slides[idx]} alt="" fill priority className={styles.mobileBgImg} />
        </div>
        <div className={styles.mobileBgOverlay} />
      </div>

      {/* Card */}
      <div className={styles.card}>

        {/* Left — carousel */}
        <div className={styles.hero}>
          <div className={`${styles.slide} ${visible ? styles.slideIn : styles.slideOut}`}>
            <Image src={slides[idx]} alt="" fill priority className={styles.slideImg} />
          </div>
          <div className={styles.heroOverlay} />

          <div className={styles.heroBrand}>
            <i className="ri-leaf-line" />
            <span>OBOD SHAHAR</span>
          </div>

          <div className={styles.dots}>
            {slides.map((_, i) => (
              <button key={i}
                className={`${styles.dot} ${i === idx ? styles.dotActive : ""}`}
                onClick={() => { setVisible(false); window.setTimeout(() => { setIdx(i); setVisible(true); }, 200); }}
                aria-label={`Slide ${i + 1}`}
              />
            ))}
          </div>
        </div>

        {/* Right — form */}
        <div className={styles.form}>
          <div className={styles.formTop}>
            <div className={styles.brand}>
              <div className={styles.brandIco}><i className="ri-recycle-line" /></div>
              <div>
                <div className={styles.brandName}>EcoBin AI</div>
                <div className={styles.brandSub}>Monitoring tizimi</div>
              </div>
            </div>
          </div>

          <div className={styles.formBody}>
            <h1 className={styles.title}>Xush kelibsiz</h1>

            <div className={styles.field}>
              <span className={styles.fieldIco}><i className="ri-user-3-line" /></span>
              <input
                className={styles.input}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                autoComplete="username"
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.fieldIco}><i className="ri-lock-2-line" /></span>
              <input
                className={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Parol"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <button className={styles.eye} onClick={() => setShow((v) => !v)} type="button">
                <i className={show ? "ri-eye-off-line" : "ri-eye-line"} />
              </button>
            </div>

            <label className={styles.remember}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Eslab qolish</span>
            </label>

            <button className={styles.btn} onClick={submit} disabled={loading} type="button">
              {loading
                ? <><i className="ri-loader-4-line" style={{animation:"spin .8s linear infinite"}} /> Kirilmoqda...</>
                : <>Kirish <i className="ri-arrow-right-line" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
