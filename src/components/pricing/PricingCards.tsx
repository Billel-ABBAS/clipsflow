"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";

interface PricingCardsProps {
  locale: string;
  isLoggedIn: boolean;
}

type PlanKey = "free" | "solo" | "pro" | "studio";

const plans: PlanKey[] = ["free", "solo", "pro", "studio"];

export function PricingCards({ locale, isLoggedIn }: PricingCardsProps) {
  const t = useTranslations("pricing");
  const router = useRouter();
  const [loading, setLoading] = useState<PlanKey | null>(null);
  async function handleSelect(plan: PlanKey) {
    if (plan === "free") {
      return;
    }
    if (!isLoggedIn) {
      router.push(`/${locale}/login`);
      return;
    }
    setLoading(plan);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (data.url) {
        router.push(data.url);
      } else {
        toast.error(data.error ?? t("checkout_error"));
      }
    } catch {
      toast.error(t("checkout_error"));
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {plans.map((plan) => (
        <Card key={plan} className="flex flex-col">
          <CardHeader>
            <CardTitle>{t(`${plan}.name`)}</CardTitle>
            <CardDescription>{t(`${plan}.tagline`)}</CardDescription>
            <div className="mt-2 text-3xl font-bold">
              {t(`${plan}.price`)}
            </div>
          </CardHeader>
          <CardContent className="flex-1">
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>{t(`${plan}.feature1`)}</li>
              <li>{t(`${plan}.feature2`)}</li>
              <li>{t(`${plan}.feature3`)}</li>
            </ul>
          </CardContent>
          <CardFooter>
            {plan === "free" ? (
              <Button variant="outline" className="w-full" onClick={() => router.push(`/${locale}/clips`)}>
                {t("free.cta")}
              </Button>
            ) : (
              <Button
                className="w-full"
                onClick={() => handleSelect(plan)}
                disabled={loading === plan}
              >
                {loading === plan ? t("loading") : t(`${plan}.cta`)}
              </Button>
            )}
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
