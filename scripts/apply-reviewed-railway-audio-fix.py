"""One-time, exact-anchor correction for the four reproduced audio regressions."""
from pathlib import Path

CHANGES = {
    "src/components/shorts/ShortsStudio.tsx": [
        (
            "  const adaptedMusicAuthorized =\n    providerCapabilities.elevenLabs &&\n    elevenLabsEnabled &&\n    elevenLabsConsent &&\n    commercialLicenseConfirmed;",
            "  const adaptedMusicAuthorized =\n    !elevenLabsEnabled ||\n    (providerCapabilities.elevenLabs &&\n      elevenLabsConsent &&\n      commercialLicenseConfirmed);",
        ),
        ("Inclure une musique instrumentale adaptée (requise pour générer)",
         "Inclure une musique instrumentale adaptée (facultatif)"),
        ("Include adapted instrumental music (required to render)",
         "Include adapted instrumental music (optional)"),
        ("Pour générer les Shorts, activez la musique adaptée, donnez votre accord explicite et confirmez vos droits d’usage commercial.",
         "Pour utiliser la musique adaptée, donnez votre accord explicite et confirmez vos droits. Vous pouvez aussi désactiver la musique et conserver l’audio original."),
        ("To render these Shorts, enable adapted music, provide explicit consent, and confirm your commercial-use rights.",
         "To use adapted music, provide explicit consent and confirm your rights. You can also disable music and keep the original audio."),
    ],
    "src/app/api/shorts/projects/[projectId]/render/route.ts": [
        (
            "        elevenlabs: productionProfile.elevenlabs,\n        creative_direction: {",
            "        elevenlabs: productionProfile.elevenlabs,\n        ...(productionProfile.voiceover\n          ? { voiceover: productionProfile.voiceover }\n          : {}),\n        creative_direction: {",
        ),
    ],
    "src/lib/clips/voicestudio.ts": [
        (
            '        signal: AbortSignal.timeout(90_000),',
            '        redirect: "error",\n        signal: AbortSignal.timeout(90_000),',
        ),
    ],
    "src/lib/clips/soundbox.ts": [
        (
            '      res = await fetcher(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });',
            '      res = await fetcher(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(20_000) });',
        ),
        (
            '      { headers, signal: AbortSignal.timeout(40_000) },',
            '      { headers, redirect: "error", signal: AbortSignal.timeout(40_000) },',
        ),
    ],
}

# Validate every anchor before writing any file. Never apply to changed code.
prepared = {}
for name, replacements in CHANGES.items():
    path = Path(name)
    text = path.read_text(encoding="utf-8")
    for before, after in replacements:
        if text.count(before) != 1:
            raise SystemExit(f"Refusing ambiguous or changed source: {name}")
        text = text.replace(before, after, 1)
    prepared[path] = text
for path, text in prepared.items():
    path.write_text(text, encoding="utf-8")
    print(f"Applied reviewed correction: {path}")
