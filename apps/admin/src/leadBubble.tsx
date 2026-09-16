// The "how we found them · what to do" cell on the Leads tables. Hover (or tap) shows a bubble with
// the acquisition channel, the competitor proof, how to reach them, and the next step from the
// outreach flow chart, so an outreach person can act without opening the lead.

import { useEffect, useRef, useState } from "react";
import type { LeadRow } from "./api.js";
import { PATH_LABEL } from "./labels.js";

const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);

export interface NextStep {
  tone: "go" | "wait" | "stop";
  title: string;
  detail: string;
}

/** The next thing an outreach person should do with this lead, in the order the flow chart decides it. */
export function nextStep(l: LeadRow): NextStep {
  const brand = l.competitorLinked ?? l.competitor ?? "their competitor";
  const channel = l.platform ? `${l.platform} DM` : "DM";
  const status = l.status ?? "Not contacted";
  if (l.outreachPath === "converted") return { tone: "stop", title: "Already our affiliate", detail: "Nothing to send." };
  if (l.isDead) return { tone: "stop", title: "Skip: unreachable", detail: "The account couldn't be found or has gone quiet." };
  if ((l.subProfile ?? "").toUpperCase().startsWith("SP5")) return { tone: "stop", title: "Never message", detail: "Goodwill advocate (SP5): they already like Biolinx; a pitch would do harm." };
  if (["Signed", "Signed up"].includes(status)) return { tone: "stop", title: "Signed", detail: "They've signed up. Nothing to send." };
  if (["Passed", "No"].includes(status)) return { tone: "stop", title: "Closed", detail: "They said no or were passed on." };
  switch (l.outreachPath) {
    case "unsigned":
      return { tone: "stop", title: "Don't message", detail: "Not signed with a competitor. The outreach flow only contacts competitor affiliates." };
    case "competitor_unnamed":
      return { tone: "wait", title: "Find their competitor first", detail: `They promote a brand, but which one isn't identified${l.competitor ? ` ("${l.competitor}")` : ""}. Check the proof, then link the brand so the right offer can be chosen.` };
    case "rate_unknown":
      return { tone: "wait", title: `Waiting for ${brand}'s rate`, detail: `Don't message yet. The offer depends on what ${brand} pays them. Add ${brand}'s commission rate on Audiences → Competitors and the offer appears here.` };
    case "higher":
      return { tone: "stop", title: "Don't message", detail: `${brand} pays ${l.competitorRatePct}%, more than our 25%. The flow has no offer for them.` };
    case "offer1":
    case "offer2": {
      const offer = l.outreachPath === "offer1" ? "Offer 1" : "Offer 2";
      const why = l.outreachPath === "offer1" ? `${brand} pays ${l.competitorRatePct}%, under our 25% for life.` : `${brand} already pays 25%: match it and lead with the perks.`;
      if (status === "Not contacted") return { tone: "go", title: `Send ${offer} · ${channel}`, detail: `${why} Use the ${offer} message (soft or direct).${l.affiliateCode ? ` Their code with ${brand} is ${l.affiliateCode}.` : ""}` };
      if (status === "Contacted") return { tone: "wait", title: "Waiting for their reply", detail: `Messaged ${l.lastReachedOut?.slice(0, 10) ?? ""} (touch ${l.followUpsSent}). When they answer, log it: yes → sign-up details, tell me more → program details, no → the next offer.` };
      return { tone: "go", title: "Continue the conversation", detail: `Status: ${status}. Follow the reply flow for ${offer}.` };
    }
    default:
      return { tone: "wait", title: "Recompute ranks", detail: "This lead has no outreach path yet." };
  }
}

const TONE_CHIP: Record<NextStep["tone"], string> = { go: "ok", wait: "unresolved", stop: "failed" };

function channelShort(l: LeadRow): string {
  const c = l.details?.channel;
  if (!c) return l.platform ? `${l.platform} · source not recorded` : "Source not recorded";
  if (c.kind === "competitor") return `🔎 ${c.label.replace(/ \(competitor affiliates\)$/, "")}`;
  if (c.kind === "hashtag") return `# ${c.label}`;
  if (c.kind === "research") return `📋 ${c.label.replace(/^Research board · /, "")}`;
  return `🔎 ${c.label}`;
}

export function LeadBubbleCell({ l }: { l: LeadRow }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const step = nextStep(l);
  const show = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    if (anchor.current) setRect(anchor.current.getBoundingClientRect());
  };
  const hideSoon = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setRect(null), 180);
  };
  useEffect(() => {
    if (!rect) return;
    const close = () => setRect(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [rect]);

  const width = 360;
  const left = rect ? Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) : 0;
  const below = rect ? rect.bottom + 6 + 320 < window.innerHeight : true;

  return (
    <div
      ref={anchor}
      className="bubble-anchor"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onClick={(e) => {
        e.stopPropagation();
        if (rect) setRect(null);
        else show();
      }}
    >
      <div className="bubble-channel" title="How we found them">{channelShort(l)}</div>
      <span className={`chip ${TONE_CHIP[step.tone]}`}>{step.title}</span>
      {rect && (
        <div
          className="bubble"
          style={{ left, width, ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) }}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bubble-section">
            <div className="k">What to do</div>
            <div className={`bubble-step ${step.tone}`}>{step.title}</div>
            <div className="muted">{step.detail}</div>
          </div>
          <div className="bubble-section">
            <div className="k">How we found them</div>
            <div>{l.details?.channel?.label ?? "Not recorded"}</div>
            {l.details?.audience && <div className="muted">Audience: {l.details.audience}</div>}
            {isHttp(l.details?.surfaced?.url ?? l.details?.evidence?.url) && (
              <a href={(l.details?.surfaced?.url ?? l.details?.evidence?.url)!} target="_blank" rel="noreferrer">
                The post ↗
              </a>
            )}
          </div>
          <div className="bubble-section">
            <div className="k">Competitor</div>
            {l.competitor || l.competitorLinked ? (
              <>
                <div>
                  <strong>{l.competitorLinked ?? l.competitor}</strong>
                  {l.affiliateCode && <> · code <code>{l.affiliateCode}</code></>}
                  {l.competitorRatePct != null ? ` · pays ${l.competitorRatePct}%` : " · rate not on file"}
                </div>
                {l.details?.evidence && <div className="muted bubble-quote">“{l.details.evidence.quote}”</div>}
                {l.outreachPath && PATH_LABEL[l.outreachPath] && <div className="muted">{PATH_LABEL[l.outreachPath]!.short}</div>}
              </>
            ) : (
              <div className="muted">None found</div>
            )}
          </div>
          <div className="bubble-section">
            <div className="k">Reach them</div>
            <div>
              {l.platform ?? "—"} DM
              {isHttp(l.profileUrl) && (
                <>
                  {" · "}
                  <a href={l.profileUrl} target="_blank" rel="noreferrer">
                    profile ↗
                  </a>
                </>
              )}
              {l.country ? ` · ${l.country}` : " · location unknown"}
            </div>
            {l.email ? (
              <div>
                ✉ {l.email} <span className="muted">({l.details?.emailSource?.where === "post" ? "in a post" : "in bio"})</span>
              </div>
            ) : (
              <div className="muted">No email found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
