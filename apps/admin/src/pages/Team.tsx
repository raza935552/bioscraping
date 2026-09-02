import { useCallback, useEffect, useState } from "react";
import { PageInfo } from "../components.js";
import { api, type TeamMember } from "../api.js";

export function Team() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("rep");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers(await api.team());
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.invite(name, email, role);
      setName("");
      setEmail("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageInfo title="Team — accounts & roles">Invite teammates by email and assign a role: admin (full control), ops (run jobs, classify, provision), rep (Motion B outreach), operator (approve/send messages). Invites are single-use links; the person sets their own password.</PageInfo>
      <h1>Team</h1>
      <form className="toolbar" onSubmit={invite}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required style={{ maxWidth: 180 }} />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ maxWidth: 240 }}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 130 }}>
          <option value="rep">rep</option>
          <option value="operator">operator</option>
          <option value="ops">ops</option>
          <option value="admin">admin</option>
        </select>
        <button className="primary" disabled={busy}>
          Invite
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Invite link</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="muted">{m.email}</td>
                <td>{m.role}</td>
                <td>
                  <span className={`chip ${m.activated ? "ok" : "unresolved"}`}>
                    {m.activated ? "active" : "invited"}
                  </span>
                </td>
                <td className="muted">
                  {m.inviteToken ? <code className="inline">#/accept-invite/{m.inviteToken}</code> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
