import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import {
  ShortsStudio,
  type ShortsCandidate,
  type ShortsStudioEpisode,
} from "@/components/shorts/ShortsStudio";

export const dynamic = "force-dynamic";

const DESIGN_EPISODE: ShortsStudioEpisode = {
  id: "shorts-design-preview-source",
  title: "Construire une marque qui retient l’attention",
  sourceType: "Vidéo source · mp4 · 2,1 Go",
  durationSeconds: 4_680,
  status: "ready",
  createdAt: "2026-10-06T10:00:00.000Z",
};

const DESIGN_TITLES = [
  "Une promesse qui se vit",
  "Les marques qui disparaissent",
  "Le pouvoir d’une communauté",
];

const DESIGN_CANDIDATES: ShortsCandidate[] = Array.from(
  { length: 24 },
  (_, index) => {
    const rank = index + 1;
    const title = DESIGN_TITLES[index] ?? `Moment stratégique ${rank}`;
    const startSeconds = 754 + index * 43;
    return {
      id: `design-candidate-${rank}`,
      rank,
      startSeconds,
      endSeconds: startSeconds + 58 - (index % 3) * 5,
      score: 94 - index,
      title,
      hook:
        index === 0
          ? "Une marque, c’est une promesse qui se vit, tous les jours."
          : "Un passage clair et utilisable pour créer un Short captivant.",
      rationale:
        "Idée claire, mémorable et directement exploitable en format court.",
      transcriptExcerpt:
        "Ce qu’on oublie souvent, c’est que la marque n’est pas juste un logo. Cette promesse, elle doit se vivre à chaque point de contact. Une marque, c’est une promesse qui se vit, tous les jours. Dans chaque détail de l’expérience, elle construit la confiance.",
      musicMood: "focused",
      motionDirection: "Recadrage éditorial avec sous-titres synchronisés.",
      visualSummary:
        "Un intervenant cadré dans un studio calme, adapté à un Short vertical.",
      selected: index === 0,
    };
  },
);

export default async function ShortsPreviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <ShortsStudio
      locale={locale}
      episodes={[DESIGN_EPISODE]}
      initialSelectedEpisodeId={DESIGN_EPISODE.id}
      initialProject={{
        id: "shorts-design-preview-project",
        status: "ready",
        analysisQuotaExceeded: false,
        candidates: DESIGN_CANDIDATES,
      }}
      providerCapabilities={{ creativeDirection: true, elevenLabs: true }}
    />
  );
}
