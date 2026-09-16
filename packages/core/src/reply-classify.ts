// Reads a creator's pasted reply and suggests which flow button it is (Yes / Tell me more / No /
// Replied but no info), plus any sign-up details in it. Keywords first: free, instant, and
// explainable. When the keywords are unsure, the caller may ask a model; a person confirms either way.

import type { ReplyKind } from "./outreach-flow.js";

export interface ReplySuggestion {
  kind: ReplyKind;
  confidence: "high" | "low";
  reason: string;
  details: { email: string | null; code: string | null; firstName: string | null; lastName: string | null };
}

const NO = [
  /\bno thanks?\b/, /\bno thank you\b/, /\bnot interested\b/, /\bnot for me\b/, /\bi'?m good\b/, /\bim good\b/, /\bpass\b/, /\bnah\b/,
  /\bnope\b/, /\bnot right now\b/, /\bnot at this time\b/, /\bhappy (with|where)\b/, /\bstop\b/, /\bunsubscribe\b/, /\bdon'?t (message|contact|dm)\b/,
  /\bleave me alone\b/, /\bno worries\b/, /\bnot (really|that|too|super|very|currently) interested\b/, /\bnot at the moment\b/, /\bmaybe later\b/, /\bspam\b/, /\bno\b[.!]*$/, /^no\b/, /\bi'?ll pass\b/, /\bdecline\b/, /\bexclusive\b/, /\bcan'?t (work|partner)\b/,
];
const MORE = [
  /\btell me more\b/, /\bmore (info|information|details)\b/, /\bdetails\b/, /\bhow (does|do|much|would|long|is|are)\b/, /\bwhat('?s| is| are| do)\b/,
  /\bexplain\b/, /\bcan you send\b/, /\bsend (me )?(info|details|more)\b/, /\bwhich products\b/, /\bcookie\b/, /\bpayout\b/, /\bhow often\b/,
  /\bcurious\b/, /\bquestion\b/, /\bwhere do i\b/, /\blink\b\?/, /\?\s*$/,
];
const YES = [
  /\byes\b/, /\byeah\b/, /\byep\b/, /\byup\b/, /\bsure\b/, /\bi'?m in\b/, /\bim in\b/, /\bcount me in\b/, /\bsign me up\b/, /\blet'?s (do it|go)\b/,
  /\bsounds good\b/, /\binterested\b/, /\bi'?m down\b/, /\babsolutely\b/, /\bdeal\b/, /\bof course\b/, /\blove to\b/, /\bwould love\b/, /\bok(ay)?\b/,
  /\bfor sure\b/, /\bdefinitely\b/, /\bhappy to\b/,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/;
// "JOHND10", "code: sarah15" — letters then digits, the shape the sign-up message asks for.
const CODE = /\b(?:code\s*[:\-]?\s*)?([A-Za-z]{3,14}\d{1,3})\b/;

export function extractSignupDetails(text: string): ReplySuggestion["details"] {
  const email = text.match(EMAIL)?.[0]?.toLowerCase() ?? null;
  const withoutEmail = email ? text.replace(EMAIL, " ") : text;
  const codeLine = withoutEmail.match(/\bcode\s*[:\-]?\s*([A-Za-z0-9]{3,20})\b/i)?.[1] ?? withoutEmail.match(CODE)?.[1] ?? null;
  const first = text.match(/\bfirst(?:\s*name)?\s*[:\-]\s*([A-Za-z'-]{2,30})/i)?.[1] ?? null;
  const last = text.match(/\blast(?:\s*name)?\s*[:\-]\s*([A-Za-z'-]{2,30})/i)?.[1] ?? null;
  let firstName = first;
  let lastName = last;
  if (!firstName && email) {
    // A bare "Jane Doe" line next to the email.
    const line = text.split(/\n/).map((l) => l.trim()).find((l) => /^[A-Z][a-z'-]+\s+[A-Z][a-z'-]+$/.test(l));
    if (line) [firstName, lastName] = line.split(/\s+/) as [string, string];
  }
  return { email, code: codeLine ? codeLine.toUpperCase() : null, firstName: firstName ?? null, lastName: lastName ?? null };
}

export function classifyReplyKeywords(raw: string): ReplySuggestion {
  const text = raw.trim();
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const details = extractSignupDetails(text);
  if (!t) return { kind: "no_info", confidence: "low", reason: "empty reply", details };
  if (details.email && (details.code || details.firstName)) return { kind: "yes", confidence: "high", reason: "they sent their sign-up details", details };
  const hits = (list: RegExp[]) => list.filter((re) => re.test(t)).length;
  // "not interested" contains "interested": score the no-phrases first and drop the plain yes-word they contain.
  const no = hits(NO);
  const more = hits(MORE);
  const yesRaw = hits(YES);
  // "not (really) interested" contains "interested", "ok no worries" contains "ok": those yes-words don't count.
  const yes = Math.max(0, yesRaw - (/\bnot (really |that |too |super |very |currently )?interested\b/.test(t) ? 1 : 0) - (/\bok(ay)?\b[^.!?]{0,15}\bno\b/.test(t) ? 1 : 0));
  if (details.email) return { kind: "yes", confidence: "low", reason: "they sent an email address", details };
  if (no > 0 && yes === 0 && more === 0) return { kind: "no", confidence: "high", reason: "they said no", details };
  if (more > 0 && no === 0) return { kind: "tell_me_more", confidence: yes > 0 ? "low" : "high", reason: yes > 0 ? "interested, with questions" : "they asked for more", details };
  if (yes > 0 && no === 0) return { kind: "yes", confidence: "high", reason: "they said yes", details };
  if (no > 0 && (yes > 0 || more > 0)) return { kind: "no", confidence: "low", reason: "mixed: sounds like a no", details };
  return { kind: "no_info", confidence: "low", reason: "no clear yes, no or question", details };
}
