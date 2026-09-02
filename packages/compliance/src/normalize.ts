// Input normalization for the compliance linter. Red-team proved the raw
// regexes were defeated by homoglyphs (Cyrillic е), leetspeak (s3maglutide),
// spacing (s e m a), zero-width chars, and 'dot com' obfuscation. Every
// banned-term match now runs against a folded skeleton produced here.

// Confusable → ASCII (the ones that actually appear in evasion: Cyrillic,
// Greek, fullwidth latin). NFKC handles fullwidth + many compatibility forms.
const CONFUSABLES: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", к: "k", м: "m", н: "h", т: "t", в: "b",
  α: "a", ε: "e", ο: "o", ρ: "p", ϲ: "c", υ: "u", χ: "x", ι: "i", κ: "k", μ: "m", ν: "v", τ: "t", β: "b",
};

const LEET: Record<string, string> = { "3": "e", "0": "o", "1": "i", "4": "a", "5": "s", "$": "s", "@": "a", "7": "t", "8": "b" };

/** Strip zero-width + combining marks, NFKC-fold, map confusables to ASCII. */
export function foldConfusables(input: string): string {
  const nfkc = input.normalize("NFKC").replace(/[​-‍﻿̀-ͯ]/g, "");
  let out = "";
  for (const ch of nfkc) out += CONFUSABLES[ch] ?? CONFUSABLES[ch.toLowerCase()] ?? ch;
  return out;
}

/** A skeleton for matching contiguous terms across spacing/punctuation/leet:
 *  fold → lowercase → leet-substitute letters-only. "s3m a.g" → "semag". */
export function skeleton(input: string): string {
  const folded = foldConfusables(input).toLowerCase();
  let out = "";
  for (const ch of folded) {
    if (/[a-z]/.test(ch)) out += ch;
    else if (LEET[ch]) out += LEET[ch];
    // drop everything else (spaces, dots, hyphens, digits w/o leet meaning)
  }
  return out;
}

/** Alphanumeric skeleton (keeps digits) for SKU codes like G2-T / G2 T / G2T,
 *  where the digit is meaningful. Confusables folded, everything else dropped. */
export function alnumSkeleton(input: string): string {
  const folded = foldConfusables(input).toLowerCase();
  let out = "";
  for (const ch of folded) if (/[a-z0-9]/.test(ch)) out += ch;
  return out;
}

/** De-obfuscate 'dot'/'(dot)'/'[.]' → '.' so bare domains surface. */
export function deobfuscateDomains(input: string): string {
  return foldConfusables(input)
    .replace(/\s*[\[(]?\s*dot\s*[\])]?\s*/gi, ".")
    .replace(/\s*\[\.\]\s*/g, ".")
    .replace(/\s*\(\.\)\s*/g, ".");
}
