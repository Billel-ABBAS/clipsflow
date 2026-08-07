// ============================================================================
// Tests unitaires — overlays.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  buildTitleCardDialogue,
  buildLowerThirdDialogue,
  buildStatCalloutDialogue,
  buildCtaOutroDialogue,
  buildLogoOverlayFilter,
  buildOverlays,
  type TitleCard,
  type LowerThird,
  type StatCallout,
  type CtaOutro,
  type LogoReveal,
} from "./overlays";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TITLE_CARD: TitleCard = {
  type: "title_card",
  text: "Hello World",
  startSec: 0,
  endSec: 3,
};

const LOWER_THIRD: LowerThird = {
  type: "lower_third",
  name: "Jean Dupont",
  role: "CEO",
  startSec: 1,
  endSec: 5,
};

const STAT: StatCallout = {
  type: "stat_callout",
  value: "10K",
  label: "subscribers",
  startSec: 2,
  endSec: 6,
};

const CTA: CtaOutro = {
  type: "cta_outro",
  text: "Subscribe ↗",
  startSec: 28,
  endSec: 30,
};

const LOGO: LogoReveal = {
  type: "logo_reveal",
  logoUrl: "https://example.com/logo.png",
  startSec: 0,
  endSec: 30,
};

// ---------------------------------------------------------------------------
// buildTitleCardDialogue
// ---------------------------------------------------------------------------
describe("buildTitleCardDialogue", () => {
  it("commence par 'Dialogue: 1,'", () => {
    const d = buildTitleCardDialogue(TITLE_CARD);
    expect(d).toMatch(/^Dialogue: 1,/);
  });

  it("contient les timestamps start et end au format ASS", () => {
    const d = buildTitleCardDialogue(TITLE_CARD);
    // start=0 → 0:00:00.00, end=3 → 0:00:03.00
    expect(d).toContain("0:00:00.00");
    expect(d).toContain("0:00:03.00");
  });

  it("contient le texte du titre", () => {
    const d = buildTitleCardDialogue(TITLE_CARD);
    expect(d).toContain("Hello World");
  });

  it("contient le sous-titre si fourni", () => {
    const d = buildTitleCardDialogue({
      ...TITLE_CARD,
      subtitle: "My subtitle",
    });
    expect(d).toContain("My subtitle");
  });

  it("ne contient pas de sous-titre si absent", () => {
    const d = buildTitleCardDialogue(TITLE_CARD);
    // Pas de \\N (newline ASS) pour le sous-titre
    // Le sous-titre crée "\\N{\\fs50}" dans la chaîne
    expect(d).not.toContain("\\fs50");
  });

  it("inclut la couleur de texte en format ASS BGR", () => {
    const d = buildTitleCardDialogue({ ...TITLE_CARD, color: "#FF0000" });
    // #FF0000 → &H0000FF&
    expect(d).toContain("&H0000FF&");
  });

  it("contient fade et animation scale", () => {
    const d = buildTitleCardDialogue(TITLE_CARD);
    expect(d).toContain("\\fad(");
    expect(d).toContain("\\fscx");
  });

  it("start < end dans le timestamp", () => {
    const d = buildTitleCardDialogue(TITLE_CARD);
    // Le format est "Dialogue: 1,START,END,..."
    const parts = d.split(",");
    const start = parts[1]!;
    const end = parts[2]!;
    expect(start).toBe("0:00:00.00");
    expect(end).toBe("0:00:03.00");
  });
});

