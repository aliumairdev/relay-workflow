---
name: tailwind-ui
description: Use when styling or reviewing Rails UI with Tailwind CSS v4: layout, spacing, colour, responsive behaviour, dark mode and accessible states.
---

# Tailwind and UI conventions

Read the view guide, the current page and the Tailwind entry stylesheet; read the theme and nearby component CSS before adding styles. Pair with [hotwire-frontend](../hotwire-frontend/SKILL.md) for interactions. New observable UI behaviour needs a failing test first; for visual-only changes use rendered checks and inspect the states. Do not test exact utility strings.

- Reuse existing components, partials and tokens. A new screen needs no new palette, font or component framework; do not copy external examples that need React or a CDN.
- Tailwind v4 is CSS-first: keep `@import "tailwindcss"`, plugins, `@theme` tokens and the dark variant; do not add a v3 `tailwind.config.js` by habit.
- Use complete class names the compiler can find (`bg-green-100`, never `bg-#{color}-100`). Add a narrow `@source` only for real sources outside auto-detection.
- Use v4 syntax: slash opacity (`bg-black/50`), `bg-(--brand)`, explicit border colours; review old shadow, radius, outline and ring examples.
- Start narrow, then add breakpoints. Test long names, big numbers and errors. Wide tables scroll in a labelled area rather than hiding columns.
- Keep light and dark readable; never use colour alone for state; keep visible keyboard focus and respect reduced motion.

Inspect narrow and wide sizes, both themes, keyboard use and zoom. Build production assets when source detection changes and look for missing classes. A screenshot alone is not an accessibility audit.
