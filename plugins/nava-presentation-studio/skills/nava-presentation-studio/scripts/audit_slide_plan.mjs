#!/usr/bin/env node

import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node audit_slide_plan.mjs <plan.json>');
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (error) {
  console.error(`ERROR plan could not be read as JSON: ${error.message}`);
  process.exit(2);
}

const errors = [];
const warnings = [];
const requiredDeck = ['audience', 'purpose', 'decision', 'starting_belief', 'leaving_belief', 'thesis', 'ending_aha', 'source_boundary'];
for (const key of requiredDeck) {
  if (!String(plan?.deck?.[key] ?? '').trim()) errors.push(`deck.${key} is required`);
}

const slides = Array.isArray(plan?.slides) ? plan.slides : [];
if (!slides.length) errors.push('slides must contain at least one slide');

const requiredSlide = ['role', 'title', 'claim', 'visual_concept', 'composition', 'transition'];
const genericTitles = /^(overview|key takeaways|recommendations|what'?s next|progress|roadmap|our work)$/i;
const cardPattern = /(card|grid|dashboard|three[- ]column|3[- ]column)/i;
const evidenceNumber = /(?:\$\s*\d|\b\d+(?:\.\d+)?\s*%|\b\d+\s*(?:tests?|fields?|seconds?|minutes?|applications?|writes?|tokens?))/i;
const comparisonLanguage = /(?:\bvs\.?\b|\bversus\b|\bfrom\b.+\bto\b|→|\breduction\b|\bcut\b|\bfell\b|\bdropped\b|\blower\b|\bfaster\b)/i;
const slopPunctuation = /[—;]|(?:\s[•→]\s)/;
const placeholderText = /(?:\bTBD\b|\bplaceholder\b|\blorem ipsum\b|\bempty bullet\b)/i;

let cardLike = 0;
let evidenceSlides = 0;
for (let index = 0; index < slides.length; index += 1) {
  const slide = slides[index] ?? {};
  const label = `slide ${index + 1}`;
  if (Number(slide.number) !== index + 1) warnings.push(`${label}: number should be ${index + 1}`);
  for (const key of requiredSlide) {
    if (!String(slide[key] ?? '').trim()) errors.push(`${label}: ${key} is required`);
  }

  const title = String(slide.title ?? '').trim();
  if (title.split(/\s+/).filter(Boolean).length > 15) warnings.push(`${label}: title exceeds 15 words`);
  if (genericTitles.test(title)) warnings.push(`${label}: title is generic and may not name the actual subject`);

  const visible = [title, slide.claim, slide.evidence].filter(Boolean).join(' ');
  const words = Number.isFinite(Number(slide.body_word_count))
    ? Number(slide.body_word_count)
    : [slide.claim, slide.evidence].filter(Boolean).join(' ').trim().split(/\s+/).filter(Boolean).length;
  if (words > 65) warnings.push(`${label}: estimated visible body copy is ${words} words`);
  if (slopPunctuation.test(visible)) warnings.push(`${label}: visible copy uses an em dash, semicolon, dot bullet, or arrow`);

  if (cardPattern.test(String(slide.composition ?? ''))) cardLike += 1;
  if (String(slide.evidence ?? '').trim()) evidenceSlides += 1;

  const refs = Array.isArray(slide.source_refs) ? slide.source_refs.filter(Boolean) : [];
  if (evidenceNumber.test(visible) && refs.length === 0) errors.push(`${label}: quantified evidence needs source_refs`);
  if (evidenceNumber.test(visible) && !String(slide.evidence_scope ?? '').trim()) {
    errors.push(`${label}: quantified evidence needs evidence_scope`);
  }
  if (comparisonLanguage.test(visible) && !String(slide.comparison_basis ?? '').trim()) {
    errors.push(`${label}: comparison needs comparison_basis`);
  }
  const layout = slide.layout_intent;
  if (!layout || typeof layout !== 'object') {
    warnings.push(`${label}: layout_intent is missing`);
  } else {
    if (!String(layout.dominant_region ?? '').trim()) warnings.push(`${label}: layout_intent.dominant_region is missing`);
    if (!String(layout.supporting_region ?? '').trim()) warnings.push(`${label}: layout_intent.supporting_region is missing`);
    if (!String(layout.blank_space_role ?? '').trim()) warnings.push(`${label}: layout_intent.blank_space_role is missing`);
  }
  const visibleItems = Array.isArray(slide.visible_copy) ? slide.visible_copy : [];
  if (visibleItems.some((item) => !String(item ?? '').trim())) errors.push(`${label}: visible_copy contains an empty item`);
  if (placeholderText.test([visible, ...visibleItems].join(' '))) errors.push(`${label}: placeholder or empty-bullet text remains`);

  if (index >= 2) {
    const c0 = String(slides[index - 2]?.composition ?? '').trim().toLowerCase();
    const c1 = String(slides[index - 1]?.composition ?? '').trim().toLowerCase();
    const c2 = String(slide.composition ?? '').trim().toLowerCase();
    if (c0 && c0 === c1 && c1 === c2) warnings.push(`${label}: same composition appears three slides in a row`);
  }
}

if (slides.length && cardLike / slides.length > 0.25) {
  warnings.push(`${cardLike} of ${slides.length} slides use card, grid, dashboard, or three-column compositions`);
}
if (slides.length > 2 && evidenceSlides < Math.ceil(slides.length / 3)) {
  warnings.push('fewer than one third of slides specify evidence');
}

const finalRoles = slides.slice(-3).map((slide) => String(slide?.role ?? '').toLowerCase());
if (slides.length >= 5 && !finalRoles.some((role) => /setup|reveal/.test(role))) {
  warnings.push('the final three slides do not include an explicit setup or reveal role for the ending insight');
}
if (slides.length >= 5 && !finalRoles.some((role) => /decision|implication|close/.test(role))) {
  warnings.push('the final three slides do not connect the ending insight to implications or a decision');
}

for (const message of errors) console.error(`ERROR ${message}`);
for (const message of warnings) console.warn(`WARN  ${message}`);
console.log(`SUMMARY ${slides.length} slides, ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
