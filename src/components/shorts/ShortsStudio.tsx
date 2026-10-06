"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CirclePlay,
  Clapperboard,
  Clock3,
  FileAudio,
  FolderOpen,
  Library,
  LockKeyhole,
  MessageSquare,
  MoreHorizontal,
  Music2,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Subtitles,
  UploadCloud,
  Video,
  Volume2,
} from "lucide-react";
import { Upload } from "tus-js-client";

import { cn } from "@/lib/utils";
import { createClient as createBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  SHORTS_SOURCE_MAX_BYTES,
  SHORTS_SOURCE_MIME_TYPES,
  buildShortsTusOptions,
  resolveShortsSourceMime,
} from "@/lib/shorts/source-upload";
import {
  findMatchingPendingShortsSourceUpload,
  parsePendingShortsSourceUploads,
  removePendingShortsSourceUpload,
  serialisePendingShortsSourceUploads,
  SHORTS_PENDING_SOURCE_UPLOADS_KEY,
  type PendingShortsSourceUpload,
} from "@/lib/shorts/source-upload-resume";
import {
  SHORTS_MUSIC_MOODS,
  type ShortsMusicMood,
} from "@/lib/shorts/project-contract";
import {
  releaseShortsProjectIdempotencyIntent,
  resolveShortsProjectIdempotencyIntent,
} from "@/lib/shorts/project-idempotency";
import { readShortsSourceDuration } from "@/lib/shorts/source-media-duration";
import { CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED } from "@/lib/clips/creative-director-model";
import type { ShortsProviderCapabilities } from "@/lib/shorts/provider-capabilities";

import styles from "./ShortsStudio.module.css";

export const SHORTS_MIN_SOURCE_DURATION_SECONDS = 20 * 60;
export const SHORTS_MAX_SOURCE_DURATION_SECONDS = 2 * 60 * 60;

const POLLING_INTERVAL_MS = 4_000;

export function resolveShortsCandidatePage(
  candidateCount: number,
  activeIndex: number,
) {
  const pageCount = Math.ceil(candidateCount / 3);
  const pageIndex = Math.min(
    Math.max(0, Math.floor(activeIndex / 3)),
    Math.max(0, pageCount - 1),
  );
  const start = pageIndex * 3;
  return {
    start,
    end: Math.min(candidateCount, start + 3),
    pageIndex,
    pageCount,
  };
}

const PROJECT_STATUSES = [
  "draft",
  "queued",
  "transcribing",
  "analyzing",
  "ready",
  "failed",
] as const;

const ANALYSIS_MODES = ["audio", "audio_video"] as const;
const ASPECT_RATIOS = ["9:16", "1:1", "4:5", "16:9"] as const;
const SUBTITLE_STYLES = [
  "viral",
  "premium",
  "minimal",
  "karaoke_pop",
  "cinematic",
  "comic_bubble",
] as const;
const MOTION_TEMPLATES = [
  "punchy-cuts",
  "kinetic-captions",
  "editorial-focus",
  "calm-focus",
  "audiogram-waveform",
  "minimal-static",
] as const;

const WAVEFORM_BAR_HEIGHTS = [
  21, 38, 55, 28, 67, 40, 72, 31, 48, 64, 27, 39, 58, 83, 51, 33, 68, 45, 77,
  56, 32, 70, 42, 60, 25, 46, 74, 52, 35, 80, 47, 63, 30, 57, 71, 38, 66, 50,
  29, 77, 44, 61, 36, 69, 53, 33, 75, 46, 65, 27, 55, 72, 40, 62, 31, 58, 77,
  49, 34, 67, 45, 79, 54, 26, 59, 70, 37, 64, 48, 29, 74, 42, 63, 36, 68, 51,
  32, 78, 44, 57, 30, 72, 48, 65, 39, 56, 76, 43, 61,
] as const;

type ProjectStatus = (typeof PROJECT_STATUSES)[number];
type AnalysisMode = (typeof ANALYSIS_MODES)[number];
type AspectRatio = (typeof ASPECT_RATIOS)[number];
type SubtitleStyle = (typeof SUBTITLE_STYLES)[number];
type MotionTemplate = (typeof MOTION_TEMPLATES)[number];

const MUSIC_MOOD_LABELS: Record<
  "fr" | "en",
  Record<ShortsMusicMood, string>
> = {
  fr: {
    focused: "concentrée",
    playful: "ludique",
    uplifting: "inspirante",
    warm: "chaleureuse",
    energetic: "énergique",
    minimal: "minimaliste",
  },
  en: {
    focused: "focused",
    playful: "playful",
    uplifting: "uplifting",
    warm: "warm",
    energetic: "energetic",
    minimal: "minimal",
  },
};

export type ShortsStudioEpisode = Readonly<{
  id: string;
  title: string;
  sourceType: string;
  durationSeconds: number | null;
  status: string;
  createdAt: string;
}>;

export type ShortsCandidate = Readonly<{
  id: string;
  rank: number;
  startSeconds: number;
  endSeconds: number;
  score: number;
  title: string;
  hook: string;
  rationale: string;
  transcriptExcerpt: string;
  musicMood: ShortsMusicMood;
  motionDirection: string;
  visualSummary: string | null;
  selected: boolean;
}>;

export type ShortsProject = Readonly<{
  id: string;
  status: ProjectStatus;
  analysisQuotaExceeded: boolean;
  candidates: readonly ShortsCandidate[];
}>;

export type ProductionProfileInput = Readonly<{
  aspect_ratio: AspectRatio;
  subtitle_style: SubtitleStyle;
  subtitles: Readonly<{
    synchronized: true;
    auto_emphasis: boolean;
  }>;
  motion: Readonly<{
    template: MotionTemplate;
    reduced_motion: boolean;
    renderer: "deterministic";
  }>;
  elevenlabs: Readonly<{
    enabled: boolean;
    explicit_consent: boolean;
    commercial_license_confirmed: boolean;
    use_cases: readonly ("instrumental_music" | "sound_effects")[];
    synthetic_voice: false;
  }>;
  creative_direction: Readonly<{
    enabled: boolean;
    explicit_consent: boolean;
  }>;
}>;

export interface ShortsStudioProps {
  locale: string;
  episodes: readonly ShortsStudioEpisode[];
  providerCapabilities: ShortsProviderCapabilities;
  sourceLoadError?: boolean;
  /** Development-only fixture seam for visual regression and local design QA. */
  initialProject?: ShortsProject;
  initialSelectedEpisodeId?: string;
}

type ShortsSourceUploadState =
  | { status: "idle" }
  | {
      status: "uploading";
      filename: string;
      progress: number;
      verifying: boolean;
    }
  | { status: "done"; filename: string }
  | { status: "error"; filename: string; message: string };

type ActiveShortsSourceUpload = {
  upload: Upload;
  episodeId: string;
  filename: string;
  title: string;
  sizeBytes: number;
  durationPromise: Promise<number | null>;
  phase: "transfer" | "complete";
  callbacks: { resolve: () => void; reject: (error: Error) => void } | null;
};

type Copy = {
  eyebrow: string;
  title: string;
  description: string;
  sourceTitle: string;
  sourceDescription: string;
  sourceLabel: string;
  sourcePlaceholder: string;
  sourceLoadError: string;
  uploadLabel: string;
  uploadHelp: string;
  uploadButton: string;
  uploadProgress: (percent: number) => string;
  uploadVerifying: string;
  uploadReady: string;
  uploadError: string;
  uploadTooLarge: string;
  uploadUnsupported: string;
  uploadResumeHint: string;
  retryUpload: string;
  durationLabel: string;
  durationHint: string;
  durationInvalid: string;
  analysisLabel: string;
  audioTitle: string;
  audioDescription: string;
  audioVideoTitle: string;
  audioVideoDescription: string;
  instructionsLabel: string;
  instructionsPlaceholder: string;
  instructionsHint: string;
  jevConsentLabel: string;
  jevConsentDescription: string;
  startAnalysis: string;
  retryAnalysis: string;
  startingAnalysis: string;
  projectCreated: string;
  analysisStatus: string;
  draft: string;
  queued: string;
  transcribing: string;
  analyzing: string;
  ready: string;
  failed: string;
  refreshing: string;
  candidatesTitle: string;
  candidatesDescription: string;
  awaitingCandidates: string;
  noCandidates: string;
  selectedCount: (count: number) => string;
  score: string;
  fromTo: (start: string, end: string, length: string) => string;
  why: string;
  transcript: string;
  musicMood: (mood: ShortsMusicMood) => string;
  motionDirection: string;
  visual: string;
  selectCandidate: string;
  selected: string;
  productionTitle: string;
  productionDescription: string;
  aspectLabel: string;
  subtitleLabel: string;
  motionLabel: string;
  reducedMotionLabel: string;
  reducedMotionDescription: string;
  elevenLabsLabel: string;
  elevenLabsEnableLabel: string;
  elevenLabsDescription: string;
  elevenLabsConsentLabel: string;
  elevenLabsLicenseLabel: string;
  elevenLabsUnavailable: string;
  adaptedMusicRequired: string;
  opusTitle: string;
  opusDescription: string;
  opusEnableLabel: string;
  opusUnavailable: string;
  elevenLabsSafety: string;
  saveSelection: string;
  savingSelection: string;
  selectionSaved: (count: number) => string;
  youtubeTitle: string;
  youtubeDescription: string;
  youtubeSafety: string;
  genericError: string;
  audioVideoSourceRequired: string;
  analysisQuotaExceeded: string;
  analysisUnavailable: string;
  projectError: string;
  saveError: string;
  noEpisode: string;
  unavailableDuration: string;
  renderSelected: string;
  renderingSelected: string;
  renderQueuedMessage: (queued: number, total: number) => string;
  openGallery: string;
};

