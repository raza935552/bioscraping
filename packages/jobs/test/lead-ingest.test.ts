import { describe, expect, it } from "vitest";
import type { DiscoveryHit } from "@biolinx/scraping";
import { emptyKnown } from "@biolinx/scraping";
import { linkCompetitor } from "../src/qualification.js";
import { isCompetitorOwnAccount, COMPETITOR_FOLLOWER_MIN, followerMinFor, competitorOfTerm, competitorQueries, recordSuggestions, parseMaxPending, reviewRoom, byNichePriority, activeGated, applyTermOutcome, interleaveByPlatform, countFresh, effectiveSpendCap, ingestDepsFromEnv, ranToday, isDuplicateKey, isResting, parseDailyLimit, planProfile, planSearches, recordTermRun, restUntilAfterRun, startOfBusinessDay, verifyReserveUsd, type ProfileRow, type VerifyFn } from "../src/lead-ingest.js";

const profile: ProfileRow = {
  id: 1,
  name: "Weight-loss TikTok",
  active: true,
  niche: "Weight-loss seeker",
  brandFit: "both",
  platforms: ["tiktok"],
  terms: { tiktok: ["#perimenopause"] },
  seedAccounts: null,
  followerMin: { tiktok: 5000 },
  followerMax: { tiktok: 500000 },
  activityDays: 30,
  countries: ["US"],
  language: "en",
  matchTerms: ["menopause"],
  excludeTerms: ["ozempic"],
  excludeHandles: [],
  dailyCap: 2,
  spendCapUsd: "2.00",
};
const hit = (handle: string, over: Partial<DiscoveryHit> = {}): DiscoveryHit => ({
  platform: "tiktok",
  handle,
  profileUrl: `https://www.tiktok.com/@${handle}`,
  displayName: handle,
  bio: "menopause coach",
  followers: 40000,
  postUrl: `https://www.tiktok.com/@${handle}/video/1`,
  postText: "menopause tips",
  postedAt: "2026-09-10T00:00:00.000Z",
  country: "US",
  isRepost: null,
  term: "#perimenopause",
  ...over,
});
const verified =
  (followers: number): VerifyFn =>
  async (h) => ({
    followers,
    bio: h.bio,
    lastPostAt: "2026-09-12T00:00:00.000Z",
    isRepostRatio: 0,
    profileUrl: h.profileUrl,
    items: [{ url: `${h.profileUrl}/video/2`, text: "menopause tips", postedAt: "2026-09-12T00:00:00.000Z", likes: 10 }],
  });
const now = new Date("2026-09-14T00:00:00.000Z");

describe("planProfile", () => {
  it("filters, dedupes, verifies highest-first, scores, respects the daily cap, and explains", async () => {
    const known = emptyKnown();
    known.handles.add("tiktok:known1");
    const hits = new Map([
      [
        "#perimenopause",
        [hit("a", { followers: 10000 }), hit("b", { followers: 90000 }), hit("c", { followers: 50000 }), hit("known1"), hit("tiny", { followers: 10 }), hit("de", { country: "DE" })],
      ],
    ]);
    const { candidates, summary } = await planProfile(profile, [], hits, known, verified(60000), now);
    expect(summary).toMatchObject({
      hits: 6,
      alreadyKnown: 1,
      rejected: { followers_low: 1, country: 1, excluded_handle: 0, excluded_term: 0, followers_high: 0 },
      verified: 2,
      inserted: 2,
      stoppedBy: "cap",
    });
    expect(candidates.map((c) => c.hit.handle)).toEqual(["b", "c"]);
    expect(candidates[0]?.lead).toMatchObject({
      firstName: "b",
      primaryPlatform: "TikTok",
      socialProfiles: "TikTok @b",
      totalReach: 60000,
      reachSourceUrl: "https://www.tiktok.com/@b",
      whereFound: "https://www.tiktok.com/@b/video/1",
      niche: "Weight-loss seeker",
      brandFit: "both",
      sourcingReview: "pending",
      sourcingProfileId: 1,
      sourcingReason: "found by Weight-loss TikTok via #perimenopause",
      status: "Not contacted",
      motion: "A",
      source: "sourcing",
      affiliationStatus: "Unsigned",
    });
    expect(candidates[0]?.lead.sourcingScore).toBe(45); // reach 15 + active 15 + original 5 + on-niche 10
    expect(candidates[0]?.lead.sourcingSample).toHaveLength(2); // surfaced post + 1 verified item
    expect(candidates[0]?.enrichment?.status).toBe("sourced");
  });

  it("stops on the spend cap and reports it", async () => {
    const cheap = { ...profile, spendCapUsd: "0.01", dailyCap: 50 };
    const hits = new Map([["#perimenopause", Array.from({ length: 10 }, (_, i) => hit(`h${i}`))]]);
    const { summary } = await planProfile(cheap, [], hits, emptyKnown(), verified(60000), now);
    expect(summary.stoppedBy).toBe("spend");
    expect(summary.verified).toBe(0); // 10 discovery items cost 0.02 > cap before any read
  });

  it("competitor match sets Signed elsewhere, competitor name, and the code; code dedupes", async () => {
    const ps = { id: 9, name: "Peptide Sciences", domains: [], codePattern: null, codePrefix: "PS", commissionPct: 15 };
    const hits = new Map([["#perimenopause", [hit("x", { bio: "use code PSANN for 10% off" })]]]);
    const { candidates } = await planProfile(profile, [ps], hits, emptyKnown(), verified(60000), now);
    expect(candidates[0]?.lead).toMatchObject({ affiliationStatus: "Signed elsewhere", otherCreatorCompany: "Peptide Sciences", affiliateCode: "PSANN", competitorId: 9 });
    const known = emptyKnown();
    known.codes.add("psann");
    const again = await planProfile(profile, [ps], hits, known, verified(60000), now);
    expect(again.summary.alreadyKnown).toBe(1);
  });

  it("a failed profile read is counted and the person is not saved, nor remembered (it may be a timeout)", async () => {
    const hits = new Map([["#perimenopause", [hit("v"), hit("private")]]]);
    const flaky: VerifyFn = async (h) => {
      if (h.handle === "v") throw new Error("actor timeout");
      return null; // private or gone
    };
    const { candidates, summary } = await planProfile(profile, [], hits, emptyKnown(), flaky, now);
    expect(summary.verifyFailed).toBe(1);
    expect(candidates).toEqual([]);
    expect(summary.quality?.no_read).toBe(2);
    expect(summary.gated).toEqual([]);
  });
});

