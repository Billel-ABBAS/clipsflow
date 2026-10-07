# Route map — rollout Canva across the 11 product screens

Framework: Next.js 16 App Router; locale segment handled by `next-intl`. This map covers all user-facing route screens in the current application. It is a coverage map, not a separate router configuration.

Use the approved Canva Studio direction site-wide through shared brand assets, Geist typography, semantic navy surfaces, cool-blue borders, and restrained violet/coral/mint accents. Retain each route's information architecture; the three-column editor belongs only to the Shorts Studio.

|   # | URL                        | Entry file                                        | Layout / access                                   | Screen purpose                                                                                          |
| --: | -------------------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
|   1 | `/[locale]`                | `src/app/[locale]/page.tsx`                       | Locale layout · public                            | Landing page with product preview, workflow, plans, and FAQ.                                            |
|   2 | `/[locale]/dashboard`      | `src/app/[locale]/(dashboard)/dashboard/page.tsx` | Dashboard shell · authenticated                   | Overview, recent activity, quotas, and creation shortcuts.                                              |
|   3 | `/[locale]/clips`          | `src/app/[locale]/(dashboard)/clips/page.tsx`     | Dashboard shell · authenticated                   | Private clip library and render history.                                                                |
|   4 | `/[locale]/clips/new`      | `src/app/[locale]/(dashboard)/clips/new/page.tsx` | Dashboard shell · authenticated                   | Existing short-clip creation workflow.                                                                  |
|   5 | `/[locale]/shorts`         | `src/app/[locale]/(dashboard)/shorts/page.tsx`    | Dashboard shell · authenticated and feature-gated | Functional long-form Shorts workflow: source, analysis, selection, production, and YouTube publication. |
|   6 | `/[locale]/shorts-preview` | `src/app/[locale]/shorts-preview/page.tsx`        | Locale layout · public, read-only, noindex        | Approved Canva selection-screen showcase; `?state=empty` shows source intake.                           |
|   7 | `/[locale]/pricing`        | `src/app/[locale]/(marketing)/pricing/page.tsx`   | Locale layout · public                            | Pricing plans and billing CTA.                                                                          |
|   8 | `/[locale]/login`          | `src/app/[locale]/(auth)/login/page.tsx`          | Locale layout · public                            | Sign-in, account creation, and password-recovery entry.                                                 |
|   9 | `/[locale]/reset-password` | `src/app/[locale]/(auth)/reset-password/page.tsx` | Locale layout · recovery session required         | Password-reset form and invalid/expired-link state.                                                     |
|  10 | `/[locale]/share/[token]`  | `src/app/[locale]/share/[token]/page.tsx`         | Locale layout · signed share token required       | Private, expiring shared-clip playback and captions.                                                    |
|  11 | `/[locale]/admin`          | `src/app/[locale]/(dashboard)/admin/page.tsx`     | Dashboard shell · authenticated admin only        | Operational usage, quotas, render health, and admin metrics.                                            |

The provided Canva design is a single Studio selection screen, not an 11-page deck. Only `/shorts-preview` is a visual demo; it must never be mistaken for authenticated user data or functional production output. The App Router filesystem remains the route source of truth.