const COPY: Record<"fr" | "en", Copy> = {
  fr: {
    eyebrow: "Studio Shorts IA",
    title: "Transformez un épisode long en Shorts prêts à produire",
    description:
      "Importez une vidéo ou un podcast, ou choisissez une source de votre bibliothèque. L’analyse vous propose les moments qui correspondent à vos consignes.",
    sourceTitle: "1. Source et analyse",
    sourceDescription:
      "Le traitement n’accepte que les sources de 20 minutes à 2 heures.",
    sourceLabel: "Épisode de votre bibliothèque",
    sourcePlaceholder: "Choisir un épisode",
    sourceLoadError:
      "La bibliothèque n’est pas disponible pour le moment. Réessayez après avoir rechargé la page.",
    uploadLabel: "Importer une vidéo ou un podcast",
    uploadHelp:
      "MP4, MOV, WebM, MP3, M4A ou WAV · jusqu’à 8 Gio. En cas de coupure, vous pouvez reprendre l’envoi depuis cette page.",
    uploadButton: "Choisir un fichier",
    uploadProgress: (percent) => `Import en cours · ${percent} %`,
    uploadVerifying: "Vérification du fichier dans le stockage…",
    uploadReady: "Fichier importé et prêt à analyser.",
    uploadError:
      "L’import a échoué. Si cette page est toujours ouverte, vous pouvez reprendre l’envoi.",
    uploadTooLarge: "Ce fichier dépasse la limite d’import de 8 Gio.",
    uploadUnsupported: "Ce format de fichier n’est pas pris en charge.",
    uploadResumeHint:
      "Un import interrompu a été retrouvé. Choisissez à nouveau exactement le même fichier pour reprendre l’envoi.",
    retryUpload: "Reprendre l’import",
    durationLabel: "Durée de la source (en secondes)",
    durationHint:
      "Détectée automatiquement à l’import si le navigateur peut lire le fichier ; ajustez si besoin. Entre 1 200 s (20 min) et 7 200 s (2 h).",
    durationInvalid:
      "Indiquez une durée comprise entre 20 minutes et 2 heures.",
    analysisLabel: "Mode d’analyse",
    audioTitle: "Audio",
    audioDescription: "Transcription, rythme, idées fortes et qualité du hook.",
    audioVideoTitle: "Audio + vidéo",
    audioVideoDescription:
      "Analyse aussi quelques images des meilleurs extraits pour ajuster leur classement, sans modifier la source.",
    instructionsLabel: "Vos consignes (facultatif)",
    instructionsPlaceholder:
      "Ex. privilégier les conseils concrets, un ton calme et les passages utilisables sur YouTube Shorts.",
    instructionsHint:
      "Ces consignes orientent les propositions ; elles ne déclenchent aucune publication.",
    jevConsentLabel: "Autoriser l’évaluation facultative de Jev pour ce projet",
    jevConsentDescription:
      "Si Jev est activé en mode comparaison, ClipsFlow transmet à TypeSafe vos consignes et des extraits de transcription (jusqu’à 1 200 caractères chacun) pour les noter. Jev est principalement entraîné en anglais : ses évaluations du français peuvent être moins fiables. Le score reste expérimental et ne change pas l’ordre affiché. Désactivé par défaut.",
    startAnalysis: "Lancer l’analyse",
    retryAnalysis: "Relancer l’analyse",
    startingAnalysis: "Création du projet…",
    projectCreated: "Projet créé. L’analyse se poursuit ci-dessous.",
    analysisStatus: "État de l’analyse",
    draft: "Brouillon",
    queued: "En attente de traitement",
    transcribing: "Transcription en cours",
    analyzing: "Analyse des meilleurs passages",
    ready: "Propositions prêtes à être examinées",
    failed: "L’analyse n’a pas abouti",
    refreshing: "Actualisation automatique…",
    candidatesTitle: "2. Meilleurs extraits proposés",
    candidatesDescription:
      "Choisissez seulement les passages que vous souhaitez réellement produire. Vous gardez le dernier mot.",
    awaitingCandidates:
      "Les propositions apparaîtront ici dès que la transcription et l’analyse seront terminées.",
    noCandidates:
      "Aucun extrait exploitable n’a été retourné. Modifiez les consignes ou réessayez avec une autre source.",
    selectedCount: (count) =>
      `${count} extrait${count > 1 ? "s" : ""} sélectionné${count > 1 ? "s" : ""}`,
    score: "Score",
    fromTo: (start, end, length) => `${start} → ${end} · ${length}`,
    why: "Pourquoi ce passage",
    transcript: "Extrait de transcription",
    musicMood: (mood) =>
      `Ambiance musicale suggérée : ${MUSIC_MOOD_LABELS.fr[mood]}`,
    motionDirection: "Piste de motion design",
    visual: "Repère visuel",
    selectCandidate: "Sélectionner cet extrait",
    selected: "Sélectionné",
    productionTitle: "3. Direction de production",
    productionDescription:
      "Ces réglages sont enregistrés avec votre sélection. La génération ne démarre pas sans l’étape de production dédiée.",
    aspectLabel: "Format",
    subtitleLabel: "Style de sous-titres",
    motionLabel: "Motion design",
    reducedMotionLabel: "Réduire les mouvements",
    reducedMotionDescription:
      "Utilise une animation minimale et limite les changements visuels rapides.",
    elevenLabsLabel: "Musique adaptée",
    elevenLabsEnableLabel:
      "Inclure une musique instrumentale adaptée (requise pour générer)",
    elevenLabsDescription:
      "Chaque Short reçoit une musique instrumentale mixée sous la voix. Des effets non verbaux peuvent aussi souligner le motion design.",
    elevenLabsConsentLabel:
      "J’autorise explicitement ElevenLabs à générer la musique instrumentale et les éventuels effets pour ces extraits.",
    elevenLabsLicenseLabel:
      "Je confirme disposer des droits/licences nécessaires pour l’usage commercial et la publication prévus.",
    elevenLabsUnavailable:
      "La génération ElevenLabs n’est pas configurée côté serveur avec une clé privée, un budget autorisé et le flag fournisseur activé.",
    adaptedMusicRequired:
      "Pour générer les Shorts, activez la musique adaptée, donnez votre accord explicite et confirmez vos droits d’usage commercial.",
    opusTitle: "Direction créative Claude Opus 5.5",
    opusDescription:
      "Si vous l’autorisez, Opus reçoit uniquement la transcription du Short sélectionné, vos consignes (1 200 caractères max.) et son résumé visuel facultatif. Il propose le titre, l’accroche, la musique et un preset motion autorisé. Le rendu visuel reste déterministe; ElevenLabs ne crée que la musique et les effets non verbaux. Appel serveur désactivé par défaut : il requiert le flag, une clé privée et un budget autorisé.",
    opusEnableLabel:
      "J’autorise Claude Opus 5.5 à analyser les données de cet extrait sélectionné pour préparer sa direction créative.",
    opusUnavailable:
      "Opus 5.5 n’est pas configuré côté serveur : vérifiez la clé Anthropic privée, le flag fournisseur et l’autorisation de budget.",
    elevenLabsSafety:
      "Aucune voix synthétique, aucun clonage de voix : ElevenLabs est limité à la musique instrumentale et aux effets sonores. Le rendu visuel reste déterministe pour préserver la source.",
    saveSelection: "Enregistrer ma sélection",
    savingSelection: "Enregistrement…",
    selectionSaved: (count) =>
      `${count} extrait${count > 1 ? "s" : ""} enregistré${count > 1 ? "s" : ""} pour la production.`,
    youtubeTitle: "4. Publication YouTube",
    youtubeDescription:
      "La connexion du compte YouTube intervient après le rendu. Vous pourrez préparer les métadonnées puis confirmer chaque envoi.",
    youtubeSafety:
      "Aucune vidéo n’est publiée depuis cet écran. Toute publication doit être confirmée ; la visibilité proposée démarre en privé.",
    genericError: "Une erreur est survenue. Réessayez dans un instant.",
    audioVideoSourceRequired:
      "Le mode audio + vidéo nécessite un fichier vidéo. Pour un podcast audio, choisissez le mode Audio.",
    analysisQuotaExceeded:
      "Le quota mensuel d’analyse de sources est atteint pour votre offre.",
    analysisUnavailable:
      "L’analyse IA est temporairement indisponible. Votre fichier est conservé ; réessayez dans quelques minutes.",
    projectError:
      "Impossible de créer ou de lire le projet d’analyse. Vérifiez la source puis réessayez.",
    saveError:
      "La sélection n’a pas été enregistrée. Aucun rendu n’a été démarré.",
    noEpisode:
      "Importez une source ou choisissez un épisode avant de lancer l’analyse.",
    unavailableDuration: "Durée non renseignée",
    renderSelected: "Générer les Shorts sélectionnés",
    renderingSelected: "Mise en file des rendus…",
    renderQueuedMessage: (queued, total) =>
      `${queued} Short${queued > 1 ? "s" : ""} sur ${total} mis en file. Les rendus apparaîtront dans la galerie Clips.`,
    openGallery: "Ouvrir la galerie Clips",
  },
  en: {
    eyebrow: "AI Shorts Studio",
    title: "Turn a long episode into Shorts ready for production",
    description:
      "Upload a video or podcast, or choose a source from your library. Analysis finds moments that match your guidance.",
    sourceTitle: "1. Source and analysis",
    sourceDescription:
      "Only sources between 20 minutes and two hours can be processed.",
    sourceLabel: "Episode from your library",
    sourcePlaceholder: "Choose an episode",
    sourceLoadError:
      "Your library is unavailable right now. Reload the page and try again.",
    uploadLabel: "Upload a video or podcast",
    uploadHelp:
      "MP4, MOV, WebM, MP3, M4A, or WAV · up to 8 GiB. After an interruption, you can resume the upload from this page.",
    uploadButton: "Choose a file",
    uploadProgress: (percent) => `Uploading · ${percent}%`,
    uploadVerifying: "Verifying the file in storage…",
    uploadReady: "File uploaded and ready to analyze.",
    uploadError:
      "The upload failed. You can resume it if this page is still open.",
    uploadTooLarge: "This file exceeds the 8 GiB upload limit.",
    uploadUnsupported: "This file format is not supported.",
    uploadResumeHint:
      "An interrupted upload was found. Select the exact same file again to resume it.",
    retryUpload: "Resume upload",
    durationLabel: "Source duration (seconds)",
    durationHint:
      "Detected automatically on upload when your browser can read the file; adjust if needed. Between 1,200 s (20 min) and 7,200 s (2 h).",
    durationInvalid: "Enter a duration between 20 minutes and two hours.",
    analysisLabel: "Analysis mode",
    audioTitle: "Audio",
    audioDescription: "Transcript, pacing, key ideas, and hook quality.",
    audioVideoTitle: "Audio + video",
    audioVideoDescription:
      "Also reviews sampled frames from the leading moments to adjust their ranking without changing the source.",
    instructionsLabel: "Your guidance (optional)",
    instructionsPlaceholder:
      "For example: prioritize practical advice, a calm tone, and moments that work on YouTube Shorts.",
    instructionsHint:
      "This guidance steers recommendations only; it never triggers publishing.",
    jevConsentLabel: "Allow Jev’s optional evaluation for this project",
    jevConsentDescription:
      "If Jev is enabled in shadow mode, ClipsFlow sends your guidance and transcript excerpts (up to 1,200 characters each) to TypeSafe for scoring. Jev is primarily trained in English, so scores for French content may be less reliable. The score is experimental and never changes the displayed order. Off by default.",
    startAnalysis: "Start analysis",
    retryAnalysis: "Retry analysis",
    startingAnalysis: "Creating project…",
    projectCreated: "Project created. Analysis continues below.",
    analysisStatus: "Analysis status",
    draft: "Draft",
    queued: "Waiting for processing",
    transcribing: "Transcript in progress",
    analyzing: "Analyzing the best moments",
    ready: "Recommendations are ready to review",
    failed: "Analysis did not complete",
    refreshing: "Refreshing automatically…",
    candidatesTitle: "2. Suggested best moments",
    candidatesDescription:
      "Select only the moments you actually want to produce. You remain in control.",
    awaitingCandidates:
      "Recommendations will appear here when transcription and analysis finish.",
    noCandidates:
      "No usable moments were returned. Change the guidance or try a different source.",
    selectedCount: (count) => `${count} clip${count === 1 ? "" : "s"} selected`,
    score: "Score",
    fromTo: (start, end, length) => `${start} → ${end} · ${length}`,
    why: "Why this moment",
    transcript: "Transcript excerpt",
    musicMood: (mood) => `Suggested music mood: ${MUSIC_MOOD_LABELS.en[mood]}`,
    motionDirection: "Motion-design direction",
    visual: "Visual note",
    selectCandidate: "Select this moment",
    selected: "Selected",
    productionTitle: "3. Production direction",
    productionDescription:
      "These settings are saved with your selection. Rendering does not begin without its dedicated production step.",
    aspectLabel: "Format",
    subtitleLabel: "Subtitle style",
    motionLabel: "Motion design",
    reducedMotionLabel: "Reduce motion",
    reducedMotionDescription:
      "Uses minimal animation and limits fast visual changes.",
    elevenLabsLabel: "Adapted music",
    elevenLabsEnableLabel:
      "Include adapted instrumental music (required to render)",
    elevenLabsDescription:
      "Every Short receives an instrumental bed mixed under speech. Non-verbal effects may also accent the motion design.",
    elevenLabsConsentLabel:
      "I explicitly authorize ElevenLabs to generate instrumental music and any selected effects for these moments.",
    elevenLabsLicenseLabel:
      "I confirm that I hold the rights/licenses needed for the intended commercial use and publication.",
    elevenLabsUnavailable:
      "ElevenLabs generation is not configured on the server with a private key, authorized budget, and the provider flag enabled.",
    adaptedMusicRequired:
      "To render these Shorts, enable adapted music, provide explicit consent, and confirm your commercial-use rights.",
    opusTitle: "Claude Opus 5.5 creative direction",
    opusDescription:
      "If enabled, Opus receives only the selected Short’s transcript, your guidance (max. 1,200 characters), and its optional visual summary. It suggests a title, hook, music, and an allow-listed motion preset. Visual rendering remains deterministic; ElevenLabs generates instrumental music and non-verbal effects only. Server calls are off by default and require the server flag, a private key, and an authorized budget.",
    opusEnableLabel:
      "I authorize Claude Opus 5.5 to analyze this selected moment and prepare its creative direction.",
    opusUnavailable:
      "Opus 5.5 is not configured on the server: check the private Anthropic key, provider flag, and explicit budget authorization.",
    elevenLabsSafety:
      "No synthetic voice and no voice cloning: ElevenLabs is limited to instrumental music and sound effects. Visual rendering remains deterministic to preserve the source.",
    saveSelection: "Save my selection",
    savingSelection: "Saving…",
    selectionSaved: (count) =>
      `${count} clip${count === 1 ? "" : "s"} saved for production.`,
    youtubeTitle: "4. YouTube publishing",
    youtubeDescription:
      "Connecting a YouTube account happens after rendering. You will be able to prepare metadata and confirm every upload.",
    youtubeSafety:
      "No video is published from this screen. Every publication needs confirmation; the proposed visibility starts as private.",
    genericError: "Something went wrong. Please try again shortly.",
    audioVideoSourceRequired:
      "Audio + video mode requires a video file. For an audio-only podcast, choose Audio mode.",
    analysisQuotaExceeded:
      "Your plan’s monthly source-analysis quota has been reached.",
    analysisUnavailable:
      "AI analysis is temporarily unavailable. Your file is safe; please try again in a few minutes.",
    projectError:
      "The analysis project could not be created or read. Check the source and try again.",
    saveError: "The selection was not saved. No render was started.",
    noEpisode: "Upload a source or choose an episode before starting analysis.",
    unavailableDuration: "Duration not available",
    renderSelected: "Generate selected Shorts",
    renderingSelected: "Queueing renders…",
    renderQueuedMessage: (queued, total) =>
      `${queued} of ${total} Short${total === 1 ? "" : "s"} queued. Renders will appear in the Clips gallery.`,
    openGallery: "Open Clips gallery",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseShortsUploadInit(value: unknown): {
  episodeId: string;
  uploadToken: string;
  storagePath: string;
  endpoint: string;
} | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const { episode_id, upload_token, storage_path, endpoint } = value.data;
  if (
    typeof episode_id !== "string" ||
    !UUID_PATTERN.test(episode_id) ||
    typeof upload_token !== "string" ||
    upload_token.length < 16 ||
    upload_token.length > 8_000 ||
    typeof storage_path !== "string" ||
    storage_path.length > 500 ||
    !storage_path.includes("/") ||
    typeof endpoint !== "string" ||
    endpoint.length > 500
  ) {
    return null;
  }
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return null;
  }
  if (
    parsedEndpoint.protocol !== "https:" &&
    !(
      parsedEndpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsedEndpoint.hostname)
    )
  ) {
    return null;
  }
  if (!parsedEndpoint.pathname.endsWith("/storage/v1/upload/resumable")) {
    return null;
  }
  return {
    episodeId: episode_id,
    uploadToken: upload_token,
    storagePath: storage_path,
    endpoint,
  };
}

