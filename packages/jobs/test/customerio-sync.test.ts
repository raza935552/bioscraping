import { describe, expect, it } from "vitest";
import { leadAttributes } from "../src/customerio-sync.js";

describe("leadAttributes", () => {
  it("maps the documented attribute list and nothing else", () => {
    const a = leadAttributes(
      {
        id: 7,
        firstName: "Ann",
        lastName: "A",
        source: "sourcing",
        emailProvenance: "published-business",
        niche: "Biohacker",
        brandFit: "biolinx",
        primaryPlatform: "TikTok",
        affiliationStatus: "Unsigned",
        status: "Not contacted",
        sourcingReview: "accepted",
        totalReach: 42000,
        geoCountry: "US",
        phone: "555",
      } as never,
      false,
    );
    expect(a).toEqual({
      first_name: "Ann",
      last_name: "A",
      lead_id: 7,
      source: "sourcing",
      email_provenance: "published-business",
      niche: "Biohacker",
      brand_fit: "biolinx",
      primary_platform: "TikTok",
      affiliation_status: "Unsigned",
      lead_status: "Not contacted",
      sourcing_review: "accepted",
      total_reach: 42000,
      geo_country: "US",
      unsubscribed: false,
    });
    expect(Object.keys(a)).not.toContain("phone");
  });
  it("suppressed sends only unsubscribed", () => {
    expect(leadAttributes({ id: 1 } as never, true)).toEqual({ unsubscribed: true });
  });
});
