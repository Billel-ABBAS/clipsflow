import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  BadgeCheck,
  BadgeDollarSign,
  Clapperboard,
  Clock3,
  Film,
  Layers3,
  LoaderCircle,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardTitle } from "@/components/ui/card";
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

type MetricTone = "primary" | "cyan" | "mint" | "coral";

const METRIC_TONES: Record<MetricTone, string> = {
  primary: "bg-primary/10 text-primary",
  cyan: "bg-chart-3/10 text-chart-3",
  mint: "bg-chart-2/10 text-chart-2",
  coral: "bg-chart-4/10 text-chart-4",
};

function MetricCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: MetricTone;
}) {
  return (
    <Card
      className="border-border/80 bg-card/80 hover:border-primary/30 transition-colors"
      size="sm"
    >
      <CardContent className="flex items-start justify-between gap-3 pt-3">
        <div className="min-w-0">
          <CardTitle className="text-muted-foreground truncate">
            {label}
          </CardTitle>
          <p className="font-heading mt-2 text-3xl font-semibold tabular-nums">
            {value}
          </p>
        </div>
        <span
          aria-hidden="true"
          className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg ${METRIC_TONES[tone]}`}
        >
          <Icon className="size-[18px]" />
        </span>
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
      <header className="border-border/80 from-card via-card to-primary/10 relative overflow-hidden rounded-xl border bg-gradient-to-br p-5 sm:p-7">
        <div
          aria-hidden="true"
          className="bg-primary/10 absolute -top-20 -right-16 size-56 rounded-full blur-3xl"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl space-y-2.5">
            <p className="text-primary text-[10px] font-semibold tracking-[0.2em] uppercase">
              CLIPSFLOW · {isFrench ? "OPÉRATIONS" : "OPERATIONS"}
            </p>
            <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              {isFrench ? "Administration" : "Admin console"}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed sm:text-base">
              {isFrench
                ? "Vue opérationnelle privée de ClipsFlow. Les données détaillées des utilisateurs ne sont pas exposées ici."
                : "Private ClipsFlow operations overview. Detailed user records are not exposed here."}
            </p>
          </div>
          <span className="border-chart-2/30 bg-chart-2/10 text-chart-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium">
            <ShieldCheck aria-hidden="true" className="size-4" />
            {isFrench ? "Accès administrateur" : "Admin access"}
          </span>
        </div>
      </header>

      <section aria-labelledby="admin-account-heading" className="space-y-3">
        <div className="flex items-center gap-2.5">
          <ShieldCheck aria-hidden="true" className="text-primary size-4" />
          <h2
            id="admin-account-heading"
            className="font-heading text-lg font-semibold"
          >
            {isFrench ? "Ton accès" : "Your access"}
          </h2>
        </div>
        <Card className="border-border/80 bg-card/70">
          <CardContent className="grid gap-5 pt-4 sm:grid-cols-3">
            <div className="min-w-0">
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Compte" : "Account"}
              </p>
              <p className="mt-1 truncate font-medium">{user.email}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Forfait effectif" : "Effective plan"}
              </p>
              <p className="mt-1 inline-flex items-center gap-2 font-medium">
                <span className="bg-primary/15 text-primary inline-flex size-6 items-center justify-center rounded-md">
                  <BadgeCheck aria-hidden="true" className="size-4" />
                </span>
                {planLabel}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Facturation" : "Billing"}
              </p>
              <p className="text-foreground/90 mt-1 leading-relaxed font-medium">
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
        <div className="flex items-center gap-2.5">
          <Layers3 aria-hidden="true" className="text-primary size-4" />
          <h2
            id="admin-overview-heading"
            className="font-heading text-lg font-semibold"
          >
            {isFrench ? "Vue d’ensemble" : "Overview"}
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label={isFrench ? "Comptes" : "Accounts"}
            value={formatCount(users.count)}
            icon={Users}
            tone="primary"
          />
          <MetricCard
            label={isFrench ? "Clips" : "Clips"}
            value={formatCount(clips.count)}
            icon={Film}
            tone="cyan"
          />
          <MetricCard
            label={isFrench ? "Tâches" : "Jobs"}
            value={formatCount(jobs.count)}
            icon={Clapperboard}
            tone="mint"
          />
          <MetricCard
            label={isFrench ? "Tâches en échec" : "Failed jobs"}
            value={formatCount(failedJobs.count)}
            icon={AlertTriangle}
            tone="coral"
          />
          <MetricCard
            label={isFrench ? "Rendus en attente" : "Queued renders"}
            value={formatCount(queuedRenders.count)}
            icon={Clock3}
            tone="cyan"
          />
          <MetricCard
            label={isFrench ? "Rendus en cours" : "Renders processing"}
            value={formatCount(processingRenders.count)}
            icon={LoaderCircle}
            tone="primary"
          />
          <MetricCard
            label={isFrench ? "Clips en finalisation" : "Clips finalizing"}
            value={formatCount(
              finalizingRenders.error ? null : finalizingRenderCount,
            )}
            icon={BadgeCheck}
            tone="mint"
          />
        </div>
      </section>

      <section aria-labelledby="admin-render-heading" className="space-y-3">
        <div className="flex items-center gap-2.5">
          <BadgeDollarSign aria-hidden="true" className="text-primary size-4" />
          <h2
            id="admin-render-heading"
            className="font-heading text-lg font-semibold"
          >
            {isFrench ? "Traitement des clips" : "Clip processing"}
          </h2>
        </div>
        <Card className="border-border/80 bg-card/70" size="sm">
          <CardContent className="grid gap-5 pt-3 sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <ShieldCheck aria-hidden="true" className="size-4" />
                {isFrench ? "Garde budgétaire" : "Budget guard"}
              </p>
              <p className="mt-2">
                {budget.error || !budget.data ? (
                  <span className="text-muted-foreground border-border inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium">
                    {isFrench ? "État indisponible" : "Status unavailable"}
                  </span>
                ) : (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${budget.data.enabled ? "border-chart-2/30 bg-chart-2/10 text-chart-2" : "border-chart-4/30 bg-chart-4/10 text-chart-4"}`}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-current"
                    />
                    {budget.data.enabled
                      ? isFrench
                        ? "Activée"
                        : "Enabled"
                      : isFrench
                        ? "Désactivée"
                        : "Disabled"}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">
                {isFrench ? "Plafond mensuel" : "Monthly cap"}
              </p>
              <p className="font-heading mt-1 text-lg font-semibold tabular-nums">
                {budgetLabel}
              </p>
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
        <Card className="border-border/80 bg-card/70" size="sm">
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
              <ul className="space-y-2">
                {recentFailures.map((failure) => (
                  <li
                    key={failure.id}
                    className="border-border/70 bg-background/45 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="bg-chart-4/10 text-chart-4 mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md">
                        <AlertTriangle aria-hidden="true" className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {failureLabel(failure.error_message)}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {failure.type} · {isFrench ? "tentative" : "attempt"}{" "}
                          {failure.attempt_count}
                        </p>
                      </div>
                    </div>
                    <time
                      dateTime={failure.created_at}
                      className="text-muted-foreground pl-11 text-xs sm:pl-0"
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
