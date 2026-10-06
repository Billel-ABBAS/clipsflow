import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";

import {
  ShortsStudio,
  type ShortsCandidate,
  type ShortsStudioEpisode,
} from "@/components/shorts/ShortsStudio";

export const dynamic = "force-dynamic";

// Public, read-only demonstration requested for the approved Canva design.
// The authenticated studio remains a separate route with real user data.
export const metadata: Metadata = {
  title: "ClipsFlow — Démonstration du Studio Shorts",
  robots: { index: false, follow: false },
};

const DESIGN_EPISODE: ShortsStudioEpisode = {
  id: "shorts-design-preview-source",
  title: "Construire une marque qui retient l’attention",
  sourceType: "Vidéo source · mp4 · 2,1 Go",
  durationSeconds: 4_680,
  status: "ready",
  createdAt: "2025-03-12T14:27:00.000Z",
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
      endSeconds: startSeconds + ([58, 46, 49][index] ?? 45),
      score: [94, 87, 83][index] ?? 82 - index,
      title,
      hook:
        index === 0
          ? "Une marque, c’est une promesse qui se vit, tous les jours."
          : "Un passage clair et utilisable pour créer un Short captivant.",
      rationale:
        [
          "Idée claire et mémorable sur l’importance de la cohérence et du point de vue.",
          "Pourquoi certaines marques n’arrivent pas à créer un lien durable.",
          "Comment les créateurs transforment des audiences en communautés.",
        ][index] ??
        "Idée claire, mémorable et directement exploitable en format court.",
      transcriptExcerpt:
        "Ce qu’on oublie souvent, c’est que la marque n’est pas juste un logo. Cette promesse, elle doit se vivre à chaque point de contact. Une marque, c’est une promesse qui se vit, tous les jours. Dans chaque détail de l’expérience, elle construit la confiance.",
      musicMood: index > 20 ? "playful" : "focused",
      motionDirection: "Recadrage éditorial avec sous-titres synchronisés.",
      visualSummary:
        "Un intervenant cadré dans un studio calme, adapté à un Short vertical.",
      selected: index === 0,
    };
  },
);

export default async function ShortsPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { locale } = await params;
  const { state } = await searchParams;
  setRequestLocale(locale);

  return (
    <ShortsStudio
      locale={locale}
      episodes={state === "empty" ? [] : [DESIGN_EPISODE]}
      initialSelectedEpisodeId={
        state === "empty" ? undefined : DESIGN_EPISODE.id
      }
      initialProject={
        state === "empty"
          ? undefined
          : {
              id: "shorts-design-preview-project",
              status: "ready",
              analysisQuotaExceeded: false,
              candidates: DESIGN_CANDIDATES,
            }
      }
      viewerName="Créateur ClipsFlow"
      previewOnly
      designReference={
        state === "empty"
          ? undefined
          : {
              sourcePoster: "/images/shorts-reference/source.webp",
              candidatePosters: [
                "/images/shorts-reference/moment-1.webp",
                "/images/shorts-reference/moment-2.webp",
                "/images/shorts-reference/moment-3.webp",
              ],
              previewPoster: "/images/shorts-reference/portrait.webp",
              waveform: "/images/shorts-reference/waveform.webp",
              transcriptLines: [
                {
                  time: 746,
                  text: "Ce qu’on oublie souvent, c’est que la marque n’est pas juste un logo, c’est une promesse.",
                },
                {
                  time: 751,
                  text: "Et cette promesse, elle doit se vivre à chaque point de contact.",
                },
                {
                  time: 754,
                  text: "Une marque, c’est une promesse qui se vit, tous les jours.",
                },
                { time: 758, text: "dans chaque détail de l’expérience." },
                {
                  time: 761,
                  text: "Si ce que vous dites n’est pas visible dans la réalité,",
                },
                { time: 764, text: "les gens le sentent tout de suite." },
                {
                  time: 768,
                  text: "Et aujourd’hui, ils n’hésitent plus à en parler.",
                },
              ],
            }
      }
      providerCapabilities={{ creativeDirection: true, elevenLabs: true }}
    />
  );
}
