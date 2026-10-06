"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type YouTubeConnection = {
  id: string;
  channel_title: string;
  channel_id: string;
};

type PreparedPublication = {
  id: string;
  confirmation_token: string;
  channel_title: string;
  title: string;
  visibility: "private" | "unlisted" | "public";
  made_for_kids: boolean;
  contains_synthetic_media: boolean;
  notify_subscribers: boolean;
};

type PublicationStatus = "queued" | "uploading" | "published" | "failed";

const labels = {
  fr: {
    button: "Publier sur YouTube",
    title: "Préparer une publication YouTube",
    intro:
      "Vérifiez le canal, les métadonnées et la visibilité avant chaque envoi.",
    loading: "Chargement des comptes…",
    connect: "Connecter un compte YouTube",
    noChannel: "Aucun compte YouTube connecté.",
    close: "Fermer",
    channel: "Canal de destination",
    titleField: "Titre",
    description: "Description",
    tags: "Tags (un par ligne, facultatifs)",
    visibility: "Visibilité",
    private: "Privée",
    unlisted: "Non répertoriée",
    public: "Publique",
    madeForKids: "Cette vidéo est-elle conçue pour les enfants ?",
    choose: "Choisir une réponse…",
    yes: "Oui, conçue pour les enfants",
    no: "Non, pas conçue pour les enfants",
    synthetic:
      "Cette vidéo contient des images réalistes modifiées ou synthétiques.",
    notify: "Notifier les abonnés (désactivé par défaut)",
    publicIntent: "Je souhaite rendre cette vidéo publique sur YouTube.",
    prepare: "Préparer et afficher le récapitulatif",
    review: "Récapitulatif à confirmer",
    confirm: "Je confirme l’envoi vers le canal indiqué avec cette visibilité.",
    publish: "Confirmer et mettre en file d’envoi",
    queued:
      "Publication confirmée et mise en file. L’envoi sera repris par le worker.",
    uploading: "Envoi YouTube en cours…",
    published: "Vidéo envoyée sur YouTube.",
    failed: "La publication a échoué. Vérifiez le compte et réessayez.",
    error:
      "Impossible de préparer la publication. Vérifiez les champs et réessayez.",
    publicRequired: "Confirmez explicitement la visibilité publique.",
    kidsRequired: "Indiquez si le contenu est conçu pour les enfants.",
    loadingStatus: "Vérification de l’état…",
    privateOnlyNotice:
      "Les envois restent privés tant que le projet API YouTube n’a pas passé la vérification requise.",
  },
  en: {
    button: "Publish to YouTube",
    title: "Prepare a YouTube publication",
    intro: "Review the channel, metadata, and visibility before each upload.",
    loading: "Loading accounts…",
    connect: "Connect a YouTube account",
    noChannel: "No YouTube account connected.",
    close: "Close",
    channel: "Destination channel",
    titleField: "Title",
    description: "Description",
    tags: "Tags (one per line, optional)",
    visibility: "Visibility",
    private: "Private",
    unlisted: "Unlisted",
    public: "Public",
    madeForKids: "Is this video made for kids?",
    choose: "Choose an answer…",
    yes: "Yes, made for kids",
    no: "No, not made for kids",
    synthetic: "This video contains realistic altered or synthetic imagery.",
    notify: "Notify subscribers (off by default)",
    publicIntent: "I want to make this video public on YouTube.",
    prepare: "Prepare and review publication",
    review: "Review before confirming",
    confirm: "I confirm upload to the selected channel with this visibility.",
    publish: "Confirm and queue upload",
    queued:
      "Publication confirmed and queued. The worker will resume the upload.",
    uploading: "Uploading to YouTube…",
    published: "Video uploaded to YouTube.",
    failed: "Publication failed. Check the account and try again.",
    error: "Could not prepare the publication. Check the fields and try again.",
    publicRequired: "Explicitly confirm public visibility.",
    kidsRequired: "Tell us whether the content is made for kids.",
    loadingStatus: "Checking status…",
    privateOnlyNotice:
      "Uploads stay private until the YouTube API project has passed the required verification.",
  },
} as const;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => ({}));
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function YouTubePublishControl({
  clipId,
  clipTitle,
}: {
  clipId: string;
  clipTitle: string;
}) {
  const locale = useLocale();
  const copy = labels[locale === "fr" ? "fr" : "en"];
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<YouTubeConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [nonPrivateUploadsEnabled, setNonPrivateUploadsEnabled] =
    useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [title, setTitle] = useState(clipTitle.slice(0, 100));
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [visibility, setVisibility] = useState<
    "private" | "unlisted" | "public"
  >("private");
  const [madeForKids, setMadeForKids] = useState("");
  const [containsSyntheticMedia, setContainsSyntheticMedia] = useState(false);
  const [notifySubscribers, setNotifySubscribers] = useState(false);
  const [confirmPublicIntent, setConfirmPublicIntent] = useState(false);
  const [userConfirmed, setUserConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPublication | null>(null);
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const [status, setStatus] = useState<PublicationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/youtube/connections", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(readJson)
      .then((payload) => {
        const data = Array.isArray(payload.data) ? payload.data : [];
        const capabilities = payload.capabilities as
          | Record<string, unknown>
          | undefined;
        setNonPrivateUploadsEnabled(
          capabilities?.non_private_uploads_enabled === true,
        );
        const valid = data.filter(
          (entry): entry is YouTubeConnection =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as YouTubeConnection).id === "string" &&
            typeof (entry as YouTubeConnection).channel_id === "string" &&
            typeof (entry as YouTubeConnection).channel_title === "string",
        );
        setConnections(valid);
        setConnectionId((current) => current || valid[0]?.id || "");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(copy.error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingConnections(false);
      });
    return () => controller.abort();
  }, [copy.error, open]);

  useEffect(() => {
    if (!publicationId || status === "published" || status === "failed") return;
    let cancelled = false;
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/youtube/publications/${encodeURIComponent(publicationId)}`,
          { cache: "no-store" },
        );
        const payload = await readJson(response);
        const data = payload.data as Record<string, unknown> | undefined;
        if (
          response.ok &&
          data &&
          (data.status === "queued" ||
            data.status === "uploading" ||
            data.status === "published" ||
            data.status === "failed")
        ) {
          setStatus(data.status);
          finished = data.status === "published" || data.status === "failed";
        }
      } catch {
        // A transient poll error must not turn a queued upload into a failure.
      }
      if (!cancelled && !finished) timeout = setTimeout(poll, 5_000);
    };
    timeout = setTimeout(poll, 1_500);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [publicationId, status]);

  const prepare = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setStatus(null);
    if (!connectionId) {
      setError(copy.noChannel);
      return;
    }
    if (madeForKids !== "true" && madeForKids !== "false") {
      setError(copy.kidsRequired);
      return;
    }
    if (visibility === "public" && !confirmPublicIntent) {
      setError(copy.publicRequired);
      return;
    }
    try {
      const response = await fetch("/api/youtube/publications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clip_id: clipId,
          connection_id: connectionId,
          title,
          description,
          tags: tags
            .split(/\r?\n/u)
            .map((tag) => tag.trim())
            .filter(Boolean),
          visibility,
          confirm_public_intent: confirmPublicIntent,
          made_for_kids: madeForKids === "true",
          contains_synthetic_media: containsSyntheticMedia,
          notify_subscribers: notifySubscribers,
        }),
      });
      const payload = await readJson(response);
      const data = payload.data as Record<string, unknown> | undefined;
      const draft = data?.publication as Record<string, unknown> | undefined;
      if (
        !response.ok ||
        typeof data?.confirmation_token !== "string" ||
        typeof draft?.id !== "string" ||
        typeof draft.channel_title !== "string" ||
        typeof draft.title !== "string" ||
        (draft.visibility !== "private" &&
          draft.visibility !== "unlisted" &&
          draft.visibility !== "public") ||
        typeof draft.made_for_kids !== "boolean" ||
        typeof draft.contains_synthetic_media !== "boolean" ||
        typeof draft.notify_subscribers !== "boolean"
      ) {
        throw new Error("prepare_failed");
      }
      setPrepared({
        id: draft.id,
        confirmation_token: data.confirmation_token,
        channel_title: draft.channel_title,
        title: draft.title,
        visibility: draft.visibility,
        made_for_kids: draft.made_for_kids,
        contains_synthetic_media: draft.contains_synthetic_media,
        notify_subscribers: draft.notify_subscribers,
      });
      setUserConfirmed(false);
    } catch {
      setError(copy.error);
    }
  };

  const confirm = async () => {
    if (!prepared || !userConfirmed) return;
    setError(null);
    try {
      const response = await fetch(
        `/api/youtube/publications/${encodeURIComponent(prepared.id)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmation_token: prepared.confirmation_token,
            user_confirmed: true,
            confirm_public:
              prepared.visibility !== "public" || confirmPublicIntent,
          }),
        },
      );
      const payload = await readJson(response);
      const data = payload.data as Record<string, unknown> | undefined;
      if (!response.ok || typeof data?.id !== "string") {
        throw new Error("confirm_failed");
      }
      setPublicationId(data.id);
      setStatus("queued");
      setPrepared(null);
    } catch {
      setError(copy.error);
    }
  };

  const statusLabel =
    status === "queued"
      ? copy.queued
      : status === "uploading"
        ? copy.uploading
        : status === "published"
          ? copy.published
          : status === "failed"
            ? copy.failed
            : null;

  return (
    <>
      <button
        type="button"
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        onClick={() => {
          setError(null);
          setLoadingConnections(true);
          setOpen(true);
        }}
      >
        {copy.button}
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={`youtube-publish-title-${clipId}`}
            className="bg-background border-border max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto rounded-2xl border p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2
                  id={`youtube-publish-title-${clipId}`}
                  className="text-lg font-semibold"
                >
                  {copy.title}
                </h2>
                <p className="text-muted-foreground text-sm">{copy.intro}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground text-sm underline"
              >
                {copy.close}
              </button>
            </div>

            {statusLabel ? (
              <p
                role="status"
                className="border-border rounded-lg border p-3 text-sm"
              >
                {statusLabel}
              </p>
            ) : null}

            {prepared ? (
              <div className="space-y-4">
                <div className="border-border bg-muted/20 space-y-2 rounded-xl border p-4 text-sm">
                  <p className="font-semibold">{copy.review}</p>
                  <p>
                    {copy.channel}: {prepared.channel_title}
                  </p>
                  <p>
                    {copy.titleField}: {prepared.title}
                  </p>
                  <p>
                    {copy.visibility}: {copy[prepared.visibility]}
                  </p>
                  <p>
                    {copy.madeForKids}:{" "}
                    {prepared.made_for_kids ? copy.yes : copy.no}
                  </p>
                  {prepared.contains_synthetic_media ? (
                    <p>{copy.synthetic}</p>
                  ) : null}
                  {prepared.notify_subscribers ? <p>{copy.notify}</p> : null}
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={userConfirmed}
                    onChange={(event) => setUserConfirmed(event.target.checked)}
                    className="accent-primary mt-0.5 size-4"
                  />
                  <span>{copy.confirm}</span>
                </label>
                {error ? (
                  <p role="alert" className="text-destructive text-sm">
                    {error}
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={!userConfirmed}
                  onClick={() => void confirm()}
                  className={cn(buttonVariants(), "w-full")}
                >
                  {copy.publish}
                </button>
              </div>
            ) : !status ? (
              <>
                {loadingConnections ? (
                  <p className="text-muted-foreground text-sm">
                    {copy.loading}
                  </p>
                ) : connections.length === 0 ? (
                  <div className="space-y-3">
                    <p className="text-muted-foreground text-sm">
                      {copy.noChannel}
                    </p>
                    <a
                      href={`/api/youtube/oauth/start?return_path=${encodeURIComponent(`/${locale}/clips`)}`}
                      className={cn(buttonVariants({ variant: "outline" }))}
                    >
                      {copy.connect}
                    </a>
                  </div>
                ) : (
                  <form
                    onSubmit={(event) => void prepare(event)}
                    className="space-y-4"
                  >
                    <label className="block space-y-1 text-sm">
                      <span>{copy.channel}</span>
                      <select
                        value={connectionId}
                        onChange={(event) =>
                          setConnectionId(event.target.value)
                        }
                        className="border-input bg-background w-full rounded-md border px-3 py-2"
                        required
                      >
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.channel_title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{copy.titleField}</span>
                      <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        maxLength={100}
                        required
                        className="border-input bg-background w-full rounded-md border px-3 py-2"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{copy.description}</span>
                      <textarea
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        maxLength={5_000}
                        rows={3}
                        className="border-input bg-background w-full rounded-md border px-3 py-2"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{copy.tags}</span>
                      <textarea
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        rows={2}
                        className="border-input bg-background w-full rounded-md border px-3 py-2"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{copy.visibility}</span>
                      <select
                        value={visibility}
                        onChange={(event) => {
                          setVisibility(
                            event.target.value as typeof visibility,
                          );
                          setConfirmPublicIntent(false);
                        }}
                        className="border-input bg-background w-full rounded-md border px-3 py-2"
                      >
                        <option value="private">{copy.private}</option>
                        <option
                          value="unlisted"
                          disabled={!nonPrivateUploadsEnabled}
                        >
                          {copy.unlisted}
                        </option>
                        <option
                          value="public"
                          disabled={!nonPrivateUploadsEnabled}
                        >
                          {copy.public}
                        </option>
                      </select>
                    </label>
                    {!nonPrivateUploadsEnabled ? (
                      <p className="text-muted-foreground text-xs">
                        {copy.privateOnlyNotice}
                      </p>
                    ) : null}
                    <label className="block space-y-1 text-sm">
                      <span>{copy.madeForKids}</span>
                      <select
                        value={madeForKids}
                        onChange={(event) => setMadeForKids(event.target.value)}
                        className="border-input bg-background w-full rounded-md border px-3 py-2"
                        required
                      >
                        <option value="">{copy.choose}</option>
                        <option value="true">{copy.yes}</option>
                        <option value="false">{copy.no}</option>
                      </select>
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={containsSyntheticMedia}
                        onChange={(event) =>
                          setContainsSyntheticMedia(event.target.checked)
                        }
                        className="accent-primary mt-0.5 size-4"
                      />
                      <span>{copy.synthetic}</span>
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={notifySubscribers}
                        onChange={(event) =>
                          setNotifySubscribers(event.target.checked)
                        }
                        className="accent-primary mt-0.5 size-4"
                      />
                      <span>{copy.notify}</span>
                    </label>
                    {visibility === "public" ? (
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={confirmPublicIntent}
                          onChange={(event) =>
                            setConfirmPublicIntent(event.target.checked)
                          }
                          className="accent-primary mt-0.5 size-4"
                        />
                        <span>{copy.publicIntent}</span>
                      </label>
                    ) : null}
                    {error ? (
                      <p role="alert" className="text-destructive text-sm">
                        {error}
                      </p>
                    ) : null}
                    <button
                      type="submit"
                      className={cn(buttonVariants(), "w-full")}
                    >
                      {copy.prepare}
                    </button>
                  </form>
                )}
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
