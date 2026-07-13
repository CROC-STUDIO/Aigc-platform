# Arabic Disclaimer Overlay Design

## Goal

Add Arabic as a built-in wangzhuan disclaimer overlay language while preserving the existing rule that disclaimer copy is applied only during video post-processing and is never inserted into Seedance prompts or generation payloads.

## Approved Copy

The Arabic template uses Modern Standard Arabic and translates the existing English disclaimer:

> تخضع المكافآت لقواعد التطبيق، والأهلية، وإكمال المهام، والتوافر حسب المنطقة. النتائج غير مضمونة.

English source:

> Rewards are subject to in-app rules, eligibility, task completion, and regional availability. Results are not guaranteed.

The Arabic text is fixed template copy. It must not be paraphrased during rendering.

## Behavior

- Add `ar` to the shared disclaimer preset contract.
- Automatically resolve language tags beginning with `ar`, including `ar-SA` and `ar-AE`, to the `ar` preset.
- Keep explicit preset selection behavior unchanged.
- Add an Arabic option to both wangzhuan disclaimer template selectors.
- Keep English as the fallback for unsupported languages.
- Preserve custom uploaded PNG behavior and the existing `other` option.

## Raster Asset

- Add `public/assets/wangzhuan/disclaimers/ar.png`.
- Match the existing built-in template dimensions: `720 x 88` pixels.
- Use RGBA PNG with a transparent background.
- Render the approved copy right-to-left using a font with native Arabic shaping support.
- Match the existing visual treatment: centered white text, compact two-line layout, no panel background, border, shadow, logo, or decorative element.
- Keep enough transparent padding that the text remains legible after the existing overlay scaling and bottom-center placement.
- Use deterministic local text rendering instead of a generative image model so the Arabic copy and glyph shaping remain exact.

## Integration

The implementation updates these existing boundaries without introducing a new overlay mechanism:

- `server/wangzhuan/disclaimers.mjs`: Arabic copy and `ar-*` auto-selection.
- `server/wangzhuan/stitch.mjs`: built-in `ar.png` template mapping.
- `public/wangzhuan-v2.js`: preview URL and automatic language mapping.
- `public/wangzhuan-v2.html`: Arabic preset option.
- `public/wangzhuan.js`: legacy-page copy and automatic language mapping.
- `public/wangzhuan.html`: legacy-page Arabic preset option.

The final data path remains:

`language/preset -> disclaimer metadata -> built-in transparent PNG -> ffmpeg post-process overlay`

## Error Handling

- If the selected Arabic built-in PNG is missing, retain the existing `missing_required_file` failure instead of silently falling back to another language.
- Invalid or unsupported language tags continue to resolve to English.
- Custom uploaded PNG selection continues to take precedence over built-in templates.

## Verification

- Add a failing test first for `ar`, `ar-SA`, and `ar-AE` preset resolution and Arabic copy.
- Add static coverage for the Arabic option and preview/template mappings in both current and legacy pages.
- Assert `ar.png` is a valid `720 x 88` RGBA PNG with transparent pixels.
- Run the existing disclaimer overlay render test with the Arabic built-in template and verify the produced video is decodable.
- Run focused wangzhuan disclaimer/stitch tests, then the full `npm test` suite.
- Visually inspect the final PNG to confirm correct RTL shaping, two-line fit, transparency, and no clipping.

## Scope

This change does not modify Seedance prompt rules, channel disclaimer requirements, database schemas, upload contracts, overlay positioning defaults, or video encoding settings.