// ---------------------------------------------------------------------------
// buildLowerThirdDialogue
// ---------------------------------------------------------------------------
describe("buildLowerThirdDialogue", () => {
  it("commence par 'Dialogue: 2,'", () => {
    const d = buildLowerThirdDialogue(LOWER_THIRD);
    expect(d).toMatch(/^Dialogue: 2,/);
  });

  it("contient le nom du speaker", () => {
    const d = buildLowerThirdDialogue(LOWER_THIRD);
    expect(d).toContain("Jean Dupont");
  });

  it("contient le rôle si fourni", () => {
    const d = buildLowerThirdDialogue(LOWER_THIRD);
    expect(d).toContain("CEO");
  });

  it("ne contient pas de rôle si absent", () => {
    const d = buildLowerThirdDialogue({ ...LOWER_THIRD, role: undefined });
    expect(d).not.toContain("CEO");
  });

  it("contient le slide-in \move(", () => {
    const d = buildLowerThirdDialogue(LOWER_THIRD);
    expect(d).toContain("\\move(");
  });

  it("utilise slideInMs custom", () => {
    const d = buildLowerThirdDialogue({ ...LOWER_THIRD, slideInMs: 800 });
    // La valeur 800 doit apparaître dans le \move(...)
    expect(d).toContain("800");
  });

  it("timestamps corrects (start=1, end=5)", () => {
    const d = buildLowerThirdDialogue(LOWER_THIRD);
    expect(d).toContain("0:00:01.00");
    expect(d).toContain("0:00:05.00");
  });
});

// ---------------------------------------------------------------------------
// buildStatCalloutDialogue
// ---------------------------------------------------------------------------
describe("buildStatCalloutDialogue", () => {
  it("commence par 'Dialogue: 3,'", () => {
    const d = buildStatCalloutDialogue(STAT);
    expect(d).toMatch(/^Dialogue: 3,/);
  });

  it("contient la valeur '10K'", () => {
    const d = buildStatCalloutDialogue(STAT);
    expect(d).toContain("10K");
  });

  it("contient le label si fourni", () => {
    const d = buildStatCalloutDialogue(STAT);
    expect(d).toContain("subscribers");
  });

  it("positionnement top-right par défaut (\\an9)", () => {
    const d = buildStatCalloutDialogue(STAT);
    expect(d).toContain("\\an9");
  });

  it("positionnement top-left (\\an7)", () => {
    const d = buildStatCalloutDialogue({ ...STAT, position: "top-left" });
    expect(d).toContain("\\an7");
  });

  it("positionnement center (\\an5)", () => {
    const d = buildStatCalloutDialogue({ ...STAT, position: "center" });
    expect(d).toContain("\\an5");
  });

  it("positionnement bottom-left (\\an1)", () => {
    const d = buildStatCalloutDialogue({ ...STAT, position: "bottom-left" });
    expect(d).toContain("\\an1");
  });

  it("contient animation (\\fad)", () => {
    const d = buildStatCalloutDialogue(STAT);
    expect(d).toContain("\\fad(");
  });

  it("utilise la couleur gold (#FFD700) par défaut converti en ASS", () => {
    const d = buildStatCalloutDialogue({ ...STAT, color: undefined });
    // #FFD700 → BB=00 GG=D7 RR=FF → &H00D7FF&
    expect(d).toContain("&H00D7FF&");
  });
});

// ---------------------------------------------------------------------------
// buildCtaOutroDialogue
// ---------------------------------------------------------------------------
describe("buildCtaOutroDialogue", () => {
  it("commence par 'Dialogue: 4,'", () => {
    const d = buildCtaOutroDialogue(CTA);
    expect(d).toMatch(/^Dialogue: 4,/);
  });

  it("contient le texte CTA", () => {
    const d = buildCtaOutroDialogue(CTA);
    expect(d).toContain("Subscribe");
  });

  it("contient la couleur cyan (#22D3EE) de ClipsFlow en ASS", () => {
    const d = buildCtaOutroDialogue(CTA);
    // #22D3EE → BB=EE GG=D3 RR=22 → &HEED322&
    expect(d).toContain("&HEED322&");
  });

  it("contient l'animation \\move(", () => {
    const d = buildCtaOutroDialogue(CTA);
    expect(d).toContain("\\move(");
  });

  it("alignement centré-bas (\\an2)", () => {
    const d = buildCtaOutroDialogue(CTA);
    expect(d).toContain("\\an2");
  });

  it("timestamps corrects (start=28, end=30)", () => {
    const d = buildCtaOutroDialogue(CTA);
    expect(d).toContain("0:00:28.00");
    expect(d).toContain("0:00:30.00");
  });

  it("échappe les accolades dans le texte CTA", () => {
    const d = buildCtaOutroDialogue({
      ...CTA,
      text: "Join {us}!",
    });
    // Les {} doivent être échappées
    expect(d).toContain("\\{us\\}");
  });
});

