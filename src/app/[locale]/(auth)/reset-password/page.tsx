"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeading } from "@/components/ui/PageHeading";
import { ClipsFlowBrand } from "@/components/ClipsFlowBrand";
import { useRouter } from "@/i18n/navigation";
import { validateRecoveryPassword } from "@/lib/auth/password-recovery";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const t = useTranslations("login");
  const router = useRouter();
  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(
    null,
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void createClient()
      .auth.getUser()
      .then(({ data, error: authError }) => {
        if (!cancelled) setHasRecoverySession(!authError && Boolean(data.user));
      })
      .catch(() => {
        if (!cancelled) setHasRecoverySession(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const validationError = validateRecoveryPassword(password, confirmation);
    if (validationError) {
      setError(
        t(
          validationError === "too_short"
            ? "password_too_short"
            : "password_mismatch",
        ),
      );
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await createClient().auth.updateUser({
        password,
      });

      if (updateError) {
        setError(t("password_update_error"));
        return;
      }

      setComplete(true);
    } catch {
      setError(t("password_update_error"));
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
              title={t("recovery_title")}
              description={t("reset_password_description")}
              titleSize="compact"
              className="gap-1"
            />
          </CardHeader>

          {hasRecoverySession === null ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t("checking_recovery_link")}
            </p>
          ) : hasRecoverySession === false ? (
            <div className="space-y-4">
              <p className="text-destructive text-sm" role="alert">
                {t("recovery_invalid")}
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={() => router.push("/login")}
              >
                {t("back_to_login")}
              </Button>
            </div>
          ) : complete ? (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm" role="status">
                {t("password_updated")}
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  router.push("/clips");
                  router.refresh();
                }}
              >
                {t("continue_to_clips")}
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="new-password"
                  className="text-foreground text-sm font-medium"
                >
                  {t("new_password_label")}
                </label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="confirm-password"
                  className="text-foreground text-sm font-medium"
                >
                  {t("confirm_password_label")}
                </label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>

              {error && (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t("loading") : t("update_password_submit")}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
