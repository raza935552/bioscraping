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
import { Templates } from "./pages/Templates.js";
import { Outreach } from "./pages/Outreach.js";
import { Team } from "./pages/Team.js";
import { Requests } from "./pages/Requests.js";
import { ToastHost } from "./toast.js";

const WIDE_ROUTES = new Set(["/leads", "/swipe"]);
/** Pages whose table scrolls on its own, under filters that stay put. */
const TABLE_ROUTES = new Set(["/leads", "/replies", "/signups", "/affiliates"]);

/** Page names for the browser tab. */
const NAV_TITLE: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/outreach": "Outreach",
  "/leads": "Leads",
  "/audiences": "Audiences",
  "/templates": "Message templates",
  "/swipe": "Swipe file",
  "/approvals": "Send messages",
  "/email": "Email ops",
  "/replies": "Replies",
  "/requests": "Requests",
  "/signups": "Signups",
  "/affiliates": "Affiliates",
  "/activity": "Activity",
  "/team": "Team",
  "/settings": "Settings",
};

/** The hash is "#/leads?view=sourced&competitor=amino-club": the path picks the page, the query is
 *  that page's state, so a view can be bookmarked or pasted to someone else. A page writing its own
 *  state back with history.replaceState doesn't fire hashchange, so this only reacts to real
 *  navigation (a link, the back button, a pasted URL). */
function useHashRoute(): { route: string; search: string } {
  const read = () => {
    const raw = window.location.hash.slice(1) || "/dashboard";
    const i = raw.indexOf("?");
    return i < 0 ? { route: raw, search: "" } : { route: raw.slice(0, i), search: raw.slice(i + 1) };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const onChange = () => setState(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return state;
}

export function App() {
  const { route, search } = useHashRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  // How much work is waiting behind each page, so nobody has to open them to find out.
  const [counts, setCounts] = useState<Record<string, number>>({});

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

  // The browser tab says which page this is and how much is waiting on it.
  useEffect(() => {
    const label = NAV_TITLE[route] ?? "BiolinX Engine";
    const n = counts[route] ?? 0;
    document.title = `${n > 0 ? `(${n}) ` : ""}${label} · BiolinX Engine`;
  }, [route, counts]);

  useEffect(() => {
    if (!me) return;
    let stop = false;
    const tick = () => void api.navCounts().then((c) => !stop && setCounts(c)).catch(() => {});
    tick();
    // Refresh while the tab is in front; leaving it open overnight shouldn't poll.
    const timer = window.setInterval(() => document.visibilityState === "visible" && tick(), 60_000);
    window.addEventListener("focus", tick);
    return () => {
      stop = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [me, route]);

  if (route.startsWith("/accept-invite/")) {
    return <AcceptInvite token={route.split("/")[2] ?? ""} onDone={refreshMe} />;
  }
  if (!checked) return null;
  if (!me) return <Login onDone={refreshMe} />;

  // Outreach people (operator role) see only their page and sign-ups.
  const nav = me.role === "operator" ? ([["/outreach", "Outreach", "💌"], ["/signups", "Signups", "✍️"]] as const) : ([
    ["/dashboard", "Dashboard", "📊"],
    ...(me.role === "admin" || me.role === "ops" ? ([["/outreach", "Outreach", "💌"]] as const) : []),
    ["/leads", "Leads", "🎯"],
    ...(me.role === "admin" || me.role === "ops" ? ([["/audiences", "Audiences", "🔎"], ["/templates", "Message templates", "📝"], ["/swipe", "Swipe file", "🖼️"]] as const) : []),
    ["/approvals", "Send messages", "✉️"],
    ["/email", "Email ops", "📮"],
    ["/replies", "Replies", "💬"],
    ...(me.role === "admin" || me.role === "ops" ? ([["/requests", "Requests", "📥"]] as const) : []),
    ["/signups", "Signups", "✍️"],
    ["/affiliates", "Affiliates", "🤝"],
    ["/activity", "Activity", "🕡"],
    ...(me.role === "admin" ? ([["/team", "Team", "👥"], ["/settings", "Settings", "⚙️"]] as const) : []),
  ] as const);

  // Outreach people only use their page and Signups; anything else lands on Outreach.
  const allowed = me.role !== "operator" || ["/outreach", "/signups"].includes(route);
  const page = () => {
    if (!allowed) return <Outreach me={me} />;
    switch (route) {
      case "/leads":
        return <Leads key={search} me={me} initialQuery={search} />;
      case "/audiences":
        return <Audiences />;
      case "/outreach":
        return <Outreach me={me} />;
      case "/templates":
        return <Templates />;
      case "/swipe":
        return <Swipe me={me} />;
      case "/approvals":
        return <Approvals me={me} />;
      case "/email":
        return <Email />;
      case "/replies":
        return <Replies />;
      case "/requests":
        return <Requests me={me} />;
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
        return me.role === "operator" ? <Outreach me={me} /> : <Dashboard me={me} />;
    }
  };

  return (
    <div className="layout">
      <nav className="nav">
        <div className="brand">⚗️ BiolinX Engine</div>
        {nav.map(([path, label, ico]) => (
          <a key={path} href={`#${path}`} className={route === path ? "active" : ""}>
            <span className="ico">{ico}</span>
            <span className="nav-label">{label}</span>
            {counts[path] ? <span className="nav-badge" title={`${counts[path]} waiting`}>{counts[path] > 99 ? "99+" : counts[path]}</span> : null}
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
      <ToastHost />
      <main className={`main${WIDE_ROUTES.has(route) ? " wide" : ""}${allowed && TABLE_ROUTES.has(route) ? " table-page" : ""}`}>{page()}</main>
    </div>
  );
}