describe("planSearches", () => {
  const base = { platforms: ["tiktok", "reddit"] as ProfileRow["platforms"], terms: { tiktok: ["#weightloss", "#glp1journey"], reddit: ["r/loseit"] }, dailyCap: 10, spendCapUsd: "1.00" };
  const competitors = [{ name: "Peptide Sciences" }, { name: "Limitless Life" }];

  it("a small share of audience terms first, then competitor code searches, never competitor names on Reddit", () => {
    const { run, skipped } = planSearches(base, competitors, 30);
    // Audience terms may use 20% of the budget up front ($0.15 of $0.75): one hashtag. Then every
    // competitor's "code" search, then "discount", then the audience terms that still fit.
    expect(run.map((s) => `${s.platform} ${s.term}`)).toEqual([
      "tiktok #weightloss",
      "tiktok Peptide Sciences code",
      "tiktok Limitless Life code",
      "tiktok Peptide Sciences discount",
      "tiktok Limitless Life discount",
      "reddit r/loseit",
    ]);
    expect(skipped.map((s) => s.term)).toEqual(["#glp1journey"]);
  });

  it("a tight budget still reaches every platform's audience terms, then alternates competitors across platforms", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ name: `Vendor ${i}` }));
    const p = { platforms: ["tiktok", "instagram"] as ProfileRow["platforms"], terms: { tiktok: ["#a", "#b"], instagram: ["#a", "#b"] }, dailyCap: 10, spendCapUsd: "1.00" };
    const { run } = planSearches(p, many, 30);
    const labels = run.map((s) => `${s.platform} ${s.term}`);
    expect(labels.slice(0, 6)).toEqual(["tiktok #a", "instagram #a", "tiktok Vendor 0 code", "instagram Vendor 0", "tiktok Vendor 1 code", "instagram Vendor 1"]);
    expect(labels.filter((l) => l.startsWith("instagram")).length).toBeGreaterThan(2);
  });

  it("rotation starts from a different competitor each day and wraps", () => {
    const three = [{ name: "A" }, { name: "B" }, { name: "C" }];
    // Budget covers all three: every competitor every day, starting one later each day so the later
    // phrasings (discount, domains) reach every competitor over time (review, 2026-09-16).
    const p = { platforms: ["tiktok"] as ProfileRow["platforms"], terms: { tiktok: [] }, dailyCap: 10, spendCapUsd: "1.00" };
    expect(planSearches(p, three, 30, 0).run.map((s) => s.term)).toEqual(["A code", "B code", "C code", "A discount", "B discount", "C discount"]);
    expect(planSearches(p, three, 30, 1).run.map((s) => s.term)).toEqual(["B code", "C code", "A code", "B discount", "C discount", "A discount"]);
    expect(planSearches(p, three, 30, 3).run.map((s) => s.term)[0]).toBe("A code");
  });

  it("consecutive days search different competitors when the budget only covers some", () => {
    const vendors = Array.from({ length: 12 }, (_, i) => ({ name: `V${i}` }));
    // TikTok only, cap $0.50: reserve $0.25, $0.25 budget, $0.09 per keyword search → 2 a day.
    const p = { platforms: ["tiktok"] as ProfileRow["platforms"], terms: { tiktok: [] }, dailyCap: 10, spendCapUsd: "0.50" };
    const day = (d: number) => planSearches(p, vendors, 30, d).run.map((s) => s.term);
    expect(day(0)).toEqual(["V0 code", "V1 code"]);
    expect(day(1)).toEqual(["V2 code", "V3 code"]);
    expect(day(5)).toEqual(["V10 code", "V11 code"]);
    expect(day(6)).toEqual(["V0 code", "V1 code"]);
  });

  it("the spend cap gates searching and keeps a reserve for profile reads", () => {
    // TikTok-only, cap $0.30: 10 TikTok reads would be $0.25 → reserve capped at half ($0.15) → $0.15 for searches at $0.06 → 2 run.
    const p = { ...base, platforms: ["tiktok"] as ProfileRow["platforms"], spendCapUsd: "0.30" };
    const { run, skipped, budgetUsd } = planSearches(p, competitors, 30);
    expect(budgetUsd).toBe(0.15);
    // Audience terms get 20% of $0.15 ($0.03), not enough for a hashtag ($0.06): the competitor code search ($0.09) goes first.
    expect(run.map((s) => s.term)).toEqual(["Peptide Sciences code", "#weightloss"]);
    expect(skipped.map((s) => s.term)).toEqual(["Limitless Life code", "Peptide Sciences discount", "Limitless Life discount", "#glp1journey"]);
    expect(run.reduce((a, s) => a + s.estimatedCostUsd, 0) + verifyReserveUsd(p)).toBeLessThanOrEqual(0.3);
  });

  it("the reserve is priced at the audience's priciest profile read and never takes more than half the budget", () => {
    expect(verifyReserveUsd({ dailyCap: 10, spendCapUsd: "2.00", platforms: ["tiktok"] })).toBe(0.25);
    expect(verifyReserveUsd({ dailyCap: 10, spendCapUsd: "2.00", platforms: ["instagram"] })).toBe(0.083); // profile + About this account
    expect(verifyReserveUsd({ dailyCap: 10, spendCapUsd: "2.00", platforms: ["instagram", "youtube"] })).toBe(0.12);
    expect(verifyReserveUsd({ dailyCap: 500, spendCapUsd: "1.00" })).toBe(0.5);
  });

  it("resting searches are left out and cost nothing; freed budget reaches the next ones", () => {
    const p = { ...base, platforms: ["tiktok"] as ProfileRow["platforms"], spendCapUsd: "0.30" };
    const { run, resting } = planSearches(p, competitors, 30, 0, (_pl, t) => t === "#weightloss");
    expect(resting.map((s) => s.term)).toEqual(["#weightloss"]);
    expect(run.map((s) => s.term)).toEqual(["Peptide Sciences code", "#glp1journey"]);
  });

  it("a competitor hashtag audience term and the competitor's code search are different searches", () => {
    const { run } = planSearches({ ...base, platforms: ["tiktok"], terms: { tiktok: ["#peptidesciences"] }, spendCapUsd: "2.00" }, competitors, 30);
    expect(run.map((s) => s.term)).toEqual(["#peptidesciences", "Peptide Sciences code", "Limitless Life code", "Peptide Sciences discount", "Limitless Life discount"]);
  });

  it("competitor searches: three TikTok phrasings priced as keyword searches, no YouTube, Skool keeps the name", () => {
    const club = { name: "Amino Club", domains: ["aminoclub.com", "amino club"] };
    expect(competitorQueries("tiktok", club)).toEqual(["Amino Club code", "Amino Club discount", "aminoclub.com"]);
    expect(competitorQueries("tiktok", { name: "Peptira", domains: ["peptira"] })).toEqual(["Peptira code", "Peptira discount"]);
    expect(competitorQueries("skool", club)).toEqual(["Amino Club"]);
    for (const t of ["amino club code", "Amino Club discount", "aminoclub.com", "Amino Club"]) expect(competitorOfTerm(t, [club])).toBe("Amino Club");
    expect(competitorOfTerm("#aminoclub", [club])).toBeNull();
    const { run } = planSearches({ platforms: ["tiktok"], terms: { tiktok: ["#a"] }, dailyCap: 10, spendCapUsd: "2.00" }, [club], 30);
    expect(run.map((s) => [s.term, s.estimatedCostUsd])).toEqual([["#a", 0.06], ["Amino Club code", 0.09], ["Amino Club discount", 0.09], ["aminoclub.com", 0.09]]);
    const yt = planSearches({ platforms: ["youtube"], terms: { youtube: [] }, dailyCap: 5, spendCapUsd: "1.00" }, [club], 30);
    expect(yt.run).toEqual([]);
  });

  it("competitor-only sourcing runs no audience terms at all", () => {
    const club = { name: "Amino Club", domains: ["aminoclub.com"] };
    const { run } = planSearches({ platforms: ["tiktok", "youtube"], terms: { tiktok: ["#a"], youtube: ["peptides"] }, dailyCap: 10, spendCapUsd: "2.00" }, [club], 30, 0, () => false, new Set(), { competitorOnly: true });
    expect(run.map((s) => `${s.platform} ${s.term}`)).toEqual(["tiktok Amino Club code", "tiktok Amino Club discount", "tiktok aminoclub.com"]);
  });
});

