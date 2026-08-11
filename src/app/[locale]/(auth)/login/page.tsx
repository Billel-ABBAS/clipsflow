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

        {/* Google OAuth */}
        <Button
          type="button"
          variant="outline"
          className="mb-4 w-full"
          onClick={() => {
            window.location.href = "/api/auth/google";
          }}
        >
          <span className="mr-2 h-4 w-4">
            <svg
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
          </span>
          Continue with Google
        </Button>

        <div className="relative mb-4">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">
              Or continue with email
            </span>
          </div>
        </div>

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
