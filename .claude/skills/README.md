# Design skills

`taste-skill/`, `redesign-skill/` and `minimalist-skill/` are copied unchanged from
[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) at commit
`d237dd399d57524945c0c81327da5da19f7a468d` (MIT, see `third_party/taste-skill-LICENSE`).
They are guidance for UI work only; nothing here is shipped in the app.

## Tyrminal overrides (these win over the skills)

The skills are written for marketing sites. Tyrminal is an offline desktop tool, so when you use them:

- **No network assets.** The app CSP blocks remote images, fonts, scripts and CDNs. Never use
  `picsum.photos`, `cdn.simpleicons.org`, Google Fonts or any other URL. Use local assets, CSS and the
  existing icon set.
- **No new UI packages** (component kits, animation libraries, design systems) without an ADR entry,
  per AGENTS.md.
- **Product UI, not a landing page.** Skip hero sections, marketing copy, big imagery and scroll
  effects. Apply the parts that fit a dense tool: typography scale, spacing rhythm, restrained colour,
  clear hierarchy, purposeful motion, polished empty/loading/error states.
- **Keep the design tokens** in the existing stylesheets and extend them rather than hard-coding values.
  Light and dark themes must both work.
- **Accessibility holds.** WCAG AA contrast, visible focus, keyboard reachability and
  `prefers-reduced-motion`; the axe checks in the UI tests must stay green.
- **Visual baselines** that change must be re-recorded in the same change, and the reason stated.
