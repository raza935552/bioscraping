import { useState } from "react";
import { api } from "../api.js";

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match");
    if (password.length < 10) return setError("Use at least 10 characters");
    setBusy(true);
    setError("");
    try {
      await api.acceptInvite(token, password);
      window.location.hash = "/dashboard";
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1>Set your password</h1>
        <p className="muted">You've been invited to the BiolinX affiliate engine.</p>
        <input
          type="password"
          placeholder="New password (10+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Activate account"}
        </button>
      </form>
    </div>
  );
}