function parseShortsUploadResume(
  value: unknown,
  episodeId: string,
):
  | { status: "ready" }
  | {
      status: "pending";
      upload: NonNullable<ReturnType<typeof parseShortsUploadInit>>;
    }
  | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  if (value.data.episode_id !== episodeId) return null;
  if (value.data.status === "ready") return { status: "ready" };
  if (value.data.status !== "pending") return null;
  const upload = parseShortsUploadInit(value);
  return upload?.episodeId === episodeId ? { status: "pending", upload } : null;
}

function readBrowserPendingSourceUploads(): PendingShortsSourceUpload[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SHORTS_PENDING_SOURCE_UPLOADS_KEY);
    return raw
      ? parsePendingShortsSourceUploads(JSON.parse(raw) as unknown)
      : [];
  } catch {
    return [];
  }
}

const PENDING_SOURCE_UPLOADS_CHANGED_EVENT =
  "clipsflow:shorts:pending-source-uploads-changed";

function subscribeToPendingSourceUploads(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(PENDING_SOURCE_UPLOADS_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PENDING_SOURCE_UPLOADS_CHANGED_EVENT, onChange);
  };
}

function getHasPendingSourceUploadSnapshot(): boolean {
  return readBrowserPendingSourceUploads().length > 0;
}

function getServerPendingSourceUploadSnapshot(): boolean {
  return false;
}

function writeBrowserPendingSourceUploads(
  uploads: readonly PendingShortsSourceUpload[],
): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      SHORTS_PENDING_SOURCE_UPLOADS_KEY,
      serialisePendingShortsSourceUploads(uploads),
    );
    window.dispatchEvent(new Event(PENDING_SOURCE_UPLOADS_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

function titleFromSourceFilename(filename: string): string {
  const title = filename
    .replace(/\.[^.]+$/u, "")
    .replace(/[\s._-]+/gu, " ")
    .trim();
  return title.slice(0, 200) || "Shorts source";
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return (
    typeof value === "string" &&
    (PROJECT_STATUSES as readonly string[]).includes(value)
  );
}

function shortText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim().slice(0, maximumLength);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normaliseCandidate(value: unknown): ShortsCandidate | null {
  if (!isRecord(value)) return null;
  const id = shortText(value.id, 100);
  const rank = finiteNumber(value.rank);
  const startSeconds = finiteNumber(value.start_seconds);
  const endSeconds = finiteNumber(value.end_seconds);
  const score = finiteNumber(value.score);
  const title = shortText(value.title, 160);
  const hook = shortText(value.hook, 280);
  const rationale = shortText(value.rationale, 1_200);
  const transcriptExcerpt = shortText(value.transcript_excerpt, 6_000);
  const musicMood =
    typeof value.music_mood === "string" &&
    (SHORTS_MUSIC_MOODS as readonly string[]).includes(value.music_mood)
      ? (value.music_mood as ShortsMusicMood)
      : null;
  const motionDirection = shortText(value.motion_direction, 160);
  if (
    !id ||
    rank === null ||
    startSeconds === null ||
    endSeconds === null ||
    score === null ||
    endSeconds <= startSeconds ||
    !title ||
    !hook ||
    !rationale ||
    !transcriptExcerpt ||
    !musicMood ||
    !motionDirection
  ) {
    return null;
  }
  const visualSummary = shortText(value.visual_summary, 1_200) || null;
  return {
    id,
    rank: Math.round(rank),
    startSeconds,
    endSeconds,
    score: Math.max(0, Math.min(100, Math.round(score))),
    title,
    hook,
    rationale,
    transcriptExcerpt,
    musicMood,
    motionDirection,
    visualSummary,
    selected: value.selected === true,
  };
}

/** Normalize an untrusted project response before it reaches the interface. */
export function normaliseShortsProject(value: unknown): ShortsProject | null {
  const envelope = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(envelope)) return null;
  const id = shortText(envelope.id, 100);
  if (!id || !isProjectStatus(envelope.status)) return null;
  const seenCandidateIds = new Set<string>();
  const candidates: ShortsCandidate[] = [];
  if (Array.isArray(envelope.candidates)) {
    for (const rawCandidate of envelope.candidates) {
      const candidate = normaliseCandidate(rawCandidate);
      if (!candidate || seenCandidateIds.has(candidate.id)) continue;
      seenCandidateIds.add(candidate.id);
      candidates.push(candidate);
    }
  }
  candidates.sort(
    (left, right) => left.rank - right.rank || right.score - left.score,
  );
  return {
    id,
    status: envelope.status,
    analysisQuotaExceeded: envelope.analysis_quota_exceeded === true,
    candidates,
  };
}

/** Format a source timestamp without relying on browser locale or time zones. */
export function formatShortsTimestamp(value: unknown): string {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds < 0) return "—";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function isValidShortsSourceDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= SHORTS_MIN_SOURCE_DURATION_SECONDS &&
    value <= SHORTS_MAX_SOURCE_DURATION_SECONDS
  );
}

export function isShortsAnalysisUnavailable(
  status: number,
  errorCode: unknown,
): boolean {
  return status >= 500 || errorCode === "analysis_temporarily_unavailable";
}

export function buildProductionProfile(input: {
  aspectRatio: AspectRatio;
  subtitleStyle: SubtitleStyle;
  motionTemplate: MotionTemplate;
  reducedMotion: boolean;
  elevenLabsEnabled: boolean;
  elevenLabsAvailable: boolean;
  elevenLabsConsent: boolean;
  commercialLicenseConfirmed: boolean;
  creativeDirectionEnabled: boolean;
  creativeDirectionAvailable: boolean;
  creativeDirectionConsent: boolean;
}): ProductionProfileInput {
  const elevenLabsEnabled =
    input.elevenLabsAvailable &&
    input.elevenLabsEnabled &&
    input.elevenLabsConsent &&
    input.commercialLicenseConfirmed;
  const creativeDirectionEnabled =
    input.creativeDirectionAvailable &&
    CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED &&
    input.creativeDirectionEnabled &&
    input.creativeDirectionConsent;
  return {
    aspect_ratio: input.aspectRatio,
    subtitle_style: input.subtitleStyle,
    subtitles: {
      synchronized: true,
      auto_emphasis: !input.reducedMotion,
    },
    motion: {
      template: input.reducedMotion ? "minimal-static" : input.motionTemplate,
      reduced_motion: input.reducedMotion,
      renderer: "deterministic",
    },
    elevenlabs: {
      enabled: elevenLabsEnabled,
      explicit_consent: elevenLabsEnabled,
      commercial_license_confirmed: elevenLabsEnabled,
      use_cases: elevenLabsEnabled
        ? ["instrumental_music", "sound_effects"]
        : [],
      synthetic_voice: false,
    },
    creative_direction: {
      enabled: creativeDirectionEnabled,
      explicit_consent: creativeDirectionEnabled,
    },
  };
}

export function isShortsRenderDisabled(input: {
  candidatesReady: boolean;
  selectedCandidateCount: number;
  adaptedMusicAuthorized: boolean;
  savingSelection: boolean;
  renderingSelected: boolean;
}): boolean {
  return (
    !input.candidatesReady ||
    input.selectedCandidateCount === 0 ||
    !input.adaptedMusicAuthorized ||
    input.savingSelection ||
    input.renderingSelected
  );
}

export function isShortsSelectionSaveDisabled(input: {
  candidatesReady: boolean;
  selectedCandidateCount: number;
  savingSelection: boolean;
  renderingSelected: boolean;
}): boolean {
  return (
    !input.candidatesReady ||
    input.selectedCandidateCount === 0 ||
    input.savingSelection ||
    input.renderingSelected
  );
}

function safeApiError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const candidate = value.error;
  if (
    typeof candidate === "string" &&
    /^[a-z0-9_.-]{1,80}$/iu.test(candidate)
  ) {
    return candidate;
  }
  return fallback;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function isTerminalProjectStatus(status: ProjectStatus): boolean {
  return status === "ready" || status === "failed";
}

function newIdempotencyKey(): string | null {
  if (typeof globalThis.crypto?.randomUUID !== "function") return null;
  return globalThis.crypto.randomUUID();
}

function selectedCandidateIdsForProject(
  selectedCandidateIds: ReadonlySet<string>,
  project: ShortsProject | null,
): string[] {
  if (!project) return [];
  return project.candidates
    .filter((candidate) => selectedCandidateIds.has(candidate.id))
    .map((candidate) => candidate.id);
}

