import { describe, expect, it } from "vitest";
import { acquisitionChannel, quoteAround, sourcedDetails } from "../src/sourced-details.js";

const now = new Date("2026-09-16T00:00:00Z");

describe("lead dialog: how we found them, contact, competitor evidence", () => {
  it("names the acquisition channel in words", () => {
    expect(acquisitionChannel("found by Biohacker · TikTok via Amino Club code", "TikTok", "Amino Club")).toEqual({ kind: "competitor", label: 'TikTok search for "Amino Club code" (competitor affiliates)' });
    expect(acquisitionChannel("found by Biohacker · TikTok via #peptidetok", "TikTok", null)).toEqual({ kind: "hashtag", label: "TikTok hashtag #peptidetok" });
    expect(acquisitionChannel("found by Weight-loss seeker · YouTube via peptides for weight loss", "YouTube", null)?.kind).toBe("keyword");
    expect(acquisitionChannel(null, "TikTok", null)).toBeNull();
  });

  it("quotes the words around the competitor or code, with the post they're in, and says where the email was written", () => {
    const d = sourcedDetails(
      {
        socialProfiles: "TikTok @pepsquad3",
        primaryPlatform: "TikTok",
        email: "chris@gmail.com",
        otherCreatorCompany: "Amino Club",
        affiliateCode: "CHRISS",
        niche: "Biohacker",
        totalReach: 17600,
        whereFound: "https://www.tiktok.com/@pepsquad3/video/1",
        sourcingReason: "found by Biohacker · TikTok via Amino Club code",
        sourcingSample: [
          { url: "https://www.tiktok.com/@pepsquad3/video/1", text: "2x the points this weekend ONLY! Aminoclub.com use code CHRISS to get 20% off all your orders" },
          { url: "https://www.tiktok.com/@pepsquad3/video/2", text: "collabs: chris [at] gmail [dot] com" },
        ],
        lastPostAt: "2026-09-10T00:00:00Z",
      },
      { bio: "peptide research", followers: 17600, items: [] },
      now,
    );
    expect(d.evidence).toEqual({ quote: expect.stringContaining("use code CHRISS to get 20% off"), url: "https://www.tiktok.com/@pepsquad3/video/1" });
    expect(d.emailSource).toEqual({ where: "post", url: "https://www.tiktok.com/@pepsquad3/video/2" });
    expect(d.channel?.kind).toBe("competitor");
    expect(quoteAround("nothing", "Amino Club")).toBeNull();
  });
});