// ---------------------------------------------------------------------------
// buildLogoOverlayFilter
// ---------------------------------------------------------------------------
describe("buildLogoOverlayFilter", () => {
  it("retourne le logoUrl d'origine", () => {
    const plan = buildLogoOverlayFilter(LOGO, 30);
    expect(plan.logoUrl).toBe("https://example.com/logo.png");
  });

  it("filterExpr est une fonction", () => {
    const plan = buildLogoOverlayFilter(LOGO, 30);
    expect(typeof plan.filterExpr).toBe("function");
  });

  it("filterExpr(0) contient 'scale' et 'overlay'", () => {
    const plan = buildLogoOverlayFilter(LOGO, 30);
    const expr = plan.filterExpr(0);
    expect(expr).toContain("scale=");
    expect(expr).toContain("overlay=");
  });

  it("positionnement top-right par défaut (main_w-overlay_w-...)", () => {
    const plan = buildLogoOverlayFilter(LOGO, 30);
    const expr = plan.filterExpr(0);
    expect(expr).toContain("main_w-overlay_w");
  });

  it("positionnement top-left (margin uniquement)", () => {
    const plan = buildLogoOverlayFilter({ ...LOGO, position: "top-left" }, 30);
    const expr = plan.filterExpr(1);
    // En top-left, x=main_w*0.04 (margin uniquement, pas de soustraction)
    expect(expr).toContain("main_w*0.04");
    // Ne doit pas avoir la soustraction du logo width
    expect(expr).not.toContain("main_w-overlay_w");
  });

  it("le between(t,...) contient les secondes de début et fin", () => {
    const plan = buildLogoOverlayFilter(
      { ...LOGO, startSec: 5, endSec: 25 },
      30,
    );
    const expr = plan.filterExpr(0);
    expect(expr).toContain("5.00");
    expect(expr).toContain("25.00");
  });
});

// ---------------------------------------------------------------------------
// buildOverlays — agrégateur
// ---------------------------------------------------------------------------
describe("buildOverlays", () => {
  it("retourne des tableaux vides pour undefined", () => {
    const result = buildOverlays(undefined, 30);
    expect(result.assDialogues).toHaveLength(0);
    expect(result.logoPlans).toHaveLength(0);
  });

  it("retourne des tableaux vides pour []", () => {
    const result = buildOverlays([], 30);
    expect(result.assDialogues).toHaveLength(0);
    expect(result.logoPlans).toHaveLength(0);
  });

  it("titre → assDialogues +1, logoPlans +0", () => {
    const result = buildOverlays([TITLE_CARD], 30);
    expect(result.assDialogues).toHaveLength(1);
    expect(result.logoPlans).toHaveLength(0);
  });

  it("logo_reveal → logoPlans +1, assDialogues +0", () => {
    const result = buildOverlays([LOGO], 30);
    expect(result.assDialogues).toHaveLength(0);
    expect(result.logoPlans).toHaveLength(1);
  });

  it("4 overlays non-logo → assDialogues.length=4", () => {
    const result = buildOverlays([TITLE_CARD, LOWER_THIRD, STAT, CTA], 30);
    expect(result.assDialogues).toHaveLength(4);
    expect(result.logoPlans).toHaveLength(0);
  });

  it("mélange logo + non-logo", () => {
    const result = buildOverlays([TITLE_CARD, LOGO, CTA], 30);
    expect(result.assDialogues).toHaveLength(2); // title + cta
    expect(result.logoPlans).toHaveLength(1); // logo
  });
});
