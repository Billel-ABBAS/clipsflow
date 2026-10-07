# Extractable components for `/[locale]/shorts-preview`

No target-level reusable layout component is imported by the preview route. The selected Studio shell is a single route-specific, interactive component (`ShortsStudio.tsx`), not an independent reusable navigation component; converting it to a static Superdesign component would discard its stateful interactions. Per the extraction rules, no component extraction is needed for this target.

Shared primitives in `src/components/ui/` are documented in `components.md`; the target does not import them.