export function ShortsStudio({
  locale,
  episodes,
  providerCapabilities,
  sourceLoadError = false,
  initialProject,
  initialSelectedEpisodeId,
}: ShortsStudioProps) {
  const copy = locale.startsWith("fr") ? COPY.fr : COPY.en;
  const [selectedEpisodeId, setSelectedEpisodeId] = useState(
    initialSelectedEpisodeId ?? "",
  );
  const [uploadedEpisodes, setUploadedEpisodes] = useState<
    ShortsStudioEpisode[]
  >([]);
  const [durationInput, setDurationInput] = useState(() => {
    const initialEpisode = episodes.find(
      (episode) => episode.id === initialSelectedEpisodeId,
    );
    return initialEpisode?.durationSeconds
      ? String(Math.round(initialEpisode.durationSeconds))
      : "";
  });
  const [sourceUploadState, setSourceUploadState] =
    useState<ShortsSourceUploadState>({ status: "idle" });
  const [canResumeSourceUpload, setCanResumeSourceUpload] = useState(false);
  const hasPendingSourceUpload = useSyncExternalStore(
    subscribeToPendingSourceUploads,
    getHasPendingSourceUploadSnapshot,
    getServerPendingSourceUploadSnapshot,
  );
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("audio");
  const [instructions, setInstructions] = useState("");
  const [jevShadowConsent, setJevShadowConsent] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<ShortsProject | null>(
    initialProject ?? null,
  );
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(
    () =>
      new Set(
        initialProject?.candidates
          .filter((candidate) => candidate.selected)
          .map((candidate) => candidate.id) ?? [],
      ),
  );
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(
    null,
  );
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>("viral");
  const [motionTemplate, setMotionTemplate] =
    useState<MotionTemplate>("editorial-focus");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [elevenLabsEnabled, setElevenLabsEnabled] = useState(
    providerCapabilities.elevenLabs,
  );
  const [elevenLabsConsent, setElevenLabsConsent] = useState(false);
  const [commercialLicenseConfirmed, setCommercialLicenseConfirmed] =
    useState(false);
  const [creativeDirectionEnabled, setCreativeDirectionEnabled] =
    useState(false);
  const adaptedMusicAuthorized =
    providerCapabilities.elevenLabs &&
    elevenLabsEnabled &&
    elevenLabsConsent &&
    commercialLicenseConfirmed;
  const [savingSelection, setSavingSelection] = useState(false);
  const [renderingSelected, setRenderingSelected] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  const sourceFileInputRef = useRef<HTMLInputElement>(null);
  const activeSourceUploadRef = useRef<ActiveShortsSourceUpload | null>(null);

  const availableEpisodes = useMemo(() => {
    const existingIds = new Set(episodes.map((episode) => episode.id));
    return [
      ...uploadedEpisodes.filter((episode) => !existingIds.has(episode.id)),
      ...episodes,
    ];
  }, [episodes, uploadedEpisodes]);

  const selectedEpisode = useMemo(
    () =>
      availableEpisodes.find((episode) => episode.id === selectedEpisodeId) ??
      null,
    [availableEpisodes, selectedEpisodeId],
  );
  const durationSeconds = Number(durationInput);
  const validDuration = isValidShortsSourceDuration(durationSeconds);
  const selectedCandidateIdsForCurrentProject = useMemo(
    () => selectedCandidateIdsForProject(selectedCandidateIds, project),
    [project, selectedCandidateIds],
  );

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/shorts/projects/${encodeURIComponent(projectId)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const payload = await readJsonSafely(response);
        const nextProject = response.ok
          ? normaliseShortsProject(payload)
          : null;
        if (!nextProject || nextProject.id !== projectId) {
          if (!cancelled) setPollingError(copy.projectError);
        } else if (!cancelled) {
          setProject(nextProject);
          setPollingError(null);
          if (isTerminalProjectStatus(nextProject.status)) {
            idempotencyRef.current = releaseShortsProjectIdempotencyIntent(
              idempotencyRef.current,
              nextProject.status,
            );
          }
          setSelectedCandidateIds((current) => {
            const knownIds = new Set(
              nextProject.candidates.map((candidate) => candidate.id),
            );
            const next = new Set(
              [...current].filter((candidateId) => knownIds.has(candidateId)),
            );
            if (next.size === current.size) return current;
            return next;
          });
          if (isTerminalProjectStatus(nextProject.status)) return;
        }
      } catch (error) {
        if (
          !cancelled &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setPollingError(copy.projectError);
        }
      }
      if (!cancelled) timeout = setTimeout(refresh, POLLING_INTERVAL_MS);
    };

    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [copy.projectError, projectId]);

  const completeSourceUpload = useCallback(
    async (active: ActiveShortsSourceUpload) => {
      active.phase = "complete";
      setSourceUploadState({
        status: "uploading",
        filename: active.filename,
        progress: 100,
        verifying: true,
      });
      const response = await fetch(
        `/api/shorts/uploads/${encodeURIComponent(active.episodeId)}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ size_bytes: active.sizeBytes }),
        },
      );
      const payload = await readJsonSafely(response);
      if (!response.ok) {
        throw new Error(safeApiError(payload, "upload_complete_failed"));
      }

      const durationSeconds = await active.durationPromise;
      const uploadedEpisode: ShortsStudioEpisode = {
        id: active.episodeId,
        title: active.title,
        sourceType: "upload",
        durationSeconds,
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      setUploadedEpisodes((current) => [
        uploadedEpisode,
        ...current.filter((episode) => episode.id !== uploadedEpisode.id),
      ]);
      setSelectedEpisodeId(uploadedEpisode.id);
      setDurationInput(durationSeconds === null ? "" : String(durationSeconds));
      const pendingUploads = removePendingShortsSourceUpload(
        readBrowserPendingSourceUploads(),
        active.episodeId,
      );
      writeBrowserPendingSourceUploads(pendingUploads);
      activeSourceUploadRef.current = null;
      setCanResumeSourceUpload(false);
      setSourceUploadState({
        status: "done",
        filename: active.filename,
      });
    },
    [],
  );

  const transferSourceUpload = useCallback(
    (active: ActiveShortsSourceUpload) =>
      new Promise<void>((resolve, reject) => {
        active.callbacks = {
          resolve: () => {
            active.callbacks = null;
            resolve();
          },
          reject: (error) => {
            active.callbacks = null;
            reject(error);
          },
        };
        active.upload.start();
      }),
    [],
  );

  const runSourceUpload = useCallback(
    async (active: ActiveShortsSourceUpload) => {
      try {
        if (active.phase === "transfer") {
          await transferSourceUpload(active);
        }
        await completeSourceUpload(active);
      } catch {
        setSourceUploadState({
          status: "error",
          filename: active.filename,
          message: copy.uploadError,
        });
      }
    },
    [completeSourceUpload, copy.uploadError, transferSourceUpload],
  );

  const onSourceFileSelected = useCallback(
    async (file: File) => {
      if (activeSourceUploadRef.current) return;
      const mime = resolveShortsSourceMime(file.type, file.name);
      if (!mime) {
        setSourceUploadState({
          status: "error",
          filename: file.name,
          message: copy.uploadUnsupported,
        });
        return;
      }
      if (file.size < 1 || file.size > SHORTS_SOURCE_MAX_BYTES) {
        setSourceUploadState({
          status: "error",
          filename: file.name,
          message: copy.uploadTooLarge,
        });
        return;
      }
      if (file.name.trim().length > 180) {
        setSourceUploadState({
          status: "error",
          filename: file.name,
          message: copy.uploadError,
        });
        return;
      }

      setSourceUploadState({
        status: "uploading",
        filename: file.name,
        progress: 0,
        verifying: false,
      });
      const durationPromise = readShortsSourceDuration(file, mime);
      let pendingUploads = readBrowserPendingSourceUploads();
      const interruptedUpload = findMatchingPendingShortsSourceUpload(
        pendingUploads,
        file,
      );
      try {
        const browserSupabase = createBrowserSupabaseClient();
        const {
          data: { session },
        } = await browserSupabase.auth.getSession();
        if (!session?.access_token) throw new Error("upload_session_missing");

        let title = titleFromSourceFilename(file.name);
        let uploadInit: NonNullable<
          ReturnType<typeof parseShortsUploadInit>
        > | null = null;
        let resumedFromPendingEpisode = false;
        if (interruptedUpload) {
          const resumeResponse = await fetch(
            `/api/shorts/uploads/${encodeURIComponent(interruptedUpload.episodeId)}/resume`,
            { method: "POST", cache: "no-store" },
          );
          if (resumeResponse.ok) {
            const resumePayload = await readJsonSafely(resumeResponse);
            const resumed = parseShortsUploadResume(
              resumePayload,
              interruptedUpload.episodeId,
            );
            if (!resumed) throw new Error("upload_resume_invalid");
            title = interruptedUpload.title;
            if (resumed.status === "ready") {
              const durationSeconds = await durationPromise;
              const uploadedEpisode: ShortsStudioEpisode = {
                id: interruptedUpload.episodeId,
                title,
                sourceType: "upload",
                durationSeconds,
                status: "ready",
                createdAt: new Date().toISOString(),
              };
              setUploadedEpisodes((current) => [
                uploadedEpisode,
                ...current.filter(
                  (episode) => episode.id !== uploadedEpisode.id,
                ),
              ]);
              setSelectedEpisodeId(uploadedEpisode.id);
              setDurationInput(
                durationSeconds === null ? "" : String(durationSeconds),
              );
              const remainingUploads = removePendingShortsSourceUpload(
                pendingUploads,
                uploadedEpisode.id,
              );
              writeBrowserPendingSourceUploads(remainingUploads);
              setCanResumeSourceUpload(false);
              setSourceUploadState({ status: "done", filename: file.name });
              return;
            }
            uploadInit = resumed.upload;
            resumedFromPendingEpisode = true;
          } else if (
            resumeResponse.status === 404 ||
            resumeResponse.status === 409
          ) {
            const remainingUploads = removePendingShortsSourceUpload(
              pendingUploads,
              interruptedUpload.episodeId,
            );
            writeBrowserPendingSourceUploads(remainingUploads);
            pendingUploads = remainingUploads;
          } else {
            const resumePayload = await readJsonSafely(resumeResponse);
            throw new Error(
              safeApiError(resumePayload, "upload_resume_failed"),
            );
          }
        }

        if (!uploadInit) {
          const initResponse = await fetch("/api/shorts/uploads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file_name: file.name,
              mime,
              size_bytes: file.size,
              title,
            }),
          });
          const initPayload = await readJsonSafely(initResponse);
          if (!initResponse.ok) {
            const errorCode = safeApiError(initPayload, "");
            setSourceUploadState({
              status: "error",
              filename: file.name,
              message:
                errorCode === "source_too_large"
                  ? copy.uploadTooLarge
                  : copy.uploadError,
            });
            return;
          }

          uploadInit = parseShortsUploadInit(initPayload);
          if (!uploadInit) throw new Error("upload_init_invalid");
        }

        const pendingRecord: PendingShortsSourceUpload = {
          episodeId: uploadInit.episodeId,
          filename: file.name,
          fileSizeBytes: file.size,
          lastModifiedMs: file.lastModified,
          title,
          savedAtMs:
            resumedFromPendingEpisode && interruptedUpload
              ? interruptedUpload.savedAtMs
              : Date.now(),
        };
        const activePendingUploads = [
          ...pendingUploads.filter(
            (pending) => pending.episodeId !== pendingRecord.episodeId,
          ),
          pendingRecord,
        ];
        writeBrowserPendingSourceUploads(activePendingUploads);

        const fingerprint = uploadInit.episodeId;
        const upload = new Upload(file, {
          ...buildShortsTusOptions({
            endpoint: uploadInit.endpoint,
            bucket: "clip-sources",
            storagePath: uploadInit.storagePath,
            contentType: mime,
            uploadToken: uploadInit.uploadToken,
            accessToken: session.access_token,
            apiKey:
              process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
              "public-anon-key-placeholder",
            fingerprint,
          }),
          onProgress: (bytesSent, bytesTotal) => {
            const progress =
              bytesTotal > 0
                ? Math.max(
                    0,
                    Math.min(100, Math.round((bytesSent / bytesTotal) * 100)),
                  )
                : 0;
            setSourceUploadState({
              status: "uploading",
              filename: file.name,
              progress,
              verifying: false,
            });
          },
          onError: (error) => {
            const active = activeSourceUploadRef.current;
            if (active?.callbacks) active.callbacks.reject(error);
          },
          onSuccess: () => {
            const active = activeSourceUploadRef.current;
            if (active?.callbacks) active.callbacks.resolve();
          },
        });
        const previousUploads = await upload.findPreviousUploads();
        const previousUpload = previousUploads.find(
          (previous) =>
            previous.size === file.size &&
            previous.metadata.bucketName === "clip-sources" &&
            previous.metadata.objectName === uploadInit.storagePath &&
            typeof previous.uploadUrl === "string" &&
            previous.uploadUrl.length > 0,
        );
        if (previousUpload) {
          upload.resumeFromPreviousUpload(previousUpload);
        } else if (resumedFromPendingEpisode) {
          const refreshedPendingRecord = {
            ...pendingRecord,
            savedAtMs: Date.now(),
          };
          writeBrowserPendingSourceUploads([
            ...pendingUploads.filter(
              (pending) =>
                pending.episodeId !== refreshedPendingRecord.episodeId,
            ),
            refreshedPendingRecord,
          ]);
        }
        const active: ActiveShortsSourceUpload = {
          upload,
          episodeId: uploadInit.episodeId,
          filename: file.name,
          title,
          sizeBytes: file.size,
          durationPromise,
          phase: "transfer",
          callbacks: null,
        };
        activeSourceUploadRef.current = active;
        setCanResumeSourceUpload(true);
        await runSourceUpload(active);
      } catch {
        setSourceUploadState({
          status: "error",
          filename: file.name,
          message: copy.uploadError,
        });
      }
    },
    [
      copy.uploadError,
      copy.uploadTooLarge,
      copy.uploadUnsupported,
      runSourceUpload,
    ],
  );

  const retrySourceUpload = useCallback(() => {
    const active = activeSourceUploadRef.current;
    if (active) void runSourceUpload(active);
  }, [runSourceUpload]);

  const onEpisodeChange = useCallback(
    (episodeId: string) => {
      setSelectedEpisodeId(episodeId);
      const episode = availableEpisodes.find((item) => item.id === episodeId);
      if (episode?.durationSeconds) {
        setDurationInput(String(Math.round(episode.durationSeconds)));
      } else setDurationInput("");
    },
    [availableEpisodes],
  );

  const onCreateProject = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreateError(null);
      setSaveError(null);
      setSaveSuccess(null);
      if (!selectedEpisodeId) {
        setCreateError(copy.noEpisode);
        return;
      }
      if (!validDuration) {
        setCreateError(copy.durationInvalid);
        return;
      }

      const intent = {
        episode_id: selectedEpisodeId,
        analysis_mode: analysisMode,
        duration_seconds: durationSeconds,
        instructions: instructions.trim().slice(0, 1_200),
        jev_shadow_consent: jevShadowConsent,
      };
      const fingerprint = JSON.stringify(intent);
      const idempotencyIntent = resolveShortsProjectIdempotencyIntent(
        idempotencyRef.current,
        fingerprint,
        newIdempotencyKey,
      );
      if (!idempotencyIntent) {
        setCreateError(copy.genericError);
        return;
      }
      idempotencyRef.current = idempotencyIntent;

      setCreatingProject(true);
      try {
        const response = await fetch("/api/shorts/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...intent,
            idempotency_key: idempotencyIntent.key,
          }),
        });
        const payload = await readJsonSafely(response);
        const data =
          isRecord(payload) && isRecord(payload.data) ? payload.data : null;
        const nextProjectId = data ? shortText(data.project_id, 100) : "";
        const nextStatus = data?.status;
        if (!response.ok || !nextProjectId || !isProjectStatus(nextStatus)) {
          const errorCode = safeApiError(payload, "");
          setCreateError(
            isShortsAnalysisUnavailable(response.status, errorCode)
              ? copy.analysisUnavailable
              : errorCode === "audio_video_requires_video_source"
                ? copy.audioVideoSourceRequired
                : errorCode === "analysis_quota_exceeded"
                  ? copy.analysisQuotaExceeded
                  : copy.projectError,
          );
          return;
        }
        setProjectId(nextProjectId);
        setProject({
          id: nextProjectId,
          status: nextStatus,
          analysisQuotaExceeded: false,
          candidates: [],
        });
        idempotencyRef.current = releaseShortsProjectIdempotencyIntent(
          idempotencyRef.current,
          nextStatus,
        );
        setSelectedCandidateIds(new Set());
        setActiveCandidateId(null);
        setCreativeDirectionEnabled(false);
      } catch {
        setCreateError(copy.projectError);
      } finally {
        setCreatingProject(false);
      }
    },
    [
      analysisMode,
      copy.audioVideoSourceRequired,
      copy.analysisUnavailable,
      copy.analysisQuotaExceeded,
      copy.durationInvalid,
      copy.genericError,
      copy.noEpisode,
      copy.projectError,
      durationSeconds,
      instructions,
      jevShadowConsent,
      selectedEpisodeId,
      validDuration,
    ],
  );

  const toggleCandidate = useCallback((candidateId: string) => {
    setSaveError(null);
    setSaveSuccess(null);
    setActiveCandidateId(candidateId);
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }, []);

  const onSaveSelection = useCallback(async () => {
    const currentProject = project;
    const currentSelectedCandidateIds = selectedCandidateIdsForProject(
      selectedCandidateIds,
      currentProject,
    );
    if (!currentProject || currentSelectedCandidateIds.length === 0) return;

    setSavingSelection(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const response = await fetch(
        `/api/shorts/projects/${encodeURIComponent(currentProject.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selected_candidate_ids: currentSelectedCandidateIds,
            production_profile: buildProductionProfile({
              aspectRatio,
              subtitleStyle,
              motionTemplate,
              reducedMotion,
              elevenLabsEnabled,
              elevenLabsAvailable: providerCapabilities.elevenLabs,
              elevenLabsConsent,
              commercialLicenseConfirmed,
              creativeDirectionEnabled,
              creativeDirectionAvailable:
                providerCapabilities.creativeDirection,
              creativeDirectionConsent: creativeDirectionEnabled,
            }),
          }),
        },
      );
      const payload = await readJsonSafely(response);
      const data =
        isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      const selectedCount = data ? finiteNumber(data.selected_count) : null;
      if (!response.ok || selectedCount === null || selectedCount < 0) {
        setSaveError(safeApiError(payload, copy.saveError));
        return;
      }
      setSaveSuccess(copy.selectionSaved(Math.round(selectedCount)));
    } catch {
      setSaveError(copy.saveError);
    } finally {
      setSavingSelection(false);
    }
  }, [
    aspectRatio,
    commercialLicenseConfirmed,
    creativeDirectionEnabled,
    providerCapabilities.creativeDirection,
    providerCapabilities.elevenLabs,
    copy,
    elevenLabsConsent,
    elevenLabsEnabled,
    motionTemplate,
    project,
    reducedMotion,
    selectedCandidateIds,
    subtitleStyle,
  ]);

  const onGenerateSelected = useCallback(async () => {
    const currentProject = project;
    const currentSelectedCandidateIds = selectedCandidateIdsForProject(
      selectedCandidateIds,
      currentProject,
    );
    if (!currentProject || currentSelectedCandidateIds.length === 0) return;
    if (!adaptedMusicAuthorized) {
      setSaveError(copy.adaptedMusicRequired);
      return;
    }

    setRenderingSelected(true);
    setRenderStatus(null);
    setSaveError(null);
    const productionProfile = buildProductionProfile({
      aspectRatio,
      subtitleStyle,
      motionTemplate,
      reducedMotion,
      elevenLabsEnabled,
      elevenLabsAvailable: providerCapabilities.elevenLabs,
      elevenLabsConsent,
      commercialLicenseConfirmed,
      creativeDirectionEnabled,
      creativeDirectionAvailable: providerCapabilities.creativeDirection,
      creativeDirectionConsent: creativeDirectionEnabled,
    });
    try {
      const saveResponse = await fetch(
        `/api/shorts/projects/${encodeURIComponent(currentProject.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selected_candidate_ids: currentSelectedCandidateIds,
            production_profile: productionProfile,
          }),
        },
      );
      const savePayload = await readJsonSafely(saveResponse);
      if (!saveResponse.ok) {
        setSaveError(safeApiError(savePayload, copy.saveError));
        return;
      }

      const renderResponse = await fetch(
        `/api/shorts/projects/${encodeURIComponent(currentProject.id)}/render`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidate_ids: currentSelectedCandidateIds,
          }),
        },
      );
      const renderPayload = await readJsonSafely(renderResponse);
      const data =
        isRecord(renderPayload) && isRecord(renderPayload.data)
          ? renderPayload.data
          : null;
      const queuedCount = data ? finiteNumber(data.queued_count) : null;
      if (!renderResponse.ok || queuedCount === null) {
        const errorCode = safeApiError(renderPayload, "");
        setSaveError(
          errorCode === "adapted_music_required"
            ? copy.adaptedMusicRequired
            : errorCode || copy.genericError,
        );
        return;
      }
      setRenderStatus(
        copy.renderQueuedMessage(
          Math.max(
            0,
            Math.min(currentSelectedCandidateIds.length, queuedCount),
          ),
          currentSelectedCandidateIds.length,
        ),
      );
    } catch {
      setSaveError(copy.genericError);
    } finally {
      setRenderingSelected(false);
    }
  }, [
    adaptedMusicAuthorized,
    aspectRatio,
    commercialLicenseConfirmed,
    creativeDirectionEnabled,
    providerCapabilities.creativeDirection,
    providerCapabilities.elevenLabs,
    copy,
    elevenLabsConsent,
    elevenLabsEnabled,
    motionTemplate,
    project,
    reducedMotion,
    selectedCandidateIds,
    subtitleStyle,
  ]);

  const projectStatusText = project
    ? project.analysisQuotaExceeded
      ? copy.analysisQuotaExceeded
      : copy[project.status]
    : null;
  const showCandidateControls =
    project?.status === "ready" && project.candidates.length > 0;

  const studio = locale.startsWith("fr")
    ? {
        reviewReady: "Prêt à revue",
        newProject: "Nouveau projet",
        source: "Source",
        analysis: "Analyse",
        selection: "Sélection",
        production: "Production",
        publication: "Publication",
        library: "Bibliothèque",
        templates: "Modèles",
        settings: "Paramètres",
        all: "Tous",
        keyIdeas: "Idées clés",
        strongMoments: "Moments forts",
        questions: "Questions",
        reels: "Rires",
        sort: "Trier par : Score",
        reviewAnalysis: "Analyse IA terminée",
        reviewAnalysisPending: "Analyse IA en cours",
        analysisSummary: (count: number) =>
          `${count} moment${count > 1 ? "s" : ""} pertinent${count > 1 ? "s" : ""} trouvé${count > 1 ? "s" : ""} dans votre vidéo.`,
        relaunch: "Relancer l’analyse",
        startAProject: "Importez une source pour commencer",
        startAProjectCopy:
          "Votre transcription, les propositions d’extraits et l’aperçu de production apparaîtront ici.",
        sourcePanel: "Préparer une nouvelle analyse",
        sourcePanelCopy:
          "Choisissez un épisode ou importez une vidéo ou un podcast de 20 minutes à 2 heures.",
        mediaWaiting:
          "Les aperçus vidéo utilisent votre média après l’analyse.",
        currentExcerpt: "Extrait à",
        listen: "Lire l’extrait complet",
        transcriptTab: "Transcription",
        timelineTab: "Timeline",
        previewTitle: "Aperçu du Short (9:16)",
        previewWaiting:
          "L’aperçu réel utilisera le cadrage de votre source au rendu.",
        subtitleOption: "Sous-titres synchronisés",
        subtitleDetail: "Générés et optimisés par l’IA",
        motionOption: "Motion",
        motionDetail: "Recadrages automatiques et zooms",
        musicOption: "Musique adaptée",
        musicDetail: "Instrumentale, sous la voix",
        youtubeDetail: "Confirmation requise après rendu",
        privateLabel: "Privé",
        reducedMotion: "Mouvement réduit",
        productionOptions: "Options de production",
        reset: "Réinitialiser",
        directionOptions: "Direction créative et droits",
        renderGallery: "Voir les rendus dans la galerie",
      }
    : {
        reviewReady: "Ready to review",
        newProject: "New project",
        source: "Source",
        analysis: "Analysis",
        selection: "Selection",
        production: "Production",
        publication: "Publishing",
        library: "Library",
        templates: "Templates",
        settings: "Settings",
        all: "All",
        keyIdeas: "Key ideas",
        strongMoments: "Strong moments",
        questions: "Questions",
        reels: "Humor",
        sort: "Sort by: Score",
        reviewAnalysis: "AI analysis complete",
        reviewAnalysisPending: "AI analysis in progress",
        analysisSummary: (count: number) =>
          `${count} relevant moment${count === 1 ? "" : "s"} found in your source.`,
        relaunch: "Run analysis again",
        startAProject: "Import a source to begin",
        startAProjectCopy:
          "Your transcript, suggested clips, and production preview will appear here.",
        sourcePanel: "Prepare a new analysis",
        sourcePanelCopy:
          "Choose an episode or upload a 20-minute to two-hour video or podcast.",
        mediaWaiting: "Video previews use your media after analysis.",
        currentExcerpt: "Excerpt at",
        listen: "Play full excerpt",
        transcriptTab: "Transcript",
        timelineTab: "Timeline",
        previewTitle: "Short preview (9:16)",
        previewWaiting:
          "The real preview will use your source framing at render time.",
        subtitleOption: "Synchronized subtitles",
        subtitleDetail: "Generated and optimized by AI",
        motionOption: "Motion",
        motionDetail: "Automatic crops and zooms",
        musicOption: "Adapted music",
        musicDetail: "Instrumental under speech",
        youtubeDetail: "Confirmation required after rendering",
        privateLabel: "Private",
        reducedMotion: "Reduced motion",
        productionOptions: "Production options",
        reset: "Reset",
        directionOptions: "Creative direction and rights",
        renderGallery: "View renders in the gallery",
      };
  const activeCandidate =
    project?.candidates.find(
      (candidate) => candidate.id === activeCandidateId,
    ) ??
    project?.candidates[0] ??
    null;
  const activeCandidateDuration = activeCandidate
    ? formatShortsTimestamp(
        Math.max(0, activeCandidate.endSeconds - activeCandidate.startSeconds),
      )
    : null;
  const transcriptLines = useMemo(() => {
    const excerpt =
      activeCandidate?.transcriptExcerpt.trim() ||
      activeCandidate?.hook.trim() ||
      "";
    if (!excerpt) return [];
    const sentences = excerpt
      .split(/(?<=[.!?])\s+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    return (sentences.length > 0 ? sentences : [excerpt]).slice(0, 5);
  }, [activeCandidate]);
  const sourceTitle = selectedEpisode?.title || copy.sourcePlaceholder;
  const sourceDuration = selectedEpisode?.durationSeconds
    ? formatShortsTimestamp(selectedEpisode.durationSeconds)
    : validDuration
      ? formatShortsTimestamp(durationSeconds)
      : copy.unavailableDuration;
  const candidateCount = project?.candidates.length ?? 0;
  const candidatePage = resolveShortsCandidatePage(
    candidateCount,
    project?.candidates.findIndex(
      (candidate) => candidate.id === activeCandidate?.id,
    ) ?? 0,
  );
  const projectIsReady = project?.status === "ready";

  const onStartNewProject = useCallback(() => {
    setProjectId(null);
    setProject(null);
    setSelectedCandidateIds(new Set());
    setActiveCandidateId(null);
    setCreateError(null);
    setPollingError(null);
    setSaveError(null);
    setSaveSuccess(null);
    setRenderStatus(null);
    setCreativeDirectionEnabled(false);
  }, []);

  return (
    <div className={styles.studio}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <a href={`/${encodeURIComponent(locale)}`} className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              <Clapperboard size={16} strokeWidth={2.3} />
            </span>
            <span>ClipsFlow</span>
          </a>

          <div className={styles.workspaceSelect} title={sourceTitle}>
            <span className={styles.workspacePoster} aria-hidden="true">
              <Video size={16} />
            </span>
            <span className={styles.workspaceLabel}>{sourceTitle}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </div>

          <div className={styles.topbarActions}>
            <span className={styles.reviewStatus}>
              <span className={styles.statusDot} aria-hidden="true" />
              {studio.reviewReady}
            </span>
            <div className={styles.avatars} aria-label="Équipe ClipsFlow">
              <span className={styles.avatar}>LR</span>
              <span className={styles.avatar}>CM</span>
            </div>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Messages"
            >
              <MessageSquare size={16} />
            </button>
            <button
              type="button"
              className={styles.newProjectButton}
              onClick={onStartNewProject}
              disabled={creatingProject || renderingSelected}
            >
              <Plus size={16} aria-hidden="true" />
              {studio.newProject}
            </button>
          </div>
        </header>

        <div className={styles.workbench}>
          <aside
            className={styles.sidebar}
            aria-label="Étapes du Studio Shorts"
          >
            <div className={styles.sourceVisual} aria-hidden="true">
              <div className={styles.sourceVisualInner}>
                <Video size={24} strokeWidth={1.5} />
                <span>{studio.mediaWaiting}</span>
              </div>
            </div>
            <p className={styles.sourceTitle}>{sourceTitle}</p>
            <div className={styles.sourceMeta}>
              <span className={styles.sourceMetaItem}>
                <Clock3 size={14} aria-hidden="true" />
                {sourceDuration}
              </span>
              <span className={styles.sourceMetaItem}>
                <FileAudio size={14} aria-hidden="true" />
                {analysisMode === "audio_video"
                  ? copy.audioVideoTitle
                  : copy.audioTitle}
              </span>
              <span className={styles.sourceMetaItem}>
                <Video size={14} aria-hidden="true" />
                {selectedEpisode?.sourceType || copy.sourceLabel}
              </span>
            </div>

            <ol className={styles.stepList}>
              <li
                className={cn(
                  styles.step,
                  selectedEpisodeId && styles.stepComplete,
                  !project && styles.stepActive,
                )}
              >
                <span className={styles.stepMarker} aria-hidden="true">
                  {selectedEpisodeId ? <Check size={14} /> : "01"}
                </span>
                <span className={styles.stepContent}>
                  <span className={styles.stepIndex}>01</span>
                  <span className={styles.stepTitle}>{studio.source}</span>
                </span>
              </li>
              <li
                className={cn(
                  styles.step,
                  projectIsReady && styles.stepComplete,
                  project && !projectIsReady && styles.stepActive,
                )}
              >
                <span className={styles.stepMarker} aria-hidden="true">
                  {projectIsReady ? <Check size={14} /> : "02"}
                </span>
                <span className={styles.stepContent}>
                  <span className={styles.stepIndex}>02</span>
                  <span className={styles.stepTitle}>{studio.analysis}</span>
                </span>
              </li>
              <li
                className={cn(styles.step, projectIsReady && styles.stepActive)}
              >
                <span className={styles.stepMarker} aria-hidden="true">
                  03
                </span>
                <span className={styles.stepContent}>
                  <span className={styles.stepIndex}>03</span>
                  <span className={styles.stepTitle}>{studio.selection}</span>
                  {candidateCount > 0 ? (
                    <span className={styles.stepDetail}>
                      {candidateCount}{" "}
                      {locale.startsWith("fr")
                        ? "moments trouvés"
                        : "moments found"}
                    </span>
                  ) : null}
                </span>
              </li>
              <li className={styles.step}>
                <span className={styles.stepMarker} aria-hidden="true">
                  04
                </span>
                <span className={styles.stepContent}>
                  <span className={styles.stepIndex}>04</span>
                  <span className={styles.stepTitle}>{studio.production}</span>
                </span>
              </li>
              <li className={styles.step}>
                <span className={styles.stepMarker} aria-hidden="true">
                  05
                </span>
                <span className={styles.stepContent}>
                  <span className={styles.stepIndex}>05</span>
                  <span className={styles.stepTitle}>{studio.publication}</span>
                </span>
              </li>
            </ol>

            <nav
              className={styles.sidebarFooter}
              aria-label="Navigation secondaire"
            >
              <a
                className={styles.footerLink}
                href={`/${encodeURIComponent(locale)}/clips`}
              >
                <Library size={17} aria-hidden="true" />
                {studio.library}
              </a>
              <a
                className={styles.footerLink}
                href={`/${encodeURIComponent(locale)}/clips/new`}
              >
                <FolderOpen size={17} aria-hidden="true" />
                {studio.templates}
              </a>
              <a
                className={styles.footerLink}
                href={`/${encodeURIComponent(locale)}/pricing`}
              >
                <Settings2 size={17} aria-hidden="true" />
                {studio.settings}
              </a>
            </nav>
          </aside>

          <main className={styles.main}>
            <div className={styles.content}>
              <section className={styles.studioHeader}>
                <div>
                  <p className={styles.eyebrow}>{copy.eyebrow}</p>
                  <h1 className={styles.headline}>
                    {candidateCount || "—"}{" "}
                    <span className={styles.headlineAccent}>
                      {locale.startsWith("fr")
                        ? "moments trouvés"
                        : "moments found"}
                    </span>
                  </h1>
                  <p className={styles.headlineDescription}>
                    {projectIsReady
                      ? copy.candidatesDescription
                      : copy.description}
                  </p>
                </div>
                <div className={styles.analysisComplete} aria-live="polite">
                  <span
                    className={styles.analysisCompleteIcon}
                    aria-hidden="true"
                  >
                    {projectIsReady ? (
                      <CircleCheck size={19} />
                    ) : (
                      <Sparkles size={17} />
                    )}
                  </span>
                  <div>
                    <span className={styles.analysisCompleteTitle}>
                      {projectIsReady
                        ? studio.reviewAnalysis
                        : studio.reviewAnalysisPending}
                    </span>
                    <p className={styles.analysisCompleteCopy}>
                      {projectIsReady
                        ? studio.analysisSummary(candidateCount)
                        : projectStatusText || copy.sourceDescription}
                    </p>
                    {project ? (
                      <button
                        type="button"
                        className={styles.refreshButton}
                        onClick={onStartNewProject}
                        disabled={renderingSelected}
                      >
                        <Sparkles size={12} aria-hidden="true" />
                        {studio.relaunch}
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>

              {projectIsReady && activeCandidate ? (
                <>
                  <div
                    className={styles.filterRow}
                    aria-label="Repères des extraits"
                  >
                    <span
                      className={cn(styles.filterPill, styles.filterPillActive)}
                    >
                      <span className={styles.filterDot} aria-hidden="true" />
                      {studio.all} ({candidateCount})
                    </span>
                    <span className={styles.filterPill}>
                      <span className={styles.filterDot} aria-hidden="true" />
                      {studio.keyIdeas}
                    </span>
                    <span className={styles.filterPill}>
                      <span className={styles.filterDot} aria-hidden="true" />
                      {studio.strongMoments}
                    </span>
                    <span className={styles.filterPill}>
                      <span className={styles.filterDot} aria-hidden="true" />
                      {studio.questions}
                    </span>
                    <span className={styles.filterPill}>
                      <span className={styles.filterDot} aria-hidden="true" />
                      {studio.reels}
                    </span>
                    <span className={styles.sortControl}>
                      {studio.sort}
                      <ChevronDown size={13} aria-hidden="true" />
                    </span>
                    {candidatePage.pageCount > 1 ? (
                      <nav
                        className={styles.candidatePager}
                        aria-label={
                          locale === "fr"
                            ? "Navigation des extraits"
                            : "Excerpt navigation"
                        }
                      >
                        <button
                          type="button"
                          className={styles.iconButton}
                          disabled={candidatePage.pageIndex === 0}
                          aria-label={
                            locale === "fr"
                              ? "Extraits précédents"
                              : "Previous excerpts"
                          }
                          onClick={() =>
                            setActiveCandidateId(
                              project.candidates[candidatePage.start - 3].id,
                            )
                          }
                        >
                          <ChevronLeft size={15} />
                        </button>
                        <span aria-live="polite">
                          {candidatePage.pageIndex + 1}/
                          {candidatePage.pageCount}
                        </span>
                        <button
                          type="button"
                          className={styles.iconButton}
                          disabled={
                            candidatePage.pageIndex + 1 ===
                            candidatePage.pageCount
                          }
                          aria-label={
                            locale === "fr"
                              ? "Extraits suivants"
                              : "Next excerpts"
                          }
                          onClick={() =>
                            setActiveCandidateId(
                              project.candidates[candidatePage.end].id,
                            )
                          }
                        >
                          <ChevronRight size={15} />
                        </button>
                      </nav>
                    ) : null}
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label="Rechercher dans les extraits"
                    >
                      <Search size={15} />
                    </button>
                  </div>

                  <section
                    className={styles.candidates}
                    aria-label={copy.candidatesTitle}
                  >
                    {project.candidates
                      .slice(candidatePage.start, candidatePage.end)
                      .map((candidate) => {
                        const checked = selectedCandidateIds.has(candidate.id);
                        const candidateDuration = formatShortsTimestamp(
                          Math.max(
                            0,
                            candidate.endSeconds - candidate.startSeconds,
                          ),
                        );
                        const isActive = candidate.id === activeCandidate.id;
                        return (
                          <article
                            key={candidate.id}
                            className={cn(
                              styles.candidate,
                              isActive && styles.candidateActive,
                            )}
                            tabIndex={0}
                            role="button"
                            aria-pressed={isActive}
                            onClick={() => setActiveCandidateId(candidate.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setActiveCandidateId(candidate.id);
                              }
                            }}
                          >
                            <div className={styles.candidateVisual}>
                              <span className={styles.mediaSignal}>
                                <Video
                                  size={20}
                                  strokeWidth={1.65}
                                  aria-hidden="true"
                                />
                                {candidate.visualSummary || studio.mediaWaiting}
                              </span>
                              <span className={styles.candidateScore}>
                                {candidate.score}
                              </span>
                              <span className={styles.candidateDuration}>
                                {candidateDuration}
                              </span>
                            </div>
                            <div className={styles.candidateMeta}>
                              <button
                                type="button"
                                className={styles.candidateSelect}
                                data-selected={checked}
                                aria-label={
                                  checked ? copy.selected : copy.selectCandidate
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleCandidate(candidate.id);
                                }}
                              >
                                {checked ? (
                                  <Check size={15} />
                                ) : (
                                  <Plus size={14} />
                                )}
                              </button>
                              <div>
                                <div className={styles.candidateTitle}>
                                  {candidate.title}
                                </div>
                                <p className={styles.candidateHook}>
                                  {candidate.hook}
                                </p>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                  </section>

                  <section
                    className={styles.selectedWorkspace}
                    aria-label={activeCandidate.title}
                  >
                    <div className={styles.selectionHeader}>
                      <div className={styles.selectionIdentity}>
                        <span className={styles.scoreBox}>
                          {activeCandidate.score}
                        </span>
                        <div>
                          <div className={styles.selectedTitle}>
                            {activeCandidate.title}
                          </div>
                          <p className={styles.selectedMeta}>
                            {studio.currentExcerpt}{" "}
                            {formatShortsTimestamp(
                              activeCandidate.startSeconds,
                            )}{" "}
                            {" · "}
                            {activeCandidateDuration}
                          </p>
                        </div>
                      </div>
                      <div className={styles.selectionActions}>
                        <button type="button" className={styles.listenButton}>
                          <Play
                            size={13}
                            fill="currentColor"
                            aria-hidden="true"
                          />
                          {studio.listen}
                        </button>
                        <button
                          type="button"
                          className={styles.overflowButton}
                          aria-label="Plus d’options"
                        >
                          <MoreHorizontal size={17} />
                        </button>
                      </div>
                    </div>

                    <div className={styles.transcriptTabs}>
                      <button
                        type="button"
                        className={cn(
                          styles.transcriptTab,
                          styles.transcriptTabActive,
                        )}
                      >
                        {studio.transcriptTab}
                      </button>
                      <button type="button" className={styles.transcriptTab}>
                        {studio.timelineTab}
                      </button>
                    </div>

                    <div className={styles.transcriptBody}>
                      <div className={styles.transcriptLines}>
                        {transcriptLines.map((line, index) => {
                          const timestamp = formatShortsTimestamp(
                            activeCandidate.startSeconds + index * 3,
                          );
                          const highlighted =
                            index === Math.min(2, transcriptLines.length - 1);
                          return (
                            <div
                              key={`${timestamp}-${line}`}
                              className={cn(
                                styles.transcriptLine,
                                highlighted && styles.transcriptHighlight,
                              )}
                            >
                              <span className={styles.transcriptTimestamp}>
                                {timestamp}
                              </span>
                              <span>{line}</span>
                            </div>
                          );
                        })}
                      </div>
                      <span
                        className={styles.scrollIndicator}
                        aria-hidden="true"
                      />
                    </div>

                    <div className={styles.waveformPanel}>
                      <div
                        className={styles.waveform}
                        aria-label="Aperçu temporel décoratif de l’extrait"
                      >
                        {WAVEFORM_BAR_HEIGHTS.map((height, index) => (
                          <span
                            key={`${height}-${index}`}
                            className={styles.waveBar}
                            style={{ height: `${height}%` }}
                            aria-hidden="true"
                          />
                        ))}
                        <span
                          className={styles.waveSelection}
                          aria-hidden="true"
                        >
                          <span className={styles.waveHandle} />
                          <span className={styles.waveHandle} />
                        </span>
                      </div>
                      <div className={styles.waveTimes} aria-hidden="true">
                        <span>
                          {formatShortsTimestamp(activeCandidate.startSeconds)}
                        </span>
                        <span>
                          {formatShortsTimestamp(
                            activeCandidate.startSeconds + 15,
                          )}
                        </span>
                        <span>
                          {formatShortsTimestamp(activeCandidate.endSeconds)}
                        </span>
                      </div>
                      <div className={styles.playback}>
                        <button
                          type="button"
                          className={styles.playCircle}
                          aria-label={studio.listen}
                        >
                          <Play size={17} fill="currentColor" />
                        </button>
                        <span className={styles.playTime}>
                          {formatShortsTimestamp(activeCandidate.startSeconds)}{" "}
                          <span>
                            /{" "}
                            {formatShortsTimestamp(activeCandidate.endSeconds)}
                          </span>
                        </span>
                        <span className={styles.scrubber} aria-hidden="true" />
                        <span
                          className={styles.zoomControls}
                          aria-hidden="true"
                        >
                          <button type="button" className={styles.zoomButton}>
                            −
                          </button>
                          <button type="button" className={styles.zoomButton}>
                            +
                          </button>
                        </span>
                      </div>
                    </div>
                  </section>
                </>
              ) : project && !projectIsReady ? (
                <section className={styles.emptyStage} aria-live="polite">
                  <div className={styles.emptyStageContent}>
                    <span className={styles.emptyStageIcon} aria-hidden="true">
                      <Sparkles size={24} />
                    </span>
                    <h2 className={styles.emptyStageTitle}>
                      {projectStatusText}
                    </h2>
                    <p className={styles.emptyStageCopy}>
                      {copy.awaitingCandidates}
                    </p>
                    {pollingError ? (
                      <p className={styles.alertError}>{pollingError}</p>
                    ) : null}
                  </div>
                </section>
              ) : projectIsReady ? (
                <section className={styles.emptyStage}>
                  <div className={styles.emptyStageContent}>
                    <span className={styles.emptyStageIcon} aria-hidden="true">
                      <Video size={24} />
                    </span>
                    <h2 className={styles.emptyStageTitle}>
                      {copy.noCandidates}
                    </h2>
                    <p className={styles.emptyStageCopy}>
                      {copy.candidatesDescription}
                    </p>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={onStartNewProject}
                    >
                      {studio.newProject}
                    </button>
                  </div>
                </section>
              ) : (
                <form
                  className={styles.intake}
                  onSubmit={onCreateProject}
                  noValidate
                >
                  <div className={styles.intakeHeader}>
                    <div>
                      <h2 className={styles.panelTitle}>
                        {studio.sourcePanel}
                      </h2>
                      <p className={styles.panelDescription}>
                        {studio.sourcePanelCopy}
                      </p>
                    </div>
                    <UploadCloud size={22} color="#a792ff" aria-hidden="true" />
                  </div>

                  <input
                    ref={sourceFileInputRef}
                    type="file"
                    accept={SHORTS_SOURCE_MIME_TYPES.join(",")}
                    className={styles.srOnly}
                    aria-label={copy.uploadLabel}
                    disabled={
                      creatingProject ||
                      sourceUploadState.status === "uploading" ||
                      (sourceUploadState.status === "error" &&
                        canResumeSourceUpload)
                    }
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void onSourceFileSelected(file);
                    }}
                  />

                  <div className={styles.intakeGrid}>
                    <div className={cn(styles.wideField, styles.uploadPanel)}>
                      <div className={styles.uploadCopy}>
                        <UploadCloud
                          size={23}
                          color="#a997ff"
                          aria-hidden="true"
                        />
                        <p>
                          <strong>{copy.uploadLabel}</strong>
                          <span>{copy.uploadHelp}</span>
                        </p>
                      </div>
                      <button
                        type="button"
                        className={styles.fileButton}
                        onClick={() => {
                          if (
                            sourceUploadState.status === "error" &&
                            canResumeSourceUpload
                          ) {
                            retrySourceUpload();
                            return;
                          }
                          sourceFileInputRef.current?.click();
                        }}
                        disabled={
                          creatingProject ||
                          sourceUploadState.status === "uploading"
                        }
                      >
                        <UploadCloud size={14} aria-hidden="true" />
                        {sourceUploadState.status === "error" &&
                        canResumeSourceUpload
                          ? copy.retryUpload
                          : copy.uploadButton}
                      </button>
                      {sourceUploadState.status === "uploading" ? (
                        <div
                          className={styles.uploadProgress}
                          role="status"
                          aria-live="polite"
                        >
                          {sourceUploadState.verifying
                            ? copy.uploadVerifying
                            : copy.uploadProgress(sourceUploadState.progress)}
                          <div className={styles.progressTrack}>
                            <div
                              className={styles.progressValue}
                              style={{
                                width: `${sourceUploadState.progress}%`,
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <label className={styles.field}>
                      {copy.sourceLabel}
                      <select
                        value={selectedEpisodeId}
                        onChange={(event) =>
                          onEpisodeChange(event.target.value)
                        }
                        className={styles.select}
                        aria-invalid={Boolean(
                          createError && !selectedEpisodeId,
                        )}
                        disabled={creatingProject}
                      >
                        <option value="">{copy.sourcePlaceholder}</option>
                        {availableEpisodes.map((episode) => (
                          <option key={episode.id} value={episode.id}>
                            {episode.title} ·{" "}
                            {episode.durationSeconds
                              ? formatShortsTimestamp(episode.durationSeconds)
                              : copy.unavailableDuration}
                          </option>
                        ))}
                      </select>
                      <span className={styles.fieldHelp}>
                        {sourceLoadError && availableEpisodes.length === 0
                          ? copy.sourceLoadError
                          : availableEpisodes.length === 0
                            ? copy.noEpisode
                            : sourceUploadState.status === "done"
                              ? `${copy.uploadReady} · ${sourceUploadState.filename}`
                              : hasPendingSourceUpload
                                ? copy.uploadResumeHint
                                : copy.sourceDescription}
                      </span>
                    </label>

                    <label className={styles.field}>
                      {copy.durationLabel}
                      <input
                        type="number"
                        min={SHORTS_MIN_SOURCE_DURATION_SECONDS}
                        max={SHORTS_MAX_SOURCE_DURATION_SECONDS}
                        step={60}
                        inputMode="numeric"
                        value={durationInput}
                        onChange={(event) =>
                          setDurationInput(event.target.value)
                        }
                        className={styles.input}
                        aria-invalid={Boolean(durationInput) && !validDuration}
                        disabled={creatingProject}
                      />
                      <span className={styles.fieldHelp}>
                        {copy.durationHint}
                      </span>
                    </label>

                    <fieldset className={styles.wideField}>
                      <legend>{copy.analysisLabel}</legend>
                      <div className={styles.modeChoices}>
                        {ANALYSIS_MODES.map((mode) => {
                          const checked = analysisMode === mode;
                          const isAudio = mode === "audio";
                          return (
                            <label
                              key={mode}
                              className={styles.modeChoice}
                              data-selected={checked}
                            >
                              <input
                                type="radio"
                                name="analysis-mode"
                                value={mode}
                                checked={checked}
                                onChange={() => setAnalysisMode(mode)}
                                disabled={creatingProject}
                              />
                              <span>
                                <strong>
                                  {isAudio
                                    ? copy.audioTitle
                                    : copy.audioVideoTitle}
                                </strong>
                                <span>
                                  {isAudio
                                    ? copy.audioDescription
                                    : copy.audioVideoDescription}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <label className={styles.wideField}>
                      {copy.instructionsLabel}
                      <textarea
                        value={instructions}
                        onChange={(event) =>
                          setInstructions(event.target.value.slice(0, 4_000))
                        }
                        placeholder={copy.instructionsPlaceholder}
                        maxLength={4_000}
                        rows={4}
                        disabled={creatingProject}
                        className={styles.textarea}
                      />
                      <span className={styles.fieldHelp}>
                        {copy.instructionsHint}
                      </span>
                    </label>

                    <label className={cn(styles.wideField, styles.checkboxRow)}>
                      <input
                        type="checkbox"
                        checked={jevShadowConsent}
                        onChange={(event) =>
                          setJevShadowConsent(event.target.checked)
                        }
                        disabled={creatingProject}
                      />
                      <span>
                        <strong>{copy.jevConsentLabel}</strong>
                        <br />
                        {copy.jevConsentDescription}
                      </span>
                    </label>
                  </div>

                  <div className={styles.intakeActions}>
                    <button
                      type="submit"
                      className={styles.primaryButton}
                      disabled={
                        creatingProject ||
                        (sourceLoadError && availableEpisodes.length === 0) ||
                        availableEpisodes.length === 0 ||
                        sourceUploadState.status === "uploading"
                      }
                    >
                      <Sparkles size={15} aria-hidden="true" />
                      {creatingProject
                        ? copy.startingAnalysis
                        : project?.status === "failed"
                          ? copy.retryAnalysis
                          : copy.startAnalysis}
                    </button>
                    {createError ? (
                      <p className={styles.alertError} role="alert">
                        {createError}
                      </p>
                    ) : null}
                    {sourceUploadState.status === "error" ? (
                      <p className={styles.alertError} role="alert">
                        {sourceUploadState.message}
                      </p>
                    ) : null}
                  </div>
                </form>
              )}
            </div>
          </main>

          <aside
            className={styles.inspector}
            aria-label={studio.productionOptions}
          >
            {projectIsReady && activeCandidate ? (
              <>
                <div className={styles.inspectorTitleRow}>
                  <span>{studio.previewTitle}</span>
                  <button
                    type="button"
                    className={styles.overflowButton}
                    aria-label="Plus d’options d’aperçu"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
                <div className={styles.previewCard}>
                  <div className={styles.previewPlaceholder}>
                    <CirclePlay
                      size={36}
                      strokeWidth={1.4}
                      aria-hidden="true"
                    />
                    <p>
                      {activeCandidate.visualSummary || studio.previewWaiting}
                    </p>
                  </div>
                  <div className={styles.previewCaptions} aria-hidden="true">
                    <span>{activeCandidate.hook.slice(0, 42)}</span>
                  </div>
                  <span className={styles.previewProgress} aria-hidden="true" />
                  <div className={styles.previewControls} aria-hidden="true">
                    <Play size={14} fill="currentColor" />
                    <span>
                      {formatShortsTimestamp(activeCandidate.startSeconds)} /{" "}
                      {activeCandidateDuration}
                    </span>
                    <span className={styles.previewControlGrow} />
                    <Volume2 size={14} />
                  </div>
                </div>

                <div className={styles.productionHeading}>
                  <h2>{studio.productionOptions}</h2>
                  <button
                    type="button"
                    className={styles.resetButton}
                    onClick={() => {
                      setAspectRatio("9:16");
                      setSubtitleStyle("viral");
                      setMotionTemplate("editorial-focus");
                      setReducedMotion(false);
                    }}
                  >
                    {studio.reset}
                  </button>
                </div>

                <div className={styles.optionStack}>
                  <div className={styles.optionRow}>
                    <span className={styles.optionIcon} aria-hidden="true">
                      <Subtitles size={17} />
                    </span>
                    <span className={styles.optionCopy}>
                      <strong>{studio.subtitleOption}</strong>
                      <span>{studio.subtitleDetail}</span>
                    </span>
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked
                        readOnly
                        disabled
                        aria-label={studio.subtitleOption}
                      />
                      <span className={styles.toggleTrack} />
                    </label>
                  </div>
                  <div className={styles.optionRow}>
                    <span className={styles.optionIcon} aria-hidden="true">
                      <Sparkles size={17} />
                    </span>
                    <span className={styles.optionCopy}>
                      <strong>{studio.motionOption}</strong>
                      <span>{studio.motionDetail}</span>
                    </span>
                    <ChevronRight
                      size={17}
                      color="#a8badb"
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.optionRow}>
                    <span className={styles.optionIcon} aria-hidden="true">
                      <Music2 size={17} />
                    </span>
                    <span className={styles.optionCopy}>
                      <strong>{studio.musicOption}</strong>
                      <span>{studio.musicDetail}</span>
                    </span>
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked={elevenLabsEnabled}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setElevenLabsEnabled(enabled);
                          if (!enabled) {
                            setElevenLabsConsent(false);
                            setCommercialLicenseConfirmed(false);
                          }
                        }}
                        disabled={
                          !providerCapabilities.elevenLabs || savingSelection
                        }
                        aria-label={copy.elevenLabsEnableLabel}
                      />
                      <span className={styles.toggleTrack} />
                    </label>
                  </div>
                </div>

                <details className={styles.productionDisclosure}>
                  <summary>
                    {copy.subtitleLabel} · {copy.motionLabel}
                  </summary>
                  <div className={styles.productionDisclosureBody}>
                    <select
                      value={aspectRatio}
                      onChange={(event) =>
                        setAspectRatio(event.target.value as AspectRatio)
                      }
                      className={styles.productionSelect}
                      disabled={savingSelection}
                      aria-label={copy.aspectLabel}
                    >
                      {ASPECT_RATIOS.map((ratio) => (
                        <option key={ratio} value={ratio}>
                          {ratio}
                        </option>
                      ))}
                    </select>
                    <select
                      value={subtitleStyle}
                      onChange={(event) =>
                        setSubtitleStyle(event.target.value as SubtitleStyle)
                      }
                      className={styles.productionSelect}
                      disabled={savingSelection}
                      aria-label={copy.subtitleLabel}
                    >
                      {SUBTITLE_STYLES.map((style) => (
                        <option key={style} value={style}>
                          {style}
                        </option>
                      ))}
                    </select>
                    <select
                      value={motionTemplate}
                      onChange={(event) =>
                        setMotionTemplate(event.target.value as MotionTemplate)
                      }
                      className={styles.productionSelect}
                      disabled={savingSelection || reducedMotion}
                      aria-label={copy.motionLabel}
                    >
                      {MOTION_TEMPLATES.map((template) => (
                        <option key={template} value={template}>
                          {template}
                        </option>
                      ))}
                    </select>
                  </div>
                </details>

                <div className={styles.reducedMotion}>
                  <span className={styles.reducedMotionCopy}>
                    <Settings2 size={15} aria-hidden="true" />
                    {studio.reducedMotion}
                  </span>
                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      checked={reducedMotion}
                      onChange={(event) =>
                        setReducedMotion(event.target.checked)
                      }
                      disabled={savingSelection}
                      aria-label={copy.reducedMotionLabel}
                    />
                    <span className={styles.toggleTrack} />
                  </label>
                </div>

                <details className={styles.productionDisclosure}>
                  <summary>{studio.directionOptions}</summary>
                  <div className={styles.productionDisclosureBody}>
                    <p>{copy.elevenLabsSafety}</p>
                    {elevenLabsEnabled ? (
                      <>
                        <label className={styles.consentCheck}>
                          <input
                            type="checkbox"
                            checked={elevenLabsConsent}
                            onChange={(event) =>
                              setElevenLabsConsent(event.target.checked)
                            }
                            disabled={savingSelection}
                          />
                          {copy.elevenLabsConsentLabel}
                        </label>
                        <label className={styles.consentCheck}>
                          <input
                            type="checkbox"
                            checked={commercialLicenseConfirmed}
                            onChange={(event) =>
                              setCommercialLicenseConfirmed(
                                event.target.checked,
                              )
                            }
                            disabled={savingSelection}
                          />
                          {copy.elevenLabsLicenseLabel}
                        </label>
                      </>
                    ) : null}
                    {!providerCapabilities.elevenLabs ? (
                      <p>{copy.elevenLabsUnavailable}</p>
                    ) : null}
                    <label className={styles.consentCheck}>
                      <input
                        type="checkbox"
                        checked={creativeDirectionEnabled}
                        onChange={(event) =>
                          setCreativeDirectionEnabled(event.target.checked)
                        }
                        disabled={
                          !providerCapabilities.creativeDirection ||
                          savingSelection
                        }
                      />
                      {copy.opusEnableLabel}
                    </label>
                    {!providerCapabilities.creativeDirection ? (
                      <p>{copy.opusUnavailable}</p>
                    ) : null}
                  </div>
                </details>

                <button
                  type="button"
                  className={styles.renderButton}
                  onClick={() => void onGenerateSelected()}
                  disabled={isShortsRenderDisabled({
                    candidatesReady: showCandidateControls,
                    selectedCandidateCount:
                      selectedCandidateIdsForCurrentProject.length,
                    adaptedMusicAuthorized,
                    savingSelection,
                    renderingSelected,
                  })}
                >
                  <Sparkles size={16} aria-hidden="true" />
                  {renderingSelected
                    ? copy.renderingSelected
                    : copy.renderSelected}
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={cn(styles.compactButton, styles.saveButton)}
                  onClick={() => void onSaveSelection()}
                  disabled={isShortsSelectionSaveDisabled({
                    candidatesReady: showCandidateControls,
                    selectedCandidateCount:
                      selectedCandidateIdsForCurrentProject.length,
                    savingSelection,
                    renderingSelected,
                  })}
                >
                  {savingSelection ? copy.savingSelection : copy.saveSelection}
                </button>
                {saveError ? (
                  <p className={styles.alertError} role="alert">
                    {saveError}
                  </p>
                ) : null}
                {saveSuccess ? (
                  <p className={styles.alertSuccess} role="status">
                    {saveSuccess}
                  </p>
                ) : null}
                {renderStatus ? (
                  <p className={styles.statusNote} role="status">
                    {renderStatus}{" "}
                    <a
                      className={styles.galleryLink}
                      href={`/${encodeURIComponent(locale)}/clips`}
                    >
                      {studio.renderGallery}
                    </a>
                  </p>
                ) : null}

                <div className={styles.youtubeRow}>
                  <span className={styles.youtubeIcon} aria-hidden="true">
                    <Play size={12} fill="currentColor" />
                  </span>
                  <span className={styles.youtubeCopy}>
                    <strong>YouTube · {studio.privateLabel}</strong>
                    <span>{studio.youtubeDetail}</span>
                  </span>
                  <LockKeyhole size={15} color="#90a5c8" aria-hidden="true" />
                </div>
              </>
            ) : (
              <div className={styles.emptyInspector}>
                {project ? copy.awaitingCandidates : studio.startAProjectCopy}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
