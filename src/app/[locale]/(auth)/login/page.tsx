"use client";

// ============================================================================
// Login minimal P1 — remplacé par l'auth UI complète en Phase 3.
// ============================================================================
// DEV-ONLY scaffold : email + password via supabase.auth.signInWithPassword
// with a sign-up toggle (signUp). Success → router.push("/clips"). Errors
// render inline. Neutral shadcn — no provider buttons, no forgot-password,
// no marketing split-screen.
// ============================================================================

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/i18n/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const supabase = createClient();
      if (mode === "signin") {
        const { error: err } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (err) {
          setError(err.message || t("error_generic"));
          return;
        }
        router.push("/clips");
        router.refresh();
      } else {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
        });
        if (err) {
          setError(err.message || t("error_generic"));
          return;
        }
        // Email confirmation ON → no session yet : surface the hint.
        if (!data.session) {
          setInfo(t("signup_success"));
          return;
        }
        router.push("/clips");
        router.refresh();
      }
    } catch {
      setError(t("error_generic"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-sm p-6">
        <CardHeader className="px-0 pt-0">
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="login-email"
              className="text-foreground text-sm font-medium"
            >
              {t("email_label")}
            </label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              placeholder={t("email_placeholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="login-password"
              className="text-foreground text-sm font-medium"
            >
              {t("password_label")}
            </label>
            <Input
              id="login-password"
              type="password"
              autoComplete={
                mode === "signin" ? "current-password" : "new-password"
              }
              required
              minLength={6}
              placeholder={t("password_placeholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          {info && (
            <p className="text-muted-foreground text-sm" role="status">
              {info}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading
              ? t("loading")
              : mode === "signin"
                ? t("submit_signin")
                : t("submit_signup")}
          </Button>

          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === "signin" ? "signup" : "signin"));
              setError(null);
              setInfo(null);
            }}
            className="text-muted-foreground w-full text-center text-xs underline-offset-4 hover:underline"
          >
            {mode === "signin" ? t("toggle_to_signup") : t("toggle_to_signin")}
          </button>

          <p className="text-muted-foreground/70 text-center text-[10px]">
            {t("dev_note")}
          </p>
        </form>
      </Card>
    </main>
  );
}
