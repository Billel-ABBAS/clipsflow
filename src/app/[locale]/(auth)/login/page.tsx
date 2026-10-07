"use client";

// Email + password authentication with sign-up and recovery. Successful
// sign-in resumes only an allow-listed in-app destination from the login URL.
// ============================================================================

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeading } from "@/components/ui/PageHeading";
import { ClipsFlowBrand } from "@/components/ClipsFlowBrand";
import { useRouter } from "@/i18n/navigation";
import { getPasswordRecoveryRedirectUrl } from "@/lib/auth/password-recovery";
import {
  getAuthCallbackRedirectUrl,
  getSafeAuthReturnPath,
} from "@/lib/auth/return-path";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup" | "recovery";

export default function LoginPage() {
  const t = useTranslations("login");
  const locale = useLocale();
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
    const returnPath = getSafeAuthReturnPath(
      new URLSearchParams(window.location.search).get("next"),
    );
    try {
      const supabase = createClient();
      if (mode === "recovery") {
        const { error: err } = await supabase.auth.resetPasswordForEmail(
          email,
          {
            redirectTo: getPasswordRecoveryRedirectUrl(
              process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin,
              locale,
            ),
          },
        );
        if (err) {
          setError(t("recovery_error"));
          return;
        }
        setInfo(t("recovery_sent"));
        return;
      }

      if (mode === "signin") {
        const { error: err } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (err) {
          setError(err.message || t("error_generic"));
          return;
        }
        router.push(returnPath);
        router.refresh();
      } else {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: getAuthCallbackRedirectUrl(
              process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin,
              returnPath,
              locale,
            ),
          },
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
        router.push(returnPath);
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
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <ClipsFlowBrand />
        <Card className="border-border/80 w-full p-6 shadow-[0_24px_80px_rgba(0,0,0,0.32)]">
          <CardHeader className="px-0 pt-0">
            <PageHeading
              alignment="start"
              title={mode === "recovery" ? t("recovery_title") : t("title")}
              description={
                mode === "recovery" ? t("recovery_description") : t("subtitle")
              }
              titleSize="compact"
              className="gap-1"
            />
          </CardHeader>

          {/* Google OAuth */}
          <Button
            type="button"
            variant="outline"
            className="mb-4 w-full"
            hidden={mode === "recovery"}
            onClick={() => {
              // OAuth must use a full-page navigation so the API route can set
              // cookies and redirect the browser to Google's authorization page.
              const searchParams = new URLSearchParams({
                next: getSafeAuthReturnPath(
                  new URLSearchParams(window.location.search).get("next"),
                ),
                locale,
              });
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.href = `/api/auth/google?${searchParams.toString()}`;
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
            {t("continue_with_google")}
          </Button>

          <div className="relative mb-4" hidden={mode === "recovery"}>
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card text-muted-foreground px-2">
                {t("or_continue_with_email")}
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5" hidden={mode === "recovery"}>
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
                required={mode !== "recovery"}
                disabled={mode === "recovery"}
                minLength={6}
                aria-describedby={
                  mode === "signup" ? "login-password-hint" : undefined
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode === "signup" && (
                <p
                  id="login-password-hint"
                  className="text-muted-foreground text-xs"
                >
                  {t("password_hint")}
                </p>
              )}
              {mode === "signin" && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("recovery");
                    setError(null);
                    setInfo(null);
                  }}
                  className="text-muted-foreground text-xs underline-offset-4 hover:underline"
                >
                  {t("forgot_password")}
                </button>
              )}
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
                : mode === "recovery"
                  ? t("recovery_submit")
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
              {mode === "signin" ? t("toggle_to_signup") : t("back_to_login")}
            </button>
          </form>
        </Card>
      </div>
    </main>
  );
}
