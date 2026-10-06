"use client";

import { useState } from "react";
import { Bookmark, Check, Pencil, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/i18n/navigation";

export interface ClipCollectionOption {
  id: string;
  name: string;
}

interface ClipLibraryControlsProps {
  clipId: string;
  title: string | null;
  isFavorite: boolean;
  collectionId: string | null;
  collections: ClipCollectionOption[];
}

export function ClipLibraryControls({
  clipId,
  title,
  isFavorite: initialFavorite,
  collectionId: initialCollectionId,
  collections: initialCollections,
}: ClipLibraryControlsProps) {
  const t = useTranslations("clips.library");
  const router = useRouter();
  const [favorite, setFavorite] = useState(initialFavorite);
  const [titleValue, setTitleValue] = useState(title ?? "");
  const [collectionId, setCollectionId] = useState(initialCollectionId ?? "");
  const [collections, setCollections] = useState(initialCollections);
  const [editingTitle, setEditingTitle] = useState(false);
  const [newCollection, setNewCollection] = useState("");
  const [busy, setBusy] = useState(false);

  const updateMetadata = async (patch: {
    title_override?: string | null;
    is_favorite?: boolean;
  }) => {
    const response = await fetch(`/api/clips/${clipId}/metadata`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error("metadata_update_failed");
  };

  const toggleFavorite = async () => {
    const next = !favorite;
    setBusy(true);
    try {
      await updateMetadata({ is_favorite: next });
      setFavorite(next);
      router.refresh();
    } catch {
      toast.error(t("save_error"));
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = titleValue.trim() || null;
    setBusy(true);
    try {
      await updateMetadata({ title_override: next });
      setTitleValue(next ?? "");
      setEditingTitle(false);
      router.refresh();
      toast.success(t("saved"));
    } catch {
      toast.error(t("save_error"));
    } finally {
      setBusy(false);
    }
  };

  const assignCollection = async (next: string) => {
    const response = await fetch(`/api/clips/${clipId}/collection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection_id: next || null }),
    });
    if (!response.ok) throw new Error("collection_update_failed");
    setCollectionId(next);
    router.refresh();
  };

  const saveCollection = async (next: string) => {
    setBusy(true);
    try {
      await assignCollection(next);
    } catch {
      toast.error(t("save_error"));
    } finally {
      setBusy(false);
    }
  };

  const createCollection = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newCollection.trim();
    if (!name) return;
    setBusy(true);
    try {
      const response = await fetch("/api/clips/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json()) as {
        data?: ClipCollectionOption;
      };
      if (!response.ok || !result.data?.id) {
        throw new Error("collection_create_failed");
      }
      setCollections((current) => [...current, result.data!]);
      setNewCollection("");
      await assignCollection(result.data.id);
      toast.success(t("collection_created"));
    } catch {
      toast.error(t("save_error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={toggleFavorite}
        disabled={busy}
        aria-pressed={favorite}
        aria-label={favorite ? t("unfavorite") : t("favorite")}
        title={favorite ? t("unfavorite") : t("favorite")}
      >
        <Star
          className={`h-4 w-4 ${favorite ? "fill-amber-400 text-amber-500" : ""}`}
        />
      </Button>

      {editingTitle ? (
        <form onSubmit={saveTitle} className="flex min-w-0 flex-1 gap-1.5">
          <Input
            value={titleValue}
            onChange={(event) => setTitleValue(event.target.value)}
            maxLength={120}
            aria-label={t("title_label")}
            placeholder={t("title_placeholder")}
            autoFocus
          />
          <Button
            type="submit"
            size="icon"
            disabled={busy}
            aria-label={t("save")}
          >
            <Check className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setEditingTitle(true)}
          disabled={busy}
          className="gap-1.5"
        >
          <Pencil className="h-3.5 w-3.5" />
          {t("rename")}
        </Button>
      )}

      <label className="flex items-center gap-1.5 text-xs">
        <Bookmark className="text-muted-foreground h-3.5 w-3.5" />
        <span className="sr-only">{t("collection_label")}</span>
        <select
          aria-label={t("collection_label")}
          value={collectionId}
          disabled={busy}
          onChange={(event) => void saveCollection(event.target.value)}
          className="border-border bg-background text-foreground max-w-40 rounded-md border px-2 py-1.5"
        >
          <option value="">{t("no_collection")}</option>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
      </label>

      <form onSubmit={createCollection} className="flex min-w-0 flex-1 gap-1.5">
        <Input
          value={newCollection}
          onChange={(event) => setNewCollection(event.target.value)}
          maxLength={80}
          aria-label={t("new_collection")}
          placeholder={t("new_collection")}
          className="h-8"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={busy || !newCollection.trim()}
        >
          {t("create_collection")}
        </Button>
      </form>
    </div>
  );
}
