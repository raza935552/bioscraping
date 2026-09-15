import { describe, expect, it } from "vitest";
import { countryFromCaptions, countryFromPosts, countryFromText, resolveCountry } from "../src/country.js";

describe("countryFromText (bios from the live runs)", () => {
  it.each([
    ["📍HTX 🇳🇬 FITNESS | LIFESTYLE", "US"], // Houston creator with a heritage flag
    ["Austin📍🇺🇲 GOAT of No Gi BJJ", "US"],
    ["Woodlands Mom Food & recipes", null],
    ["33 | belfast 📍☘️ mum of four", null],
    ["London based PT | online coaching", "GB"],
    ["🇸🇪 🏡 🏋🏻‍♀️", "SE"],
    ["Health Coach Mission-Obesity-Free India 🇮🇳", "IN"],
    ["Coach in Miami, FL | DM for plans", "US"],
    ["Toronto 🇨🇦 nurse & mom", "CA"],
    ["NYC | originally from London", null],
    ["Journey to Lose 250 lbs and learning to live", null],
    ["", null],
  ])("%s → %s", (bio, expected) => {
    expect(countryFromText(bio)).toBe(expected);
  });
});

describe("resolveCountry", () => {
  it("platform field beats posts beats bio", () => {
    expect(resolveCountry({ platform: "United Kingdom", posts: ["US", "US"], bio: "Austin, TX" })).toEqual({ country: "GB", source: "platform" });
    expect(resolveCountry({ platform: null, posts: ["US", "US", "GB"], bio: "London" })).toEqual({ country: "US", source: "posts" });
    expect(resolveCountry({ platform: null, posts: [], bio: "📍 Dallas" })).toEqual({ country: "US", source: "bio" });
    expect(resolveCountry({})).toEqual({ country: null, source: null });
  });
  it("posts need a clear majority", () => {
    expect(countryFromPosts(["US", "GB"])).toBeNull();
    expect(countryFromPosts(["US", "US", "US", "GB"])).toBe("US");
    expect(countryFromPosts([null, "", undefined])).toBeNull();
  });
});

describe("countryFromCaptions", () => {
  it("needs two captions naming the same place and none naming another", () => {
    expect(countryFromCaptions(["Just landed in Sweden for a conference!", "morning routine"])).toBeNull(); // one mention (the US pharmacist case)
    expect(countryFromCaptions(["back home in Texas", "Houston heat is unreal today"])).toBe("US");
    expect(countryFromCaptions(["back home in Texas", "Houston heat", "loving London this week"])).toBeNull();
  });
  it("captions are the last resort after platform, posts and bio", () => {
    expect(resolveCountry({ captions: ["Dallas gym day", "Austin, TX meetup"] })).toEqual({ country: "US", source: "captions" });
    expect(resolveCountry({ bio: "London based", captions: ["Dallas gym day", "Austin, TX meetup"] })).toEqual({ country: "GB", source: "bio" });
  });
});
