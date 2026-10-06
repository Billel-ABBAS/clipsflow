import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isCurrentRenderFinalizing } from "@/lib/clips/history-query";
import { resolvePlan } from "@/lib/clips/quota";
import { hasAdminAccess } from "@/lib/security/admin-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PLAN_LABELS: Record<string, { fr: string; en: string }> = {
  free: { fr: "Gratuit", en: "Free" },
  solo: { fr: "Solo", en: "Solo" },
  pro: { fr: "Pro", en: "Pro" },
  studio: { fr: "Studio · forfait maximum", en: "Studio · top plan" },
};

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-heading text-3xl font-semibold tabular-nums">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const isFrench = locale === "fr";
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user || !hasAdminAccess(user)) {
    notFound();
  }

  const admin = createAdminClient();
  const [
    { data: profile, error: profileError },
    users,
    clips,
    jobs,
    failedJobs,
    queuedRenders,
    processingRenders,
    finalizingRenders,
    budget,
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("email, plan, stripe_subscription_id")
      .eq("id", user.id)
      .maybeSingle(),
    admin.from("profiles").select("id", { count: "exact", head: true }),
    admin.from("clips").select("id", { count: "exact", head: true }),
    admin.from("jobs").select("id", { count: "exact", head: true }),
    admin
      .from("jobs")
      .select("id, type, attempt_count, created_at, error_message", {
        count: "exact",
      })
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(10),
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("type", "render")
      .eq("status", "pending"),
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("type", "render")
      .eq("status", "processing"),
    admin
      .from("jobs")
      .select("id, attempt_count, render_stage, render_stage_attempt_count")
      .eq("type", "render")
      .eq("status", "processing")
      .eq("render_stage", "completing"),
    admin
      .from("clips_budget_guard")
      .select("enabled, monthly_budget_usd")
      .eq("singleton", true)
      .maybeSingle(),
  ]);

  if (profileError || !profile) {
    notFound();
  }

  const numberFormat = new Intl.NumberFormat(isFrench ? "fr-FR" : "en-US");
  const formatCount = (count: number | null) =>
    count === null ? "—" : numberFormat.format(count);
  const plan = resolvePlan(profile);
  const planLabel = PLAN_LABELS[plan][isFrench ? "fr" : "en"];
  const budgetLimit = budget.data?.monthly_budget_usd;
  const budgetLabel =
    budget.error || !budget.data
      ? isFrench
        ? "Indisponible"
        : "Unavailable"
      : budgetLimit === null
        ? isFrench
          ? "Non défini"
          : "Not set"
        : `$${Number(budgetLimit).toFixed(2)}`;
  const recentFailures = (failedJobs.data ?? []) as {
    id: string;
    type: string;
    attempt_count: number;
    created_at: string;
    error_message: string | null;
  }[];
  const finalizingRenderCount = (finalizingRenders.data ?? []).filter((job) =>
    isCurrentRenderFinalizing(
      "processing",
      "render",
      job.render_stage,
      job.render_stage_attempt_count,
      job.attempt_count,
    ),
  ).length;
  const failureLabel = (message: string | null) => {
    if (!message)
      return isFrench ? "Erreur non détaillée" : "Unspecified error";
    const safeCodes = [
      "worker_interrupted",
      "source_too_large",
      "no_speech_detected",
      "invalid_source_url",
      "segment_too_long",
      "whisper_failed",
      "subtitle_burn_failed",
      "upload_failed",
    ];
    const code = safeCodes.find((candidate) =>
      message.startsWith(`${candidate}:`),
    );
    return code ?? (isFrench ? "Échec du traitement" : "Processing failed");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {isFrench ? "Administration" : "Admin console"}
          </h1>
          <span className="rounded-full border px-2.5 py-1 text-xs font-medium">
            ADMIN
          </span>
        </div>
        <p className="text-muted-foreground">
          {isFrench
            ? "Vue opérationnelle privée de ClipsFlow. Les données détaillées des utilisateurs ne sont pas exposées ici."
            : "Private ClipsFlow operations overview. Detailed user records are not exposed here."}
        </p>
      </header>

      <section aria-labelledby="admin-account-heading" className="space-y-3">
        <h2
          id="admin-account-heading"
          className="font-heading text-xl font-medium"
        >
          {isFrench ? "Ton accès" : "Your access"}
        </h2>
        <Card>
          <CardContent className="grid gap-4 pt-4 sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Compte" : "Account"}
              </p>
              <p className="mt-1 font-medium">{user.email}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Forfait effectif" : "Effective plan"}
              </p>
              <p className="mt-1 font-medium">{planLabel}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Facturation" : "Billing"}
              </p>
              <p className="mt-1 font-medium">
                {!profile.stripe_subscription_id
                  ? isFrench
                    ? "Accès attribué manuellement · sans abonnement Stripe"
                    : "Manually granted · no Stripe subscription"
                  : isFrench
                    ? "Forfait lié à l’abonnement"
                    : "Subscription-backed plan"}
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="admin-overview-heading" className="space-y-3">
        <h2
          id="admin-overview-heading"
          className="font-heading text-xl font-medium"
        >
          {isFrench ? "Vue d’ensemble" : "Overview"}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label={isFrench ? "Comptes" : "Accounts"}
            value={formatCount(users.count)}
          />
          <MetricCard
            label={isFrench ? "Clips" : "Clips"}
            value={formatCount(clips.count)}
          />
          <MetricCard
            label={isFrench ? "Tâches" : "Jobs"}
            value={formatCount(jobs.count)}
          />
          <MetricCard
            label={isFrench ? "Tâches en échec" : "Failed jobs"}
            value={formatCount(failedJobs.count)}
          />
          <MetricCard
            label={isFrench ? "Rendus en attente" : "Queued renders"}
            value={formatCount(queuedRenders.count)}
          />
          <MetricCard
            label={isFrench ? "Rendus en cours" : "Renders processing"}
            value={formatCount(processingRenders.count)}
          />
          <MetricCard
            label={isFrench ? "Clips en finalisation" : "Clips finalizing"}
            value={formatCount(
              finalizingRenders.error ? null : finalizingRenderCount,
            )}
          />
        </div>
      </section>

      <section aria-labelledby="admin-render-heading" className="space-y-3">
        <h2
          id="admin-render-heading"
          className="font-heading text-xl font-medium"
        >
          {isFrench ? "Traitement des clips" : "Clip processing"}
        </h2>
        <Card size="sm">
          <CardContent className="grid gap-4 pt-3 sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Garde budgétaire" : "Budget guard"}
              </p>
              <p className="mt-1 font-medium">
                {budget.error || !budget.data
                  ? isFrench
                    ? "État indisponible"
                    : "Status unavailable"
                  : budget.data.enabled
                    ? isFrench
                      ? "Activée"
                      : "Enabled"
                    : isFrench
                      ? "Désactivée"
                      : "Disabled"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Plafond mensuel" : "Monthly cap"}
              </p>
              <p className="mt-1 font-medium">{budgetLabel}</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="admin-failures-heading" className="space-y-3">
        <h2
          id="admin-failures-heading"
          className="font-heading text-xl font-medium"
        >
          {isFrench ? "Échecs récents" : "Recent failures"}
        </h2>
        <Card size="sm">
          <CardContent className="pt-3">
            {failedJobs.error ? (
              <p className="text-muted-foreground text-sm">
                {isFrench ? "État indisponible" : "Status unavailable"}
              </p>
            ) : recentFailures.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Aucun échec récent." : "No recent failures."}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {recentFailures.map((failure) => (
                  <li
                    key={failure.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {failureLabel(failure.error_message)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {failure.type} · {isFrench ? "tentative" : "attempt"}{" "}
                        {failure.attempt_count}
                      </p>
                    </div>
                    <time
                      dateTime={failure.created_at}
                      className="text-muted-foreground text-xs"
                    >
                      {new Intl.DateTimeFormat(isFrench ? "fr-FR" : "en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(failure.created_at))}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
