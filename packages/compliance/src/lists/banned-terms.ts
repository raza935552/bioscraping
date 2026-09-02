// Deterministic banned-term lists. Sources: affiliate-terms §2–3 (live site),
// docs/compliance-content-audit.md in the store repo (AuxPay audit, 2026-03-30),
// TEMPLATES.md "WHAT NEVER GOES IN A MESSAGE", PROMPTS.md Rule 5.
//
// Two match surfaces (see linter.ts): the ORIGINAL text (for word-boundary
// English phrases) AND a letters-only SKELETON (defeats homoglyph/leet/spacing
// evasion, proven necessary by the 2026-09-01 red-team). Skeleton patterns
// have no spaces/punctuation/word-boundaries because those are stripped.

/** Drug names matched on the SKELETON — prefixes catch tirzep/semag/etc.
 *  useInstead is the coded catalog replacement. */
export const BANNED_DRUG_SKELETONS: ReadonlyArray<{ pattern: RegExp; useInstead: string }> = [
  { pattern: /semaglutid|sema(?![a-z]*(ntic|phore))/, useInstead: "G1-S" },
  { pattern: /tirzepatid|tirz/, useInstead: "G2-T" },
  { pattern: /retatrutid|retatru|\breta(?![a-z]*(il|in|rd))/, useInstead: "G3-R" },
  { pattern: /ozempic/, useInstead: "(never reference brand drugs)" },
  { pattern: /wegovy/, useInstead: "(never reference brand drugs)" },
  { pattern: /mounjaro/, useInstead: "(never reference brand drugs)" },
  { pattern: /zepbound/, useInstead: "(never reference brand drugs)" },
];

/** Restricted GLP-1/GIP SKUs, matched on the ALPHANUMERIC skeleton
 *  (G2T == G2-T == 'G2 T' — the digit is meaningful, so digits are kept). */
export const RESTRICTED_SKU_SKELETONS: ReadonlyArray<RegExp> = [
  /g1s/, /g2t/, /g3r/, /gipglp1?/, /glp1/, /cagrilintide|camylin/,
];

/** Claim/medical phrases — matched on the ORIGINAL text (word order matters,
 *  proximity patterns allow words between). */
export const BANNED_PHRASES: ReadonlyArray<RegExp> = [
  /\bweight[\s-]?loss\b/i,
  /\b(los\w+|shed\w*|drop\w*|burn\w*|melt\w*|torch\w*)\b[^.?!]{0,30}\b(weight|pounds?|lbs?|fat|inches)\b/i,
  /\b(weight|pounds?|lbs?|fat|inches)\b[^.?!]{0,20}\b(los\w+|off|down|gone)\b/i,
  /\bfat[\s-]?(loss|burn(ing)?)\b/i,
  /\bslim\s?down\b|\btrim\s?down\b|\bleaner?\b/i,
  /\b(build|gain|grow|pack on|add)\b[^.?!]{0,20}\bmuscles?\b/i,
  /\bmuscle[\s-]?(gain|growth|building)\b/i,
  /\blean muscle\b/i,
  /\bbody composition\b/i,
  /\banti[\s-]?aging\b/i,
  /\b(look|feel|appear)\w*\b[^.?!]{0,15}\byounger\b/i,
  /\brevers\w+\b[^.?!]{0,15}\bag(e|ing)\b/i,
  /\bhealth benefits?\b/i,
  /\btherap(y|eutic)\b/i,
  /\btreat(s|ment|ing)?\b/i,
  /\bcures?\b/i,
  /\bdos(age|ing|e)\b/i,
  /\bprotocols?\b/i,
  /\bcycles?\b/i,
  /\bpatients?\b/i,
  /\bclinical(ly)? (use|proven)\b/i,
  /\bscientifically proven\b/i,
  /\bfda[\s-]?approved\b/i,
  /\bprescription\b/i,
];

/** Personal-use implications — broadened past the original 4 verbs. */
export const PERSONAL_USE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bi('?m| have| ?ve| ?am| had)?\s*(been\s+)?(tak\w+|us\w+|inject\w+|microdos\w+|cycl\w+|on it|running it|dos\w+)\b/i,
  /\bworks? for me\b/i,
  /\bmy (results?|dose|stack|cycle)\b/i,
  /\bswear(s)? by (it|them)\b/i,
  /\bit changed my life\b/i,
  /\b(love|loving|loved)\b[^.?!]{0,15}\b(results?|the stuff|it)\b/i,
];

export const RUO_LINE =
  "All Biolinx products are sold for laboratory and research use only. Not for human consumption.";

/** Earnings figures (L7): any dollar/percent tied to earning language. */
export const EARNINGS_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /\$\s?\d+(\.\d+)?\s*(per\s*(click|sale|order)|epc)/i,
  /\bepc\b/i,
  /\bearnings? per click\b/i,
  /\$\s?\d+(\.\d+)?\b[^.?!]{0,20}\b(earn|paid|commission|per)\b/i,
  /\b(earn|make|keep|get|paid)\b[^.?!]{0,15}(\d+\s?%|\$\s?\d+|a (quarter|third|half))/i,
  /\$342\.20\b/,
];

/** Any commission figure in an opener (percent, dollar, or fraction phrasing). */
export const OPENER_COMMISSION = /\b\d+\s?%|\$\s?\d+|\b(a quarter|a third|a half)\b[^.?!]{0,15}\b(sale|order|commission)|\bcommission\b/i;

/** Bare-domain detector (scheme-less), run on de-obfuscated text. */
export const BARE_DOMAIN = /\b[\w-]+\.(com|net|io|co|link|xyz|shop|store|info|biz|app|dev|me|us)\b/i;
