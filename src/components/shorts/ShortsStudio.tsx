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
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CirclePlay,
  Clock3,
  CreditCard,
  FileAudio,
  Film,
  Library,
  LockKeyhole,
  Maximize,
  MessageSquare,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Subtitles,
  UploadCloud,
  UserRound,
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
import {
  SHORTS_MAX_SOURCE_DURATION_SECONDS,
  SHORTS_MIN_SOURCE_DURATION_SECONDS,
} from "@/lib/shorts/source-duration";
import { CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED } from "@/lib/clips/creative-director-model";
import type { ShortsProviderCapabilities } from "@/lib/shorts/provider-capabilities";

import styles from "./ShortsStudio.module.css";
import {
  filterShortsCandidates,
  formatSourceDuration,
  resolveStudioPhase,
  searchText,
  type CandidateFilter,
  type CandidateSort,
} from "./studio-presentation";

export {
  SHORTS_MAX_SOURCE_DURATION_SECONDS,
  SHORTS_MIN_SOURCE_DURATION_SECONDS,
} from "@/lib/shorts/source-duration";

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
  /** Optional initial state, also used by the isolated read-only demonstration. */
  initialProject?: ShortsProject;
  initialSelectedEpisodeId?: string;
  viewerName?: string;
  /** Read-only demonstration in every environment: never starts remote jobs. */
  previewOnly?: boolean;
  /** Original Canva crops, only consumed when previewOnly is explicitly set. */
  designReference?: Readonly<{
    sourcePoster: string;
    candidatePosters: readonly string[];
    previewPoster: string;
    waveform: string;
    transcriptLines?: readonly Readonly<{ time: number; text: string }>[];
  }>;
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
      "Importez des sources de 1 minute à 4 heures pour créer une série de Shorts.",
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
      "Détectée automatiquement à l’import si le navigateur peut lire le fichier ; ajustez si besoin. Entre 60 s (1 min) et 14 400 s (4 h).",
    durationInvalid: "Indiquez une durée comprise entre 1 minute et 4 heures.",
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
      "Import sources from 1 minute to 4 hours to create a batch of Shorts.",
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
      "Detected automatically on upload when your browser can read the file; adjust if needed. Between 60 s (1 min) and 14,400 s (4 h).",
    durationInvalid: "Enter a duration between 1 minute and 4 hours.",
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
  viewerName,
  designReference,
  previewOnly = false,
}: ShortsStudioProps) {
  const copy = locale.startsWith("fr") ? COPY.fr : COPY.en;
  // This server-supplied prop must keep the public demo read-only in production,
  // too. The authenticated studio does not set it or supply Canva fixture media.
  const isDesignPreview = previewOnly;
  const designPreviewNotice = locale.startsWith("fr")
    ? "Aperçu de design uniquement : aucun import, appel IA ou rendu n’est lancé. Utilisez le Studio connecté pour créer vos Shorts."
    : "Design preview only: no upload, AI call or render is started. Use the signed-in Studio to create your Shorts.";
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
  const [candidateFilter, setCandidateFilter] =
    useState<CandidateFilter>("all");
  const [candidateSort, setCandidateSort] = useState<CandidateSort>("rank");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidateSearchOpen, setCandidateSearchOpen] = useState(false);
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [workspaceTab, setWorkspaceTab] = useState<"transcript" | "timeline">(
    "transcript",
  );
  const [localMediaUrl, setLocalMediaUrl] = useState<string | null>(null);
  const localMediaUrlRef = useRef<string | null>(null);
  const sourcePlayerRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSeconds, setPlaybackSeconds] = useState(0);
  const [mediaMuted, setMediaMuted] = useState(false);
  const sourceSectionRef = useRef<HTMLFormElement>(null);
  const productionSettingsRef = useRef<HTMLDetailsElement>(null);
  const productionRightsRef = useRef<HTMLDetailsElement>(null);
  const referenceMedia =
    isDesignPreview && project?.status === "ready"
      ? designReference
      : undefined;
  useEffect(
    () => () => {
      if (localMediaUrlRef.current)
        URL.revokeObjectURL(localMediaUrlRef.current);
    },
    [],
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
    if (isDesignPreview || !projectId) return;
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
  }, [copy.projectError, isDesignPreview, projectId]);

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

      if (localMediaUrlRef.current)
        URL.revokeObjectURL(localMediaUrlRef.current);
      const previewUrl = URL.createObjectURL(file);
      localMediaUrlRef.current = previewUrl;
      setLocalMediaUrl(previewUrl);

      if (isDesignPreview) {
        setSourceUploadState({
          status: "error",
          filename: file.name,
          message: designPreviewNotice,
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
      designPreviewNotice,
      isDesignPreview,
      runSourceUpload,
    ],
  );

  const retrySourceUpload = useCallback(() => {
    const active = activeSourceUploadRef.current;
    if (active) void runSourceUpload(active);
  }, [runSourceUpload]);

  const onEpisodeChange = useCallback(
    (episodeId: string) => {
      if (localMediaUrlRef.current)
        URL.revokeObjectURL(localMediaUrlRef.current);
      localMediaUrlRef.current = null;
      setLocalMediaUrl(null);
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
      if (isDesignPreview) {
        setCreateError(designPreviewNotice);
        return;
      }
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
      designPreviewNotice,
      durationSeconds,
      instructions,
      isDesignPreview,
      jevShadowConsent,
      selectedEpisodeId,
      validDuration,
    ],
  );

  const toggleCandidate = useCallback((candidateId: string) => {
    setSaveError(null);
    setSaveSuccess(null);
    setActiveCandidateId(candidateId);
    sourcePlayerRef.current?.pause();
    if (sourcePlayerRef.current) sourcePlayerRef.current.currentTime = 0;
    setIsPlaying(false);
    setPlaybackSeconds(0);
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

    if (isDesignPreview) {
      setSaveSuccess(designPreviewNotice);
      return;
    }

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
    designPreviewNotice,
    elevenLabsConsent,
    elevenLabsEnabled,
    isDesignPreview,
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

    if (isDesignPreview) {
      setSaveSuccess(designPreviewNotice);
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
    designPreviewNotice,
    elevenLabsConsent,
    elevenLabsEnabled,
    isDesignPreview,
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
        reviewSource: "Nouveau projet",
        reviewProcessing: "Analyse en cours",
        reviewFailed: "À vérifier",
        newProject: "Nouveau projet",
        source: "Source",
        analysis: "Analyse",
        selection: "Sélection",
        production: "Production",
        publication: "Publication",
        library: "Bibliothèque",
        createClip: "Créer un clip",
        pricing: "Tarifs",
        all: "Tous",
        keyIdeas: "Idées clés",
        strongMoments: "Moments forts",
        questions: "Questions",
        reels: "Ton léger",
        sort: "Trier par : Score",
        reviewAnalysis: "Analyse IA terminée",
        reviewAnalysisPending: "Analyse IA en cours",
        reviewAnalysisIdle: "Prêt à analyser",
        reviewAnalysisFailed: "Analyse interrompue",
        analysisSummary: (count: number) =>
          `${count} moment${count > 1 ? "s" : ""} pertinent${count > 1 ? "s" : ""} trouvé${count > 1 ? "s" : ""} dans votre vidéo.`,
        relaunch: "Relancer l’analyse",
        startAProject: "Importez une source pour commencer",
        startAProjectCopy:
          "Votre transcription, les propositions d’extraits et l’aperçu de production apparaîtront ici.",
        sourcePanel: "Préparer une nouvelle analyse",
        sourcePanelCopy:
          "Choisissez un épisode ou importez une vidéo ou un podcast de 1 minute à 4 heures.",
        mediaWaiting:
          "Les aperçus vidéo utilisent votre média après l’analyse.",
        currentExcerpt: "Extrait à",
        listen: "Lire l’extrait complet",
        transcriptTab: "Transcription",
        timelineTab: "Timeline",
        previewTitle: "Aperçu du Short",
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
        importTitle: "Vos prochains",
        importAccent: "Shorts commencent ici",
        importCopy:
          "Une vidéo longue. Les meilleurs moments. Des Shorts qui captivent.",
        selectedFilter: "Ma sélection",
        highScoreFilter: "Score 85+",
        searchCandidates: "Rechercher dans les extraits…",
        searchTranscript: "Rechercher dans la transcription…",
        noSearchResults: "Aucun extrait ne correspond à ces filtres.",
        mediaUnavailable:
          "Importez votre média pour activer la lecture. Aucun aperçu vidéo n’a été inventé.",
        previewEmpty: "Votre prochain Short",
        previewEmptyCopy:
          "Importez une source, puis sélectionnez un moment. Votre aperçu vertical prendra place ici.",
        demoLabel: "Maquette · données de démonstration",
      }
    : {
        reviewReady: "Ready to review",
        reviewSource: "New project",
        reviewProcessing: "Analysis in progress",
        reviewFailed: "Needs attention",
        newProject: "New project",
        source: "Source",
        analysis: "Analysis",
        selection: "Selection",
        production: "Production",
        publication: "Publishing",
        library: "Library",
        createClip: "Create a clip",
        pricing: "Pricing",
        all: "All",
        keyIdeas: "Key ideas",
        strongMoments: "Strong moments",
        questions: "Questions",
        reels: "Playful",
        sort: "Sort by: Score",
        reviewAnalysis: "AI analysis complete",
        reviewAnalysisPending: "AI analysis in progress",
        reviewAnalysisIdle: "Ready to analyze",
        reviewAnalysisFailed: "Analysis interrupted",
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
        previewTitle: "Short preview",
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
        importTitle: "Your next",
        importAccent: "Shorts start here",
        importCopy:
          "One long video. The strongest moments. Shorts that captivate.",
        selectedFilter: "My selection",
        highScoreFilter: "Score 85+",
        searchCandidates: "Search excerpts…",
        searchTranscript: "Search the transcript…",
        noSearchResults: "No excerpts match these filters.",
        mediaUnavailable:
          "Import your media to enable playback. No video preview has been invented.",
        previewEmpty: "Your next Short",
        previewEmptyCopy:
          "Import a source, then select a moment. Your vertical preview will appear here.",
        demoLabel: "Mockup · demonstration data",
      };
  const filteredCandidates = useMemo(
    () =>
      filterShortsCandidates(
        project?.candidates ?? [],
        selectedCandidateIds,
        candidateFilter,
        candidateQuery,
        candidateSort,
      ),
    [
      project,
      selectedCandidateIds,
      candidateFilter,
      candidateQuery,
      candidateSort,
    ],
  );
  const activeCandidate =
    filteredCandidates.find(
      (candidate) => candidate.id === activeCandidateId,
    ) ??
    filteredCandidates[0] ??
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
    return sentences.length > 0 ? sentences : [excerpt];
  }, [activeCandidate]);
  const sourceTitle = selectedEpisode?.title || copy.sourcePlaceholder;
  const sourceDuration = selectedEpisode?.durationSeconds
    ? formatSourceDuration(
        selectedEpisode.durationSeconds,
        locale.startsWith("fr"),
      )
    : validDuration
      ? formatSourceDuration(durationSeconds, locale.startsWith("fr"))
      : copy.unavailableDuration;
  const candidateCount = project?.candidates.length ?? 0;
  const candidatePage = resolveShortsCandidatePage(
    filteredCandidates.length,
    filteredCandidates.findIndex(
      (candidate) => candidate.id === activeCandidate?.id,
    ) ?? 0,
  );
  const projectIsReady = project?.status === "ready";
  const studioPhase = resolveStudioPhase(project, creatingProject);
  const referencePreview =
    activeCandidate?.rank === 1
      ? referenceMedia?.previewPoster
      : referenceMedia?.candidatePosters[(activeCandidate?.rank ?? 1) - 1];
  const referenceTranscript =
    activeCandidate?.rank === 1 ? referenceMedia?.transcriptLines : undefined;
  const visibleTranscriptLines = transcriptLines.filter(
    (line) =>
      !transcriptQuery ||
      searchText(line).includes(searchText(transcriptQuery)),
  );
  const displayedTranscriptLines =
    referenceTranscript
      ?.filter(
        (line) =>
          !transcriptQuery ||
          searchText(line.text).includes(searchText(transcriptQuery)),
      )
      .map((line) => line.text) ?? visibleTranscriptLines;
  const sourceDate =
    selectedEpisode?.createdAt &&
    !Number.isNaN(Date.parse(selectedEpisode.createdAt))
      ? new Intl.DateTimeFormat(locale.startsWith("fr") ? "fr-FR" : "en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(new Date(selectedEpisode.createdAt))
      : null;
  const togglePlayback = () => {
    const player = sourcePlayerRef.current;
    if (!player || !localMediaUrl || !activeCandidate) return;
    if (player.paused) {
      if (
        player.currentTime < activeCandidate.startSeconds ||
        player.currentTime >= activeCandidate.endSeconds
      )
        player.currentTime = activeCandidate.startSeconds;
      void player.play().catch(() => setIsPlaying(false));
    } else player.pause();
  };

  const toggleProductionSettings = () => {
    const settings = productionSettingsRef.current;
    if (!settings) return;
    settings.open = !settings.open;
    settings.scrollIntoView({ block: "nearest" });
  };

  const resetReviewPlayback = () => {
    sourcePlayerRef.current?.pause();
    if (sourcePlayerRef.current) sourcePlayerRef.current.currentTime = 0;
    setIsPlaying(false);
    setPlaybackSeconds(0);
  };
  const reviewCandidate = (candidate: ShortsCandidate) => {
    sourcePlayerRef.current?.pause();
    if (sourcePlayerRef.current && localMediaUrl)
      sourcePlayerRef.current.currentTime = candidate.startSeconds;
    setPlaybackSeconds(candidate.startSeconds);
    setIsPlaying(false);
    setActiveCandidateId(candidate.id);
    setTranscriptQuery("");
  };

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
    setCandidateFilter("all");
    setCandidateQuery("");
    setCandidateSort("rank");
    setTranscriptQuery("");
    setWorkspaceTab("transcript");
    setIsPlaying(false);
  }, []);

  return (
    <div
      className={styles.studio}
      data-preview-only={isDesignPreview || undefined}
    >
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <a href={`/${encodeURIComponent(locale)}`} className={styles.brand}>
            {/* Supplied Canva mark, not a replacement illustration. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.brandMark}
              src="/images/brand/clipsflow-canva-mark.png"
              alt=""
              width={34}
              height={38}
            />
            <span>ClipsFlow</span>
          </a>

          <button
            type="button"
            className={styles.workspaceSelect}
            title={sourceTitle}
            onClick={() => {
              if (project) onStartNewProject();
              sourceSectionRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
            disabled={creatingProject || renderingSelected}
          >
            <span className={styles.workspacePoster} aria-hidden="true">
              {referenceMedia ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={referenceMedia.sourcePoster} alt="" />
              ) : (
                <Video size={16} />
              )}
            </span>
            <span className={styles.workspaceLabel}>{sourceTitle}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>

          <div className={styles.topbarActions}>
            <span
              className={styles.reviewStatus}
              data-phase={studioPhase}
              title={isDesignPreview ? designPreviewNotice : undefined}
            >
              <span className={styles.statusDot} aria-hidden="true" />
              {isDesignPreview
                ? locale.startsWith("fr")
                  ? "Démo · lecture seule"
                  : "Demo · read only"
                : studioPhase === "ready"
                  ? studio.reviewReady
                  : studioPhase === "processing"
                    ? studio.reviewProcessing
                    : studioPhase === "failed"
                      ? studio.reviewFailed
                      : studio.reviewSource}
            </span>
            <div
              className={styles.avatars}
              aria-label={
                viewerName ||
                (locale.startsWith("fr") ? "Votre espace" : "Your workspace")
              }
            >
              <span className={styles.avatar}>
                {viewerName ? (
                  viewerName
                    .trim()
                    .split(/\s+/u)
                    .slice(0, 2)
                    .map((name) => name[0])
                    .join("")
                    .toUpperCase()
                ) : (
                  <UserRound size={16} />
                )}
              </span>
            </div>
            <details className={styles.studioHelp}>
              <summary
                className={styles.iconButton}
                aria-label={
                  locale.startsWith("fr") ? "Aide du Studio" : "Studio help"
                }
              >
                <MessageSquare size={16} />
              </summary>
              <p>
                {isDesignPreview
                  ? designPreviewNotice
                  : studio.startAProjectCopy}
                {isDesignPreview ? (
                  <>
                    {" "}
                    <a href={`/${encodeURIComponent(locale)}/shorts`}>
                      {locale.startsWith("fr")
                        ? "Ouvrir le Studio"
                        : "Open Studio"}
                    </a>
                  </>
                ) : null}
              </p>
            </details>
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
              {referenceMedia ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={referenceMedia.sourcePoster} alt="" />
              ) : localMediaUrl ? (
                <video
                  src={localMediaUrl}
                  muted
                  playsInline
                  preload="metadata"
                />
              ) : (
                <div className={styles.sourceVisualInner}>
                  <Video size={24} strokeWidth={1.5} />
                  <span>
                    {locale.startsWith("fr")
                      ? "Votre vidéo ou votre podcast"
                      : "Your video or podcast"}
                  </span>
                </div>
              )}
            </div>
            <p className={styles.sourceTitle}>{sourceTitle}</p>
            <div className={styles.sourceMeta}>
              <span className={styles.sourceMetaItem}>
                <Clock3 size={14} aria-hidden="true" />
                {sourceDuration}
              </span>
              <span className={styles.sourceMetaItem}>
                {sourceDate ? (
                  <CalendarDays size={15} aria-hidden="true" />
                ) : (
                  <FileAudio size={14} aria-hidden="true" />
                )}
                {sourceDate ||
                  (analysisMode === "audio_video"
                    ? copy.audioVideoTitle
                    : copy.audioTitle)}
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
                  {selectedEpisodeId ? (
                    <Check size={14} />
                  ) : (
                    <UploadCloud size={13} />
                  )}
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
                  {projectIsReady ? <Check size={14} /> : null}
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
                  {projectIsReady ? <CircleCheck size={15} /> : null}
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
                <span className={styles.stepMarker} aria-hidden="true"></span>
                <span className={styles.stepContent}>
                  <span className={styles.stepIndex}>04</span>
                  <span className={styles.stepTitle}>{studio.production}</span>
                </span>
              </li>
              <li className={styles.step}>
                <span className={styles.stepMarker} aria-hidden="true"></span>
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
                <Film size={17} aria-hidden="true" />
                {studio.createClip}
              </a>
              <a
                className={styles.footerLink}
                href={`/${encodeURIComponent(locale)}/pricing`}
              >
                <CreditCard size={17} aria-hidden="true" />
                {studio.pricing}
              </a>
            </nav>
          </aside>

          <main className={styles.main}>
            <div className={styles.content}>
              <section
                className={cn(
                  styles.studioHeader,
                  !projectIsReady && styles.studioHeaderSource,
                )}
              >
                <div>
                  <p className={styles.eyebrow}>
                    {isDesignPreview
                      ? locale.startsWith("fr")
                        ? "STUDIO SHORTS · DÉMO EN LECTURE SEULE"
                        : "SHORTS STUDIO · READ-ONLY DEMO"
                      : locale.startsWith("fr")
                        ? "STUDIO SHORTS"
                        : "SHORTS STUDIO"}
                  </p>
                  <h1 className={styles.headline}>
                    {projectIsReady ? candidateCount : studio.importTitle}{" "}
                    <span className={styles.headlineAccent}>
                      {!projectIsReady
                        ? studio.importAccent
                        : locale.startsWith("fr")
                          ? "moments trouvés"
                          : "moments found"}
                    </span>
                  </h1>
                  <p className={styles.headlineDescription}>
                    {projectIsReady
                      ? locale.startsWith("fr")
                        ? "Des extraits à fort potentiel pour des Shorts captivants."
                        : "High-potential excerpts for captivating Shorts."
                      : studio.importCopy}
                  </p>
                </div>
                <div
                  className={styles.analysisComplete}
                  data-phase={studioPhase}
                  aria-live="polite"
                >
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
                        : studioPhase === "processing"
                          ? studio.reviewAnalysisPending
                          : studioPhase === "failed"
                            ? studio.reviewAnalysisFailed
                            : studio.reviewAnalysisIdle}
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
                    {(
                      [
                        ["all", studio.all],
                        ["selected", studio.selectedFilter],
                        ["high_score", studio.highScoreFilter],
                        ["questions", studio.questions],
                        ["playful", studio.reels],
                      ] as const
                    ).map(([filter, label]) => (
                      <button
                        key={filter}
                        type="button"
                        className={cn(
                          styles.filterPill,
                          candidateFilter === filter && styles.filterPillActive,
                        )}
                        aria-pressed={candidateFilter === filter}
                        onClick={() => {
                          setCandidateFilter(filter);
                          setActiveCandidateId(null);
                          resetReviewPlayback();
                        }}
                      >
                        <span className={styles.filterDot} aria-hidden="true" />
                        {label} (
                        {
                          filterShortsCandidates(
                            project.candidates,
                            selectedCandidateIds,
                            filter,
                          ).length
                        }
                        )
                      </button>
                    ))}
                    <select
                      className={styles.sortControl}
                      value={candidateSort}
                      onChange={(event) => {
                        setCandidateSort(event.target.value as CandidateSort);
                        setActiveCandidateId(null);
                        resetReviewPlayback();
                      }}
                      aria-label={
                        locale.startsWith("fr")
                          ? "Trier les extraits"
                          : "Sort excerpts"
                      }
                    >
                      <option value="rank">
                        {locale.startsWith("fr")
                          ? "Trier par : IA"
                          : "Sort by: AI"}
                      </option>
                      <option value="score">{studio.sort}</option>
                      <option value="chronological">
                        {locale.startsWith("fr")
                          ? "Chronologie"
                          : "Chronological"}
                      </option>
                      <option value="duration">
                        {locale.startsWith("fr") ? "Durée" : "Duration"}
                      </option>
                    </select>
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
                            reviewCandidate(
                              filteredCandidates[candidatePage.start - 3],
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
                            reviewCandidate(
                              filteredCandidates[candidatePage.end],
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
                      aria-expanded={candidateSearchOpen}
                      onClick={() => setCandidateSearchOpen((open) => !open)}
                    >
                      <Search size={15} />
                    </button>
                  </div>

                  {candidateSearchOpen ? (
                    <label className={styles.reviewSearch}>
                      <Search size={16} aria-hidden="true" />
                      <input
                        value={candidateQuery}
                        onChange={(event) => {
                          setCandidateQuery(event.target.value);
                          setActiveCandidateId(null);
                          resetReviewPlayback();
                        }}
                        placeholder={studio.searchCandidates}
                        aria-label={studio.searchCandidates}
                      />
                    </label>
                  ) : null}
                  {filteredCandidates.length === 0 ? (
                    <p className={styles.noResults} role="status">
                      {studio.noSearchResults}{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setCandidateFilter("all");
                          setCandidateQuery("");
                        }}
                      >
                        {studio.reset}
                      </button>
                    </p>
                  ) : null}

                  <section
                    className={styles.candidates}
                    aria-label={copy.candidatesTitle}
                  >
                    {filteredCandidates
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
                          >
                            <button
                              type="button"
                              className={styles.candidateOpen}
                              aria-pressed={isActive}
                              aria-label={candidate.title}
                              onClick={() => reviewCandidate(candidate)}
                            />
                            <div className={styles.candidateVisual}>
                              {referenceMedia?.candidatePosters[
                                candidate.rank - 1
                              ] ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  className={styles.referenceCandidateImage}
                                  src={
                                    referenceMedia.candidatePosters[
                                      candidate.rank - 1
                                    ]
                                  }
                                  alt=""
                                />
                              ) : localMediaUrl ? (
                                <video
                                  src={`${localMediaUrl}#t=${candidate.startSeconds}`}
                                  playsInline
                                  muted
                                  preload="metadata"
                                  onLoadedMetadata={(event) => {
                                    event.currentTarget.currentTime =
                                      candidate.startSeconds;
                                  }}
                                />
                              ) : (
                                <span className={styles.mediaSignal}>
                                  <Video
                                    size={20}
                                    strokeWidth={1.65}
                                    aria-hidden="true"
                                  />
                                  {candidate.visualSummary ||
                                    studio.mediaWaiting}
                                </span>
                              )}
                              <span
                                className={
                                  referenceMedia?.candidatePosters[
                                    candidate.rank - 1
                                  ]
                                    ? styles.srOnly
                                    : styles.candidateScore
                                }
                              >
                                {candidate.score}
                              </span>
                              <span
                                className={
                                  referenceMedia?.candidatePosters[
                                    candidate.rank - 1
                                  ]
                                    ? styles.srOnly
                                    : styles.candidateDuration
                                }
                              >
                                {candidateDuration}
                              </span>
                            </div>
                            <div className={styles.candidateMeta}>
                              <button
                                type="button"
                                className={styles.candidateSelect}
                                data-selected={checked}
                                aria-label={`${checked ? copy.selected : copy.selectCandidate} · ${candidate.title}`}
                                aria-pressed={checked}
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
                                  {candidate.rationale || candidate.hook}
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
                            {locale.startsWith("fr")
                              ? "Extrait de"
                              : "Excerpt from"}{" "}
                            {formatShortsTimestamp(
                              activeCandidate.startSeconds,
                            )}{" "}
                            {locale.startsWith("fr") ? " à " : " to "}
                            {formatShortsTimestamp(activeCandidate.endSeconds)}
                            {" · "}
                            {Math.round(
                              activeCandidate.endSeconds -
                                activeCandidate.startSeconds,
                            )}{" "}
                            {locale.startsWith("fr") ? "secondes" : "seconds"}
                          </p>
                        </div>
                      </div>
                      <div className={styles.selectionActions}>
                        <button
                          type="button"
                          className={styles.listenButton}
                          onClick={togglePlayback}
                          disabled={!localMediaUrl}
                          title={
                            !localMediaUrl ? studio.mediaUnavailable : undefined
                          }
                        >
                          <Play
                            size={13}
                            fill="currentColor"
                            aria-hidden="true"
                          />
                          {studio.listen}
                        </button>
                        <details className={styles.selectionMenu}>
                          <summary
                            className={styles.overflowButton}
                            aria-label={
                              locale.startsWith("fr")
                                ? "Options de l’extrait"
                                : "Excerpt options"
                            }
                          >
                            <MoreHorizontal size={17} />
                          </summary>
                          <div className={styles.selectionMenuBody}>
                            <p>{activeCandidate.rationale}</p>
                            <button
                              type="button"
                              className={styles.compactButton}
                              onClick={() =>
                                toggleCandidate(activeCandidate.id)
                              }
                            >
                              {selectedCandidateIds.has(activeCandidate.id)
                                ? locale.startsWith("fr")
                                  ? "Retirer de ma sélection"
                                  : "Remove from selection"
                                : copy.selectCandidate}
                            </button>
                            <button
                              type="button"
                              className={styles.compactButton}
                              onClick={() => void onSaveSelection()}
                              disabled={isShortsSelectionSaveDisabled({
                                candidatesReady: showCandidateControls,
                                selectedCandidateCount:
                                  selectedCandidateIdsForCurrentProject.length,
                                savingSelection,
                                renderingSelected,
                              })}
                            >
                              {savingSelection
                                ? copy.savingSelection
                                : copy.saveSelection}
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>

                    <div className={styles.transcriptTabs}>
                      <button
                        type="button"
                        className={cn(
                          styles.transcriptTab,
                          workspaceTab === "transcript" &&
                            styles.transcriptTabActive,
                        )}
                        aria-pressed={workspaceTab === "transcript"}
                        onClick={() => setWorkspaceTab("transcript")}
                      >
                        {studio.transcriptTab}
                      </button>
                      <button
                        type="button"
                        className={cn(
                          styles.transcriptTab,
                          workspaceTab === "timeline" &&
                            styles.transcriptTabActive,
                        )}
                        aria-pressed={workspaceTab === "timeline"}
                        onClick={() => setWorkspaceTab("timeline")}
                      >
                        {studio.timelineTab}
                      </button>
                      <label className={styles.transcriptSearch}>
                        <Search size={15} aria-hidden="true" />
                        <input
                          value={transcriptQuery}
                          onChange={(event) =>
                            setTranscriptQuery(event.target.value)
                          }
                          placeholder={studio.searchTranscript}
                          aria-label={studio.searchTranscript}
                        />
                      </label>
                    </div>

                    {workspaceTab === "transcript" ? (
                      <div className={styles.transcriptBody}>
                        <div className={styles.transcriptLines}>
                          {displayedTranscriptLines.length === 0 ? (
                            <p className={styles.transcriptEmpty}>
                              {locale.startsWith("fr")
                                ? "Aucun passage ne correspond à votre recherche."
                                : "No transcript passage matches your search."}
                            </p>
                          ) : null}
                          {displayedTranscriptLines.map((line, index) => {
                            // The API supplies an excerpt, not per-line timestamps.
                            // Never invent 3-second cues; exact timing belongs to the renderer.
                            const timestamp = referenceTranscript
                              ? formatShortsTimestamp(
                                  referenceTranscript.find(
                                    (cue) => cue.text === line,
                                  )?.time,
                                )
                              : index === 0
                                ? formatShortsTimestamp(
                                    activeCandidate.startSeconds,
                                  )
                                : "—";
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
                    ) : (
                      <div className={styles.timelineList}>
                        {filteredCandidates.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            className={cn(
                              styles.timelineItem,
                              candidate.id === activeCandidate.id &&
                                styles.timelineItemActive,
                            )}
                            onClick={() => reviewCandidate(candidate)}
                          >
                            <span>
                              {formatShortsTimestamp(candidate.startSeconds)} —{" "}
                              {formatShortsTimestamp(candidate.endSeconds)}
                            </span>
                            <strong>{candidate.title}</strong>
                            <span>{candidate.score}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className={styles.waveformPanel}>
                      <div
                        className={styles.waveform}
                        aria-label={
                          locale.startsWith("fr")
                            ? "Repères temporels de l’extrait"
                            : "Excerpt timeline"
                        }
                      >
                        {referenceMedia && activeCandidate.rank === 1 ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={referenceMedia.waveform}
                            alt="Forme d’onde de la maquette Canva, données de démonstration"
                            className={styles.referenceWaveform}
                          />
                        ) : (
                          <span className={styles.timelineNotice}>
                            {locale.startsWith("fr")
                              ? "Repères de l’extrait · la synchronisation exacte est calculée au rendu"
                              : "Excerpt bounds · exact synchronization is computed at render time"}
                          </span>
                        )}
                      </div>
                      <div className={styles.waveTimes} aria-hidden="true">
                        {referenceMedia && activeCandidate.rank === 1 ? (
                          [
                            "12:00",
                            "12:15",
                            "12:30",
                            "12:45",
                            "13:00",
                            "13:15",
                            "13:30",
                            "13:45",
                            "14:00",
                          ].map((time) => <span key={time}>{time}</span>)
                        ) : (
                          <>
                            <span>
                              {formatShortsTimestamp(
                                activeCandidate.startSeconds,
                              )}
                            </span>
                            <span>
                              {formatShortsTimestamp(
                                (activeCandidate.startSeconds +
                                  activeCandidate.endSeconds) /
                                  2,
                              )}
                            </span>
                            <span>
                              {formatShortsTimestamp(
                                activeCandidate.endSeconds,
                              )}
                            </span>
                          </>
                        )}
                      </div>
                      <div className={styles.playback}>
                        <button
                          type="button"
                          className={styles.playCircle}
                          aria-label={studio.listen}
                          onClick={togglePlayback}
                          disabled={!localMediaUrl}
                          title={
                            !localMediaUrl ? studio.mediaUnavailable : undefined
                          }
                        >
                          {isPlaying ? (
                            <Pause size={17} fill="currentColor" />
                          ) : (
                            <Play size={17} fill="currentColor" />
                          )}
                        </button>
                        <span className={styles.playTime}>
                          {formatShortsTimestamp(
                            localMediaUrl
                              ? Math.max(
                                  activeCandidate.startSeconds,
                                  Math.min(
                                    playbackSeconds,
                                    activeCandidate.endSeconds,
                                  ),
                                )
                              : activeCandidate.startSeconds,
                          )}{" "}
                          <span>
                            /{" "}
                            {formatShortsTimestamp(activeCandidate.endSeconds)}
                          </span>
                        </span>
                        <input
                          type="range"
                          className={styles.seekBar}
                          min={activeCandidate.startSeconds}
                          max={activeCandidate.endSeconds}
                          step={0.1}
                          value={Math.max(
                            activeCandidate.startSeconds,
                            Math.min(
                              playbackSeconds,
                              activeCandidate.endSeconds,
                            ),
                          )}
                          aria-label={
                            locale.startsWith("fr")
                              ? "Position de lecture"
                              : "Playback position"
                          }
                          disabled={!localMediaUrl}
                          onChange={(event) => {
                            const time = Number(event.target.value);
                            if (sourcePlayerRef.current)
                              sourcePlayerRef.current.currentTime = time;
                            setPlaybackSeconds(time);
                          }}
                        />
                        <span className={styles.playbackFormat}>
                          {aspectRatio}
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
                  ref={sourceSectionRef}
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

                    <details
                      className={cn(styles.wideField, styles.advancedAnalysis)}
                    >
                      <summary>
                        {locale.startsWith("fr")
                          ? "Options avancées · évaluation Jev facultative"
                          : "Advanced options · optional Jev evaluation"}
                      </summary>
                      <label className={styles.checkboxRow}>
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
                    </details>
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
                    <span className={styles.intakeReassurance}>
                      <LockKeyhole size={13} aria-hidden="true" />
                      {locale.startsWith("fr")
                        ? "Votre source reste privée. Aucune publication automatique."
                        : "Your source stays private. No automatic publishing."}
                    </span>
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
            <div className={styles.inspectorPanel}>
              {projectIsReady && activeCandidate ? (
                <>
                  <div className={styles.inspectorTitleRow}>
                    <span>
                      {studio.previewTitle}{" "}
                      <span className={styles.previewRatio}>
                        ({aspectRatio})
                      </span>
                    </span>
                    {referenceMedia ? (
                      <span
                        className={styles.demoBadge}
                        title={studio.demoLabel}
                      >
                        Maquette
                      </span>
                    ) : null}
                  </div>
                  <div className={styles.previewCard}>
                    {referencePreview ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={referencePreview}
                        className={styles.previewMedia}
                        alt="Visuel original de la maquette Canva, pas un rendu généré"
                      />
                    ) : localMediaUrl ? (
                      <video
                        ref={sourcePlayerRef}
                        src={localMediaUrl}
                        className={styles.previewMedia}
                        playsInline
                        preload="metadata"
                        muted={mediaMuted}
                        onLoadedMetadata={(event) => {
                          event.currentTarget.currentTime =
                            activeCandidate.startSeconds;
                          setPlaybackSeconds(activeCandidate.startSeconds);
                        }}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        onTimeUpdate={(event) => {
                          const player = event.currentTarget;
                          setPlaybackSeconds(player.currentTime);
                          if (
                            player.currentTime >= activeCandidate.endSeconds
                          ) {
                            player.pause();
                            player.currentTime = activeCandidate.startSeconds;
                          }
                        }}
                      />
                    ) : (
                      <div className={styles.previewPlaceholder}>
                        <CirclePlay
                          size={36}
                          strokeWidth={1.4}
                          aria-hidden="true"
                        />
                        <p>
                          {activeCandidate.visualSummary ||
                            studio.previewWaiting}
                        </p>
                      </div>
                    )}
                    {activeCandidate.rank !== 1 || !referenceMedia ? (
                      <div
                        className={styles.previewCaptions}
                        aria-hidden="true"
                      >
                        <span>{activeCandidate.hook}</span>
                      </div>
                    ) : null}
                    <input
                      type="range"
                      className={styles.previewSeek}
                      min={activeCandidate.startSeconds}
                      max={activeCandidate.endSeconds}
                      step={0.1}
                      value={Math.max(
                        activeCandidate.startSeconds,
                        Math.min(playbackSeconds, activeCandidate.endSeconds),
                      )}
                      aria-label={
                        locale.startsWith("fr")
                          ? "Position dans l’aperçu"
                          : "Preview position"
                      }
                      disabled={!localMediaUrl}
                      onChange={(event) => {
                        const time = Number(event.target.value);
                        if (sourcePlayerRef.current)
                          sourcePlayerRef.current.currentTime = time;
                        setPlaybackSeconds(time);
                      }}
                    />
                    <div className={styles.previewControls}>
                      <button
                        type="button"
                        onClick={togglePlayback}
                        disabled={!localMediaUrl}
                        aria-label={studio.listen}
                        title={
                          !localMediaUrl ? studio.mediaUnavailable : undefined
                        }
                      >
                        {isPlaying ? (
                          <Pause size={18} fill="currentColor" />
                        ) : (
                          <Play size={18} fill="currentColor" />
                        )}
                      </button>
                      <span>
                        {formatShortsTimestamp(
                          localMediaUrl
                            ? Math.max(
                                0,
                                playbackSeconds - activeCandidate.startSeconds,
                              )
                            : 0,
                        )}{" "}
                        / {activeCandidateDuration}
                      </span>
                      <span className={styles.previewControlGrow} />
                      <button
                        type="button"
                        disabled={!localMediaUrl}
                        onClick={() => setMediaMuted((muted) => !muted)}
                        aria-pressed={mediaMuted}
                        aria-label={
                          locale.startsWith("fr")
                            ? "Couper le son"
                            : "Mute audio"
                        }
                      >
                        <Volume2 size={18} />
                      </button>
                      <button
                        type="button"
                        disabled={!localMediaUrl}
                        aria-label={
                          locale.startsWith("fr")
                            ? "Vidéo source en plein écran"
                            : "Fullscreen source video"
                        }
                        onClick={() => {
                          void sourcePlayerRef.current
                            ?.requestFullscreen()
                            .catch(() => {
                              setSaveError(
                                locale.startsWith("fr")
                                  ? "Le plein écran n’est pas disponible dans ce navigateur."
                                  : "Fullscreen is unavailable in this browser.",
                              );
                            });
                        }}
                      >
                        <Maximize size={18} />
                      </button>
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
                        setElevenLabsConsent(false);
                        setCommercialLicenseConfirmed(false);
                        setCreativeDirectionEnabled(false);
                      }}
                    >
                      {studio.reset}
                    </button>
                  </div>

                  <div className={styles.optionStack}>
                    <div className={styles.optionRow}>
                      <span className={styles.optionIcon} aria-hidden="true">
                        <span className={styles.captionIcon}>CC</span>
                      </span>
                      <span className={styles.optionCopy}>
                        <strong>{studio.subtitleOption}</strong>
                        <span>{studio.subtitleDetail}</span>
                      </span>
                      <label
                        className={cn(styles.toggle, styles.requiredToggle)}
                      >
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
                    <div
                      className={cn(styles.optionRow, styles.motionOptionRow)}
                    >
                      <span className={styles.optionIcon} aria-hidden="true">
                        <Sparkles size={24} />
                      </span>
                      <button
                        type="button"
                        className={cn(
                          styles.optionCopy,
                          styles.optionSettingsButton,
                        )}
                        onClick={toggleProductionSettings}
                        aria-label={
                          locale.startsWith("fr")
                            ? "Réglages motion et sous-titres"
                            : "Motion and subtitle settings"
                        }
                      >
                        <strong>{studio.motionOption}</strong>
                        <span>{studio.motionDetail}</span>
                      </button>
                      <label className={styles.toggle}>
                        <input
                          type="checkbox"
                          checked={
                            !reducedMotion &&
                            motionTemplate !== "minimal-static"
                          }
                          disabled={savingSelection || reducedMotion}
                          aria-label={
                            locale.startsWith("fr")
                              ? "Activer le motion design"
                              : "Enable motion design"
                          }
                          onChange={(event) =>
                            setMotionTemplate(
                              event.target.checked
                                ? "editorial-focus"
                                : "minimal-static",
                            )
                          }
                        />
                        <span className={styles.toggleTrack} />
                      </label>
                      <button
                        type="button"
                        className={styles.optionChevron}
                        onClick={toggleProductionSettings}
                        aria-label={
                          locale.startsWith("fr")
                            ? "Ouvrir les réglages motion"
                            : "Open motion settings"
                        }
                      >
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.optionRow}>
                      <span className={styles.optionIcon} aria-hidden="true">
                        <Music2 size={24} />
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
                      : locale.startsWith("fr")
                        ? "Générer le rendu"
                        : "Generate render"}
                    <ArrowRight size={20} aria-hidden="true" />
                  </button>
                  {elevenLabsEnabled && !adaptedMusicAuthorized ? (
                    <button
                      type="button"
                      className={styles.rightsReminder}
                      onClick={() => {
                        if (productionRightsRef.current) {
                          productionRightsRef.current.open = true;
                          productionRightsRef.current.scrollIntoView({
                            block: "nearest",
                            behavior: "smooth",
                          });
                        }
                      }}
                    >
                      {locale.startsWith("fr")
                        ? "Confirmer les droits musicaux pour continuer"
                        : "Confirm music rights to continue"}
                    </button>
                  ) : null}
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
                  <details
                    className={styles.productionDisclosure}
                    ref={productionSettingsRef}
                  >
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
                          setMotionTemplate(
                            event.target.value as MotionTemplate,
                          )
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
                  <details
                    className={styles.productionDisclosure}
                    ref={productionRightsRef}
                  >
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
                </>
              ) : (
                <>
                  <div className={styles.inspectorTitleRow}>
                    <span>
                      {studio.previewTitle}{" "}
                      <span className={styles.previewRatio}>(9:16)</span>
                    </span>
                    <Video size={17} aria-hidden="true" />
                  </div>
                  <div className={cn(styles.previewCard, styles.previewEmpty)}>
                    <div className={styles.previewPlaceholder}>
                      <CirclePlay
                        size={42}
                        strokeWidth={1.3}
                        aria-hidden="true"
                      />
                      <h2>{studio.previewEmpty}</h2>
                      <p>
                        {project
                          ? copy.awaitingCandidates
                          : studio.previewEmptyCopy}
                      </p>
                    </div>
                    <span className={styles.previewEmptyFormat}>
                      1080 × 1920 · 9:16
                    </span>
                  </div>
                  <div className={styles.productionHeading}>
                    <h2>{studio.productionOptions}</h2>
                    <LockKeyhole size={14} aria-hidden="true" />
                  </div>
                  <div
                    className={styles.optionStack}
                    aria-label={
                      locale.startsWith("fr")
                        ? "Disponible après la sélection"
                        : "Available after selection"
                    }
                  >
                    {[
                      [Subtitles, studio.subtitleOption, studio.subtitleDetail],
                      [Sparkles, studio.motionOption, studio.motionDetail],
                      [Music2, studio.musicOption, studio.musicDetail],
                    ].map(([Icon, title, detail]) => {
                      const OptionIcon = Icon as typeof Subtitles;
                      return (
                        <div
                          className={cn(
                            styles.optionRow,
                            styles.optionRowWaiting,
                          )}
                          key={title as string}
                        >
                          <span
                            className={styles.optionIcon}
                            aria-hidden="true"
                          >
                            <OptionIcon size={20} />
                          </span>
                          <span className={styles.optionCopy}>
                            <strong>{title as string}</strong>
                            <span>{detail as string}</span>
                          </span>
                          <LockKeyhole size={14} aria-hidden="true" />
                        </div>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className={styles.renderButton}
                    disabled
                  >
                    <Sparkles size={18} aria-hidden="true" />
                    {locale.startsWith("fr")
                      ? "Générer le rendu"
                      : "Generate render"}
                    <ArrowRight size={20} aria-hidden="true" />
                  </button>
                  <p className={styles.previewPrerequisite}>
                    {locale.startsWith("fr")
                      ? "Sélectionnez un extrait après l’analyse pour continuer."
                      : "Select an excerpt after analysis to continue."}
                  </p>
                  <div className={styles.youtubeRow}>
                    <span className={styles.youtubeIcon} aria-hidden="true">
                      <Play size={12} fill="currentColor" />
                    </span>
                    <span className={styles.youtubeCopy}>
                      <strong>YouTube · {studio.privateLabel}</strong>
                      <span>{studio.youtubeDetail}</span>
                    </span>
                    <LockKeyhole size={15} aria-hidden="true" />
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
