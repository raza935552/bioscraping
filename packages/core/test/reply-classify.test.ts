import { describe, expect, it } from "vitest";
import { classifyReplyKeywords, extractSignupDetails } from "../src/reply-classify.js";

describe("reply suggestions", () => {
  const kind = (t: string) => classifyReplyKeywords(t).kind;
  it("picks the flow button from what they wrote", () => {
    expect(kind("yes! I'm in 🔥")).toBe("yes");
    expect(kind("sounds good, let's do it")).toBe("yes");
    expect(kind("how does the payout work?")).toBe("tell_me_more");
    expect(kind("interested, what's the cookie length?")).toBe("tell_me_more");
    expect(kind("no thanks, I'm happy with Amino Club")).toBe("no");
    expect(kind("not interested")).toBe("no");
    expect(kind("lol")).toBe("no_info");
    expect(classifyReplyKeywords("lol").confidence).toBe("low");
  });
  it("reads sign-up details and treats them as a yes", () => {
    const r = classifyReplyKeywords("Jane Doe\njane.doe@gmail.com\ncode: JANED10");
    expect(r).toMatchObject({ kind: "yes", confidence: "high", details: { email: "jane.doe@gmail.com", code: "JANED10", firstName: "Jane", lastName: "Doe" } });
    expect(extractSignupDetails("first name: Sam, last name: Lee, sam@x.co, SAML10")).toEqual({ email: "sam@x.co", code: "SAML10", firstName: "Sam", lastName: "Lee" });
  });
});
