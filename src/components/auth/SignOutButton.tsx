"use client";

// ============================================================================
// SignOutButton — minimal sign-out control for the dashboard shell (P1).
// supabase.auth.signOut() then router.refresh() : the (dashboard) layout
// re-runs its server-side getUser() and redirects to /login.
// ============================================================================

import { useState } from "react";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const handleSignOut = async () => {
    setBusy(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } finally {
      router.refresh();
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleSignOut}
      disabled={busy}
      className="text-muted-foreground gap-1.5"
    >
      <LogOut className="h-4 w-4" />
      {label}
    </Button>
  );
}
