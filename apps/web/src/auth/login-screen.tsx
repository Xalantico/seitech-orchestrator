import { useState, type FormEvent } from "react";

import { useT } from "../lib/i18n";
import { Btn, Field } from "../lib/ui";
import { requestOtp, startOidc, useAuthStore, verifyOtp } from "./store";

export function LoginScreen() {
  const t = useT();
  const mode = useAuthStore((s) => s.mode);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(new URLSearchParams(window.location.search).get("login_error"));
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!sent) {
        await requestOtp(email);
        setSent(true);
      } else {
        await verifyOtp(email, code);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1>{t("login.title")}</h1>
        {error ? <div className="note note-bad" role="alert">{error}</div> : null}
        {mode === "oidc" ? (
          <Btn variant="primary" onClick={startOidc}>{t("login.sso")}</Btn>
        ) : (
          <>
            <Field label={t("login.email")}><input type="email" required autoFocus autoComplete="email" value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} /></Field>
            {sent ? (
              <Field label={t("login.code")} hint={`${t("login.codeSent")} ${email}`}>
                <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              </Field>
            ) : null}
            <Btn variant="primary" type="submit" disabled={busy}>{sent ? t("login.verify") : t("login.sendCode")}</Btn>
          </>
        )}
      </form>
    </div>
  );
}
