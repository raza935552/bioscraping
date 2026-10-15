import { useCallback, useEffect, useState } from "react";
import { PageInfo } from "../components.js";
import { api, type TeamMember } from "../api.js";
import { ROLE_HELP } from "../labels.js";
import { copyText } from "../outreachShared.js";
import { toast, toastError } from "../toast.js";

/** The link the API gives us, or the same thing built here if an older API answered. */
function linkFor(m: TeamMember): string | null {
  if (m.inviteUrl) return m.inviteUrl;
  return m.inviteToken ? `${window.location.origin}/#/accept-invite/${m.inviteToken}` : null;
}

/** Opens their own mail app with the invite written out. Nothing is sent from the server: the
 *  message comes from the person inviting, which is also why it lands rather than going to spam. */
function mailtoFor(m: TeamMember, link: string): string {
  const first = m.name.trim().split(/\s+/)[0] ?? "there";
  const body = [
    `Hi ${first},`,
    "",
    "Here is your login for the BiolinX affiliate engine:",
    link,
    "",
    "Open it and set your own password. The link works once, and only for you.",
  ].join("\n");
  return `mailto:${m.email}?subject=${encodeURIComponent("Your BiolinX Engine login")}&body=${encodeURIComponent(body)}`;
}

export function Team() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("rep");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [justInvited, setJustInvited] = useState<number | null>(null);

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
      const invitedEmail = email.trim().toLowerCase();
      setName("");
      setEmail("");
      const rows = await api.team();
      setMembers(rows);
      setJustInvited(rows.find((m) => m.email === invitedEmail)?.id ?? null);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (link: string) =>
    void copyText(link).then((ok) => (ok ? toast("Invite link copied.") : toastError("Couldn't copy the link.")));

  const fresh = members.find((m) => m.id === justInvited);
  const freshLink = fresh ? linkFor(fresh) : null;

  return (
    <>
      <PageInfo title="Team — accounts & roles">
        Invite a teammate, then send them their link. Nothing is emailed automatically: press{" "}
        <strong>Email it</strong> to open your own mail app with the message written out, or copy the link and send it
        however you like. Each link works once, and the person sets their own password.
        <ul className="legend">
          {Object.entries(ROLE_HELP).map(([role, help]) => (
            <li key={role}>
              <span className="chip internal">{role}</span> {help}
            </li>
          ))}
        </ul>
      </PageInfo>
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
      {fresh && freshLink && (
        <div className="invite-fresh">
          <div>
            <strong>{fresh.name}</strong> is invited as <span className="chip internal">{fresh.role}</span>. Send them
            this link — they can't get in without it.
          </div>
          <code className="inline invite-link">{freshLink}</code>
          <div className="row">
            <button type="button" className="primary" onClick={() => copy(freshLink)}>
              📋 Copy link
            </button>
            <a className="button" href={mailtoFor(fresh, freshLink)}>
              ✉️ Email it to {fresh.email}
            </a>
          </div>
        </div>
      )}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Their link</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const link = linkFor(m);
              return (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="muted">{m.email}</td>
                  <td>{m.role}</td>
                  <td>
                    <span className={`chip ${m.activated ? "ok" : "unresolved"}`}>
                      {m.activated ? "active" : "invited"}
                    </span>
                  </td>
                  <td>
                    {link ? (
                      <div className="invite-cell">
                        <code className="inline invite-link">{link}</code>
                        <button type="button" onClick={() => copy(link)} title="Copy the link">
                          Copy
                        </button>
                        <a className="button" href={mailtoFor(m, link)} title="Open your mail app with it written out">
                          Email it
                        </a>
                      </div>
                    ) : (
                      <span className="muted">already set up</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