describe("term memory: searches that stop finding new people rest", () => {
  const t0 = new Date("2026-09-14T14:00:00Z");
  const day = 86_400_000;

  it("rest length follows how many new people the search found", () => {
    expect(restUntilAfterRun(0, 0, t0)?.getTime()).toBe(t0.getTime() + 14 * day);
    expect(restUntilAfterRun(30, 0, t0)?.getTime()).toBe(t0.getTime() + 7 * day);
    expect(restUntilAfterRun(30, 2, t0)?.getTime()).toBe(t0.getTime() + 3 * day);
    expect(restUntilAfterRun(30, 3, t0)).toBeNull(); // 10% new: due again tomorrow
  });

  it("records a run, rests the search, and wakes it after the rest", () => {
    const stats = recordTermRun({}, "tiktok", "#WeightLossPeptides", 30, 0, t0);
    expect(stats["tiktok:weightlosspeptides"]).toMatchObject({ runs: 1, lastHits: 30, lastFresh: 0, totalHits: 30 });
    expect(isResting(stats, "tiktok", "weightlosspeptides", new Date(t0.getTime() + 6 * day))).toBe(true);
    expect(isResting(stats, "tiktok", "#weightlosspeptides", new Date(t0.getTime() + 7 * day + 1))).toBe(false);
    expect(isResting(stats, "instagram", "#weightlosspeptides", t0)).toBe(false); // per platform
    const again = recordTermRun(stats, "tiktok", "#weightlosspeptides", 30, 12, new Date(t0.getTime() + 8 * day));
    expect(again["tiktok:weightlosspeptides"]).toMatchObject({ runs: 2, totalFresh: 12, restUntil: null });
  });

  it("countFresh ignores known people and people the filters would drop", () => {
    const known = emptyKnown();
    known.handles.add("tiktok:a");
    const hits = [hit("a"), hit("b"), hit("tiny", { followers: 10 }), hit("c")];
    expect(countFresh(profile, hits, known)).toBe(2); // b, c
  });
});

