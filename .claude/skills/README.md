# Design skills

`taste-skill/`, `redesign-skill/` and `minimalist-skill/` are copied unchanged from
[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) at commit
`d237dd399d57524945c0c81327da5da19f7a468d` (MIT, see `third_party/taste-skill-LICENSE`).
They are guidance for UI work only; nothing here is shipped in the app.

## Other design and motion skills

| Skill folders | Source | Commit | License |
|---|---|---|---|
| `frontend-design/` | [anthropics/skills](https://github.com/anthropics/skills) | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | Apache-2.0 (`frontend-design/LICENSE.txt`) |
| `animate/`, `emil-design-eng/`, `improve-animations/`, `review-animations/`, `animation-performance/`, `find-animation-opportunities/`, `apple-design/` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `2d228630ba1446365f614a108cb8252f1feda202` | MIT (`third_party/emilkowalski-skills-LICENSE`) |
| `ui-ux-pro-max/` (its test fixtures removed) | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `7246805992a42b7bba37d4cac83b01416f0c6c44` | MIT (`third_party/ui-ux-pro-max-LICENSE`) |

All are copied unchanged. `ui-ux-pro-max` has an offline search script over its own CSV data
(`python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain style`); it makes no
network requests.

How they fit together for the visual overhaul:
- `frontend-design` and `taste-skill`: the aesthetic direction, and the list of tells that make
  a UI read as generated (avoid them).
- `ui-ux-pro-max`: a checklist for accessibility, interaction, dark mode and desktop-app rules.
- `emil-design-eng`, `animate`, `review-animations`, `improve-animations`,
  `animation-performance`, `apple-design`: motion that answers the user's action, is fast,
  interruptible and composite-only, and respects reduced motion.

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
- **Fonts** are bundled locally (OFL or similar, recorded in an ADR) or system fonts; never a
  font service.
- **Motion** stays short (UI feedback 120–220 ms), never blocks input, animates transform and
  opacity only, and is off under `prefers-reduced-motion`. The terminal itself never animates.
- **Themes**: every theme works in light and dark, meets the contrast check
  (`scripts/check-contrast.mjs`), and terminal colour schemes stay separate from the app theme.
