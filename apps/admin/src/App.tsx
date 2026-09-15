import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "./api.js";
import { AcceptInvite } from "./pages/AcceptInvite.js";
import { Activity } from "./pages/Activity.js";
import { Affiliates } from "./pages/Affiliates.js";
import { Approvals } from "./pages/Approvals.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Email } from "./pages/Email.js";
import { Leads } from "./pages/Leads.js";
import { Audiences } from "./pages/Audiences.js";
import { Login } from "./pages/Login.js";
import { Replies } from "./pages/Replies.js";
import { Settings } from "./pages/Settings.js";
import { Signups } from "./pages/Signups.js";
import { Swipe } from "./pages/Swipe.js";
import { Team } from "./pages/Team.js";

const WIDE_ROUTES = new Set(["/leads", "/swipe"]);

function useHashRoute(): string {
  const [route, setRoute] = useState(window.location.hash.slice(1) || "/dashboard");
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || "/dashboard");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  if (route.startsWith("/accept-invite/")) {
    return <AcceptInvite token={route.split("/")[2] ?? ""} onDone={refreshMe} />;
  }
  if (!checked) return null;
  if (!me) return <Login onDone={refreshMe} />;

  const nav = [
    ["/dashboard", "Dashboard", "📊"],
    ["/leads", "Leads", "🎯"],
    ...(me.role === "admin" || me.role === "ops" ? ([["/audiences", "Audiences", "🔎"], ["/swipe", "Swipe file", "🖼️"]] as const) : []),
    ["/approvals", "Send messages", "✉️"],
    ["/email", "Email ops", "📮"],
    ["/replies", "Replies", "💬"],
    ["/signups", "Signups", "✍️"],
    ["/affiliates", "Affiliates", "🤝"],
    ["/activity", "Activity", "🕡"],
    ...(me.role === "admin" ? ([["/team", "Team", "👥"], ["/settings", "Settings", "⚙️"]] as const) : []),
  ] as const;

  const page = () => {
    switch (route) {
      case "/leads":
        return <Leads me={me} />;
      case "/audiences":
        return <Audiences />;
      case "/swipe":
        return <Swipe me={me} />;
      case "/approvals":
        return <Approvals me={me} />;
      case "/email":
        return <Email />;
      case "/replies":
        return <Replies />;
      case "/signups":
        return <Signups me={me} />;
      case "/affiliates":
        return <Affiliates me={me} />;
      case "/activity":
        return <Activity />;
      case "/team":
        return <Team />;
      case "/settings":
        return <Settings />;
      default:
        return <Dashboard me={me} />;
    }
  };

  return (
    <div className="layout">
      <nav className="nav">
        <div className="brand">⚗️ BiolinX Engine</div>
        {nav.map(([path, label, ico]) => (
          <a key={path} href={`#${path}`} className={route === path ? "active" : ""}>
            <span className="ico">{ico}</span>
            {label}
          </a>
        ))}
        <div className="spacer" />
        <div className="whoami">
          {me.name} · {me.role}
        </div>
        <button
          onClick={() => {
            void api.logout().then(() => setMe(null));
          }}
        >
          Sign out
        </button>
      </nav>
      {/* Data-heavy pages use the full width; the rest keep a readable column. */}
      <main className={`main${WIDE_ROUTES.has(route) ? " wide" : ""}`}>{page()}</main>
    </div>
  );
}