describe("daily limit across audiences", () => {
  it("an audience gets its own cap while the day has room, the remainder once it doesn't", () => {
    expect(effectiveSpendCap(2, 10, 3)).toEqual({ capUsd: 2, limitedByDaily: false });
    expect(effectiveSpendCap(2, 10, 8.5)).toEqual({ capUsd: 1.5, limitedByDaily: true });
    expect(effectiveSpendCap(2, 10, 12)).toEqual({ capUsd: 0, limitedByDaily: true });
  });

  it("a zero cap plans no searches at all", () => {
    const { run } = planSearches({ platforms: ["tiktok"], terms: { tiktok: ["#a"] }, dailyCap: 10, spendCapUsd: 0 }, [], 30);
    expect(run).toEqual([]);
  });

  it("setting parse: blank or junk means $10, 0 is a real stop", () => {
    expect(parseDailyLimit(undefined)).toBe(10);
    expect(parseDailyLimit("")).toBe(10);
    expect(parseDailyLimit("abc")).toBe(10);
    expect(parseDailyLimit("25")).toBe(25);
    expect(parseDailyLimit("0")).toBe(0);
  });

  it("the business day starts at Los Angeles midnight", () => {
    // 2026-09-14 06:00 UTC is still 2026-09-13 in LA (PDT, UTC-7).
    expect(startOfBusinessDay(new Date("2026-09-14T06:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-09-13T07:00:00.000Z");
    expect(startOfBusinessDay(new Date("2026-12-01T20:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(startOfBusinessDay(new Date("2026-09-14T06:00:00Z"), "UTC").toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("recognizes MySQL duplicate-key errors, wrapped or not", () => {
    expect(isDuplicateKey({ code: "ER_DUP_ENTRY" })).toBe(true);
    expect(isDuplicateKey({ message: "x", cause: { errno: 1062 } })).toBe(true);
    expect(isDuplicateKey(new Error("timeout"))).toBe(false);
  });
});

describe("ingest wiring", () => {
  it("sourcing_actors overrides land on discover:<platform> keys, profile readers keep theirs", () => {
    const deps = ingestDepsFromEnv({ APIFY_TOKEN: "t" } as NodeJS.ProcessEnv, { tiktok: "x/hashtag" });
    expect(deps.apify.actors["discover:tiktok"]).toBe("x/hashtag");
    expect(deps.apify.actors.tiktok).toBe("clockworks/tiktok-profile-scraper");
  });

  it("the schedule skips an audience that already ran today (LA time); a never-run audience is due", () => {
    const now = new Date("2026-09-14T20:00:00Z"); // 13:00 in LA
    expect(ranToday({ lastRunAt: "2026-09-14T13:43:00Z" }, now)).toBe(true); // 06:43 LA, same day
    expect(ranToday({ lastRunAt: "2026-09-14T06:00:00Z" }, now)).toBe(false); // 23:00 LA the day before
    expect(ranToday({ lastRunAt: null }, now)).toBe(false);
  });
});

describe("quality in planProfile (first live run lessons)", () => {
  const wl: ProfileRow = { ...profile, platforms: ["tiktok", "instagram"], matchTerms: ["weight loss", "peptide"], dailyCap: 10, spendCapUsd: "5.00", countries: [] };
  const english = "sharing my weight loss journey and the peptide routine that finally worked for me this year";

  it("non-English and off-niche search rows are dropped before any paid read", async () => {
    let reads = 0;
    const v: VerifyFn = async (h) => { reads++; return { followers: 20000, bio: null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/v", text: english }] }; };
    const hits = new Map([["t", [
      hit("es", { postText: "¿Sabías que los péptidos inyectados funcionan como mensajes directos para tus células? Tu cuerpo los produce" }),
      hit("art", { postText: "LMAO RANDOM VENT I GUESS HAHA this happened years ago", bio: null }),
      hit("good", { postText: english }),
    ]]]);
    const { candidates, summary } = await planProfile(wl, [], hits, emptyKnown(), v, now);
    expect(candidates.map((c) => c.hit.handle)).toEqual(["good"]);
    expect(reads).toBe(1);
    expect(summary.quality).toEqual({ non_english: 1, dead: 0, off_niche: 1, followers: 0, country: 0, no_read: 0, weak_reach: 0, no_mention: 0, no_competitor: 0, competitor_account: 0 });
  });

  it("a competitor search hit that never names a competitor is dropped before any paid read", async () => {
    let reads = 0;
    const v: VerifyFn = async (h) => { reads++; return { followers: 20000, bio: null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/v", text: english }] }; };
    const club = { id: 1, name: "Amino Club", domains: ["aminoclub.com", "amino club"], codePattern: null, codePrefix: null, commissionPct: null };
    const hits = new Map([["t", [
      hit("hairoil", { term: "Amino Club code", postText: "#healthyhair #growthickhair my peptide hair routine for weight loss" }),
      hit("jamie", { term: "Amino Club code", postText: "Amino club is the best! Use my code JAMIE222 for 20% off first timers, weight loss research" }),
    ]]]);
    const { candidates, summary } = await planProfile(wl, [club], hits, emptyKnown(), v, now);
    expect(candidates.map((c) => [c.hit.handle, c.lead.otherCreatorCompany, c.lead.affiliateCode])).toEqual([["jamie", "Amino Club", "JAMIE222"]]);
    expect(reads).toBe(1);
    expect(summary.quality.no_mention).toBe(1);
  });

  it("competitor affiliates who name the competitor get a 1K follower minimum, or none with a 10K-view post", async () => {
    const comps = [{ name: "Amino Club" }];
    const p = { followerMin: { tiktok: 5000 } };
    const h = (views: number | undefined, term = "Amino Club code", postedAt: string | null = "2026-09-10T00:00:00Z") => ({ platform: "tiktok" as const, term, views, postedAt });
    expect(followerMinFor(p, h(500), true, comps, true, now)).toBe(COMPETITOR_FOLLOWER_MIN);
    expect(followerMinFor(p, h(178_700), true, comps, true, now)).toBeUndefined();
    // The viral post must name the competitor itself and be recent (review, 2026-09-16).
    expect(followerMinFor(p, h(178_700), true, comps, false, now)).toBe(COMPETITOR_FOLLOWER_MIN);
    expect(followerMinFor(p, h(178_700, "Amino Club code", "2025-01-01T00:00:00Z"), true, comps, true, now)).toBe(COMPETITOR_FOLLOWER_MIN);
    expect(followerMinFor(p, h(178_700), false, comps)).toBe(5000); // doesn't name the competitor
    expect(followerMinFor(p, h(178_700, "#peptidetok"), true, comps)).toBe(5000); // audience search
    expect(followerMinFor({ followerMin: { tiktok: 500 } }, h(10), true, comps)).toBe(500); // never raises a lower minimum

    let reads = 0;
    const v: VerifyFn = async (x) => { reads++; return { followers: x.followers, bio: null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: x.profileUrl, items: [{ url: x.profileUrl + "/v", text: english }] }; };
    const club = { id: 1, name: "Amino Club", domains: ["amino club"], codePattern: null, codePrefix: null, commissionPct: null };
    const say = "Use code REVIVE at Amino Club for 35% off, weight loss research";
    const hits = new Map([["t", [
      hit("viral", { term: "Amino Club code", followers: 64, views: 178_700, postText: say, postedAt: "2026-09-10T00:00:00Z" }),
      hit("small", { term: "Amino Club code", followers: 2843, views: 2461, postText: say }),
      hit("tiny", { term: "Amino Club code", followers: 400, views: 900, postText: say }),
      hit("plain", { term: "#weightloss", followers: 2843, views: 2461, postText: english }),
    ]]]);
    const { candidates, summary } = await planProfile(wl, [club], hits, emptyKnown(), v, now);
    expect(candidates.map((c) => c.hit.handle).sort()).toEqual(["small", "viral"]);
    expect(summary.rejected.followers_low).toBe(2);
    expect(reads).toBe(2);
  });

  it("a dead account after the read is not saved, does not use a slot, and is remembered", async () => {
    const v: VerifyFn = async (h) => ({ followers: 50000, bio: null, lastPostAt: h.handle === "dead" ? "2026-01-20T00:00:00Z" : "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/v", text: english }] });
    const hits = new Map([["t", [hit("dead", { followers: 90000, postText: english }), hit("alive", { followers: 10000, postText: english })]]]);
    const { candidates, summary } = await planProfile({ ...wl, dailyCap: 1 }, [], hits, emptyKnown(), v, now);
    expect(candidates.map((c) => c.hit.handle)).toEqual(["alive"]);
    expect(summary.gated).toEqual([{ key: "tiktok:dead", reason: "dead" }]);
  });

  it("profile reads alternate platforms so Instagram (no follower count in search) gets reads", () => {
    const ig = (h: string) => hit(h, { platform: "instagram", followers: null, profileUrl: `https://www.instagram.com/${h}/` });
    const order = interleaveByPlatform([hit("t1", { followers: 5 }), hit("t2", { followers: 9 }), hit("t3", { followers: 7 }), ig("i1"), ig("i2")], ["tiktok", "instagram"]);
    expect(order.map((h) => h.handle)).toEqual(["t2", "i1", "t3", "i2", "t1"]);
  });

  it("a search whose people keep failing quality rests for 7 days", () => {
    const t0 = new Date("2026-09-14T14:00:00Z");
    const stats = recordTermRun({}, "tiktok", "Amino Innovations", 28, 7, t0);
    expect(stats["tiktok:aminoinnovations"]!.restUntil).toBeNull();
    const rested = applyTermOutcome(stats, { "tiktok Amino Innovations": { checked: 6, kept: 0 } }, t0);
    expect(rested["tiktok:aminoinnovations"]!.restUntil).toBe(new Date(t0.getTime() + 7 * 86_400_000).toISOString());
    expect(applyTermOutcome(stats, { "tiktok Amino Innovations": { checked: 6, kept: 1 } }, t0)["tiktok:aminoinnovations"]!.restUntil).toBeNull();
    expect(applyTermOutcome(stats, { "tiktok Amino Innovations": { checked: 3, kept: 0 } }, t0)["tiktok:aminoinnovations"]!.restUntil).toBeNull();
  });

  it("gated memory expires after 90 days", () => {
    const t0 = new Date("2026-09-14T14:00:00Z");
    const mem = { "tiktok:a": { reason: "dead" as const, at: "2026-09-01T00:00:00Z" }, "tiktok:b": { reason: "dead" as const, at: "2026-05-01T00:00:00Z" } };
    expect(activeGated(mem, t0)).toEqual(["tiktok:a"]);
  });
});

describe("many audiences sharing a run", () => {
  it("a search another audience already ran this run is skipped and not paid for", () => {
    const p = { platforms: ["tiktok"] as ProfileRow["platforms"], terms: { tiktok: ["#biohacking"] }, dailyCap: 10, spendCapUsd: "1.00" };
    const done = new Set(["tiktok:aminoclubcode"]);
    const { run, skipped, resting } = planSearches(p, [{ name: "Amino Club" }, { name: "Swiss Chems" }], 30, 0, () => false, done);
    expect(run.map((s) => s.term)).toEqual(["#biohacking", "Swiss Chems code", "Amino Club discount", "Swiss Chems discount"]);
    expect([...skipped, ...resting]).toEqual([]);
  });

  it("audiences run in niche priority order, then oldest first", () => {
    const rows = [
      { id: 5, niche: "Sexual wellness" },
      { id: 9, niche: "Biohacker" },
      { id: 2, niche: "Anti-aging" },
      { id: 1, niche: "Weight-loss seeker" },
      { id: 3, niche: "Biohacker" },
      { id: 4, niche: "Gym / PED-curious" },
    ];
    expect([...rows].sort(byNichePriority).map((r) => r.id)).toEqual([1, 3, 9, 4, 2, 5]);
  });
});

describe("review queue limit (fixed batch for marketing)", () => {
  it("setting parse: blank or junk = no limit, integers only", () => {
    expect(parseMaxPending(undefined)).toBeNull();
    expect(parseMaxPending("")).toBeNull();
    expect(parseMaxPending("abc")).toBeNull();
    expect(parseMaxPending("12.5")).toBeNull();
    expect(parseMaxPending("50")).toBe(50);
    expect(parseMaxPending("0")).toBe(0);
  });
  it("caps each audience at the room left in the queue", () => {
    expect(reviewRoom(null, 400, 15)).toEqual({ cap: 15, limited: false });
    expect(reviewRoom(50, 3, 10)).toEqual({ cap: 10, limited: false });
    expect(reviewRoom(50, 44, 10)).toEqual({ cap: 6, limited: true });
    expect(reviewRoom(50, 50, 10)).toEqual({ cap: 0, limited: true });
    expect(reviewRoom(50, 61, 10)).toEqual({ cap: 0, limited: true });
  });
});

describe("fixes from the 50-lead test run (2026-09-14)", () => {
  it("follower range is enforced after the profile read (Instagram rows have no count)", async () => {
    const ig: ProfileRow = { ...profile, platforms: ["instagram"], followerMin: { instagram: 5000 }, followerMax: { instagram: 500000 }, matchTerms: ["weight loss"], dailyCap: 10, countries: [] };
    const v: VerifyFn = async (h) => ({ followers: h.handle === "tiny" ? 32 : 22027, bio: null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/p", text: "my weight loss journey update this week" }] });
    const row = (handle: string) => hit(handle, { platform: "instagram", followers: null, profileUrl: `https://www.instagram.com/${handle}/`, postText: "weight loss journey" });
    const { candidates, summary } = await planProfile(ig, [], new Map([["t", [row("tiny"), row("ioana")]]]), emptyKnown(), v, now);
    expect(candidates.map((c) => c.hit.handle)).toEqual(["ioana"]);
    expect(summary.quality?.followers).toBe(1);
    expect(summary.gated).toEqual([{ key: "instagram:tiny", reason: "followers" }]);
  });

  it("competitor names get a share of the budget even when hashtags could use all of it", () => {
    const p = { platforms: ["tiktok", "instagram"] as ProfileRow["platforms"], terms: { tiktok: ["#a", "#b", "#c", "#d", "#e"], instagram: ["#a", "#b", "#c", "#d"] }, dailyCap: 10, spendCapUsd: "1.00" };
    const { run } = planSearches(p, [{ name: "Amino Club" }, { name: "Swiss Chems" }], 30);
    expect(run.some((s) => s.term === "Amino Club")).toBe(true);
    expect(planSearches(p, [], 30).run.filter((s) => s.term.startsWith("#")).length).toBe(9); // no competitors: hashtags keep the whole budget
  });
});

describe("US only (2026-09-14)", () => {
  const us: ProfileRow = { ...profile, platforms: ["tiktok", "youtube"], countries: ["US"], matchTerms: ["peptide"], followerMin: {}, followerMax: {}, dailyCap: 10 };
  const text = "my peptide routine and results this month, what actually worked";
  it("drops a bio that says London before paying for the read, and a UK YouTube channel after it", async () => {
    let reads = 0;
    const v: VerifyFn = async (h) => {
      reads++;
      return { followers: 146000, bio: null, country: h.handle === "dr_abs" ? "GB" : null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/v", text }] };
    };
    const hits = new Map([["t", [
      hit("londonpt", { bio: "London based PT | online coaching", country: null, postText: text }),
      hit("dr_abs", { platform: "youtube", bio: null, country: null, postText: text, profileUrl: "https://www.youtube.com/@dr_abs" }),
      hit("texasmom", { bio: "📍 Dallas | mom of 3", country: null, postText: text }),
      hit("unknown", { bio: "peptide journey", country: null, postText: text }),
    ]]]);
    const { candidates, summary } = await planProfile(us, [], hits, emptyKnown(), v, now);
    expect(candidates.map((c) => [c.hit.handle, c.lead.geoCountry])).toEqual([["texasmom", "US"], ["unknown", null]]);
    expect(summary.quality?.country).toBe(2);
    expect(reads).toBe(3); // londonpt never read
  });
});

describe("linking research-board leads to a competitor", () => {
  const comps = [
    { id: 1, name: "Amino Club", domains: ["aminoclub.com", "amino club"] },
    { id: 2, name: "Peptira", domains: ["peptira"] },
    { id: 3, name: "Flawless Compounds", domains: ["flawless compounds", "flawlesscompounds"] },
    { id: 4, name: "Modern Aminos", domains: ["modernaminos", "modern aminos"] },
  ];
  it("takes the competitor named first, handles squashed names and field-only aliases, and names nobody for vague entries", () => {
    expect(linkCompetitor("Amino Club; Peptira", comps)).toBe(1);
    expect(linkCompetitor("Peptira + Amino Club", comps)).toBe(2);
    expect(linkCompetitor("Multi-vendor: Flawless, Atomik Labz, Glacier Aminos", comps, { companyField: true })).toBe(3);
    // Review, 2026-09-16: no squashed-text or short-alias matches outside the company field.
    const ion = [...comps, { id: 5, name: "Ion Peptide", domains: ["ionpeptide", "ion peptide"] }];
    expect(linkCompetitor("clear product information peptides", ion)).toBeNull();
    expect(linkCompetitor("the ion channel explained", ion)).toBeNull();
    expect(linkCompetitor("Ion (research vendor)", ion, { companyField: true })).toBe(5);
    expect(linkCompetitor("flawless skin routine", comps)).toBeNull();
    expect(linkCompetitor("ModernAminos", comps)).toBe(4);
    expect(linkCompetitor("Unnamed source", comps)).toBeNull();
    expect(linkCompetitor("unknown (code LACEY10)", comps)).toBeNull();
    expect(linkCompetitor(null, comps)).toBeNull();
  });
});

describe("competitor affiliates only", () => {
  it("with requireCompetitor, a read that names no competitor isn't saved and is remembered", async () => {
    const english = "weight loss research tips and my honest supplier notes for this week";
    const v: VerifyFn = async (h) => ({ followers: 20000, bio: null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/v", text: h.handle === "aff" ? "use code AFF10 at Amino Club" : english }] });
    const club = { id: 1, name: "Amino Club", domains: ["amino club"], codePattern: null, codePrefix: null, commissionPct: null };
    const profile = { id: 1, name: "t", active: true, niche: "Weight-loss seeker", brandFit: null, platforms: ["tiktok"], terms: {}, seedAccounts: null, followerMin: { tiktok: 5000 }, followerMax: {}, activityDays: 30, countries: ["US"], language: "en", matchTerms: ["weight loss"], excludeTerms: [], excludeHandles: [], dailyCap: 10, spendCapUsd: "5.00", lastRunAt: null, lastRunSummary: null } as unknown as ProfileRow;
    const hit = (handle: string) => ({ platform: "tiktok" as const, handle, profileUrl: `https://www.tiktok.com/@${handle}`, displayName: handle, bio: null, followers: 20000, postUrl: `https://www.tiktok.com/@${handle}/video/1`, postText: english, postedAt: "2026-09-12T00:00:00Z", country: null, isRepost: null, term: "#weightloss" });
    const { candidates, summary } = await planProfile(profile, [club], new Map([["t", [hit("plain"), hit("aff")]]]), emptyKnown(), v, new Date("2026-09-16T00:00:00Z"), { requireCompetitor: true });
    expect(candidates.map((c) => c.hit.handle)).toEqual(["aff"]);
    expect(summary.quality.no_competitor).toBe(1);
    expect(summary.gated).toEqual([{ key: "tiktok:plain", reason: "no_competitor" }]);
  });

  it("auto-accept: competitor affiliates go straight to the queue as Experts; brand pages are dropped; stores wait for a person", async () => {
    const v: VerifyFn = async (h) => ({ followers: 20000, bio: h.handle === "shop" ? "Order now, free shipping on all kits" : null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/v", text: "use code AFF10 at Atomik Labz for weight loss research" }] });
    const atomik = { id: 2, name: "Atomik Labz", domains: ["atomik labz", "atomiklabz"], codePattern: null, codePrefix: null, commissionPct: null };
    const profile = { id: 1, name: "t", active: true, niche: "Weight-loss seeker", brandFit: null, platforms: ["tiktok"], terms: {}, seedAccounts: null, followerMin: { tiktok: 5000 }, followerMax: {}, activityDays: 30, countries: ["US"], language: "en", matchTerms: ["weight loss"], excludeTerms: [], excludeHandles: [], dailyCap: 10, spendCapUsd: "5.00", lastRunAt: null, lastRunSummary: null } as unknown as ProfileRow;
    const hit = (handle: string) => ({ platform: "tiktok" as const, handle, profileUrl: `https://www.tiktok.com/@${handle}`, displayName: handle, bio: null, followers: 20000, postUrl: `https://www.tiktok.com/@${handle}/video/1`, postText: "use code AFF10 at Atomik Labz", postedAt: "2026-09-12T00:00:00Z", country: null, isRepost: null, term: "Atomik Labz code" });
    const { candidates, summary } = await planProfile(profile, [atomik], new Map([["t", [hit("jill"), hit("atomiklabzofficial"), hit("shop")]]]), emptyKnown(), v, new Date("2026-09-16T00:00:00Z"), { requireCompetitor: true, autoAccept: true });
    expect(candidates.map((c) => [c.hit.handle, c.lead.sourcingReview, c.lead.subProfile ?? null])).toEqual([["jill", "accepted", "SP1"], ["shop", "pending", null]]);
    expect(summary.quality.competitor_account).toBe(1);
    expect(isCompetitorOwnAccount("atomiklabzofficial", atomik)).toBe(true);
    expect(isCompetitorOwnAccount("amylovespeppers", atomik)).toBe(false);
  });

  it("vendor suggestions accumulate with counts and example links, and dismissed ones stay dismissed", () => {
    const now = new Date("2026-09-16T00:00:00Z");
    const known = [{ name: "Amino Club", domains: ["aminoclub.com"] }];
    let s = recordSuggestions({}, [{ text: "use code JAMIE at Nova Peptides", url: "https://www.tiktok.com/@a/video/1" }, { text: "novapeptides.com/?ref=x", url: null }], known, now);
    s = recordSuggestions(s, [{ text: "code KAY at Nova Peptides!", url: "https://www.tiktok.com/@b/video/2" }], known, now);
    expect(s.novapeptides).toMatchObject({ name: "Nova Peptides", count: 3, examples: ["https://www.tiktok.com/@a/video/1", "https://www.tiktok.com/@b/video/2"] });
    s = recordSuggestions({ ...s, novapeptides: { ...s.novapeptides!, dismissed: true } }, [{ text: "code Z at Nova Peptides", url: null }], known, now);
    expect(s.novapeptides?.dismissed).toBe(true);
  });
});

describe("review fixes (2026-09-16)", () => {
  it("a brand page is its name plus nothing or a company word, not any handle containing it", () => {
    const ion = { name: "Ion Peptide", domains: ["ionpeptide", "ion peptide"] };
    expect(isCompetitorOwnAccount("ionpeptide", ion)).toBe(true);
    expect(isCompetitorOwnAccount("ionpeptideofficial", ion)).toBe(true);
    expect(isCompetitorOwnAccount("passionpeptides", ion)).toBe(false);
    expect(isCompetitorOwnAccount("visionpeptide_coach", ion)).toBe(false);
    expect(isCompetitorOwnAccount("champion_peptides", ion)).toBe(false);
  });

  it("countFresh uses the competitor follower minimum, so productive code searches don't rest", () => {
    const club = { id: 1, name: "Amino Club", domains: ["amino club"], codePattern: null, codePrefix: null, commissionPct: null };
    const profile = { followerMin: { tiktok: 5000 }, followerMax: {}, countries: ["US"], language: "en", excludeTerms: [], excludeHandles: [] } as unknown as ProfileRow;
    const mk = (handle: string) => ({ platform: "tiktok" as const, handle, profileUrl: `https://www.tiktok.com/@${handle}`, displayName: handle, bio: null, followers: 2500, postUrl: null, postText: "code KAY at Amino Club", postedAt: "2026-09-10T00:00:00Z", country: null, isRepost: null, term: "Amino Club code" });
    expect(countFresh(profile, [mk("a"), mk("b")], emptyKnown(), [club], new Date("2026-09-16T00:00:00Z"))).toBe(2);
    expect(countFresh(profile, [mk("a")], emptyKnown(), [], new Date("2026-09-16T00:00:00Z"))).toBe(0);
  });

  it("auto-accept needs a personal code; a bare mention waits for a person", async () => {
    const v: VerifyFn = async (h) => ({ followers: 20000, bio: null, lastPostAt: "2026-09-12T00:00:00Z", isRepostRatio: null, profileUrl: h.profileUrl, items: [{ url: h.profileUrl + "/v", text: h.handle === "coded" ? "use code AFF10 at Amino Club, weight loss" : "got my stuff from Amino Club, weight loss" }] });
    const club = { id: 1, name: "Amino Club", domains: ["amino club"], codePattern: null, codePrefix: null, commissionPct: null };
    const profile = { id: 1, name: "t", active: true, niche: "Weight-loss seeker", brandFit: null, platforms: ["tiktok"], terms: {}, seedAccounts: null, followerMin: { tiktok: 5000 }, followerMax: {}, activityDays: 30, countries: ["US"], language: "en", matchTerms: ["weight loss"], excludeTerms: [], excludeHandles: [], dailyCap: 10, spendCapUsd: "5.00", lastRunAt: null, lastRunSummary: null } as unknown as ProfileRow;
    const hit = (handle: string, text: string) => ({ platform: "tiktok" as const, handle, profileUrl: `https://www.tiktok.com/@${handle}`, displayName: handle, bio: null, followers: 20000, postUrl: `https://www.tiktok.com/@${handle}/video/1`, postText: text, postedAt: "2026-09-12T00:00:00Z", country: null, isRepost: null, term: "Amino Club code" });
    const { candidates } = await planProfile(profile, [club], new Map([["t", [hit("coded", "use code AFF10 at Amino Club"), hit("mention", "got my stuff from Amino Club")]]]), emptyKnown(), v, new Date("2026-09-16T00:00:00Z"), { requireCompetitor: true, autoAccept: true });
    expect(candidates.map((c) => [c.hit.handle, c.lead.sourcingReview])).toEqual([["coded", "accepted"], ["mention", "pending"]]);
  });

  it("search cost counts what the searches bill, not the people merged from them", async () => {
    const v: VerifyFn = async () => null;
    const profile = { id: 1, name: "t", active: true, niche: "Biohacker", brandFit: null, platforms: ["tiktok"], terms: {}, seedAccounts: null, followerMin: {}, followerMax: {}, activityDays: 30, countries: ["US"], language: "en", matchTerms: [], excludeTerms: [], excludeHandles: [], dailyCap: 0, spendCapUsd: "5.00", lastRunAt: null, lastRunSummary: null } as unknown as ProfileRow;
    const { summary } = await planProfile(profile, [], new Map(), emptyKnown(), v, new Date(), { searchCostUsd: 0.27 });
    expect(summary.estimatedCostUsd).toBe(0.27);
  });
});
