# ClipsFlow — approved Canva Studio system

## Brand constraints

- Treat the supplied Canva Studio screenshot as the visual source of truth. Keep the selected dark creator-workbench direction: compact top bar; fixed left workflow/source rail; broad center selection and transcript/timeline work area; right 9:16 preview/production inspector.
- Use the uploaded ClipsFlow Canva mark exactly in the top-left brand position. Never replace it with initials, emoji, text alone, a generic play icon, or an invented mark.
- Preserve the screenshot's existing people/podcast imagery through the supplied reference screenshot and existing repository crops only. Do not create, alter, or substitute photos or other imagery.
- Refine hierarchy, spacing, responsiveness, text legibility and interaction affordances without departing from the approved direction.
- Source-length copy in the next approved direction must support 1 minute through at least 4 hours (and longer sources when supported), rather than implying a hard 2-hour ceiling.

## Site-wide application direction

- Use the selected ClipsFlow Studio design as the product-wide visual foundation: the landing page, pricing, authentication, sharing, library/history, clip creation, Shorts, and admin use the same navy surfaces, light text, thin blue borders, Geist typography, and restrained violet/coral/mint/cyan accents.
- Keep each route's existing information architecture and workflow; do not copy the Studio's three-column editor layout onto marketing, pricing, auth, sharing, or admin pages.
- The localized application root activates the semantic dark theme. Components should use the existing semantic surface, foreground, border, primary, muted, input, and ring tokens rather than introducing route-specific neutral themes.
- Use the exact local ClipsFlow mark in all shared brand lockups. Keep real source imagery unchanged; do not generate or replace photos.
- Preserve all prices, plan features, auth gates, billing behavior, and user-confirmed YouTube publication behavior while refining presentation.

## Global tokens (actual source values)

| Token                  | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| canvas                 | `#061120`                                                 |
| panel                  | `#0b1623`                                                 |
| raised panel           | `#0d1a2d`                                                 |
| soft panel             | `#101c31`                                                 |
| border / strong border | `#18283f` / `#2d4163`                                     |
| text / muted / subtle  | `#f5f7ff` / `#abbde9` / `#6f83a8`                         |
| violet / soft violet   | `#6844ff` / `#a995ff`                                     |
| coral                  | `#fb604b`                                                 |
| mint / cyan            | `#36f0cf` / `#22d3ee`                                     |
| typography             | Geist Sans; Geist Mono for numeric timecodes where useful |

## Layout and component grammar

- Desktop: 64px topbar; three-column workbench with approximately 240px source/workflow rail, flexible center, and approximately 372px inspector. Use independent scrolling where required; keep the main review controls visible at common laptop heights.
- Center: headline and completed-analysis status; compact filter/sort/search controls; three excerpt cards; selected excerpt with transcript/timeline tabs and search; synchronized waveform and playback bar.
- Right inspector: vertical 9:16 preview; production options for synchronized subtitles, motion, adaptive music and reduced motion; prominent coral render CTA; private YouTube status.
- Left rail: source thumbnail/title/metadata, numbered Source → Analyse → Sélection → Production → Publication steps, secondary library/templates/settings links.
- Corners: controls 5–8px, cards 8–12px, chips/status pills fully rounded; thin cool-blue borders; accents are reserved for selection, primary action and state.
- Icons: use the exact Lucide icons specified by the source (`lucide-react`) in matching roles; do not invent a replacement icon set.
- Responsive: preserve the workflow and preview at tablet/mobile widths through deliberate stacking/drawers, never clip controls or make the transcript unreadable.

## Source-of-truth files

See `.superdesign/init/theme.md` for global raw tokens and `src/components/shorts/ShortsStudio.module.css` for scoped rendered styles. Keep the provided image reference and logo brand asset as actual pixel references during generation.
