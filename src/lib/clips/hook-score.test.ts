// ============================================================================
// Tests unitaires — hook-score.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import { computeHookScore, firstSentence } from "./hook-score";

// ---------------------------------------------------------------------------
// firstSentence
// ---------------------------------------------------------------------------
describe("firstSentence", () => {
  it("retourne une chaîne vide pour une entrée vide", () => {
    expect(firstSentence("")).toBe("");
  });

  it("extrait la première phrase terminée par un point", () => {
    const result = firstSentence("Hello world. And more text here.");
    expect(result).toBe("Hello world.");
  });

  it("extrait la première phrase terminée par un ?", () => {
    const result = firstSentence("What is going on? Really amazing.");
    expect(result).toBe("What is going on?");
  });

  it("extrait la première phrase terminée par un !", () => {
    const result = firstSentence("Stop right now! You won't believe this.");
    expect(result).toBe("Stop right now!");
  });

  it("renvoie tout le début (200 chars) si pas de ponctuation terminale", () => {
    const text = "no punctuation here just words".repeat(3);
    const result = firstSentence(text);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("trim le résultat", () => {
    const result = firstSentence("  Hello world.  rest of text");
    expect(result).toBe("Hello world.");
  });
});

// ---------------------------------------------------------------------------
// computeHookScore — bornes 0-100
// ---------------------------------------------------------------------------
describe("computeHookScore — bornes", () => {
  it("retourne 0 pour null", () => {
    expect(computeHookScore(null)).toBe(0);
  });

  it("retourne 0 pour undefined", () => {
    expect(computeHookScore(undefined)).toBe(0);
  });

  it("retourne 0 pour une chaîne vide", () => {
    expect(computeHookScore("")).toBe(0);
  });

  it("le score est toujours ≥ 0", () => {
    const score = computeHookScore("meh.");
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("le score est toujours ≤ 100", () => {
    // Maximise tous les signaux: question + exclamation + power verb + 5-12 mots + chiffre + pronom
    const maximal =
      "Stop, you have 10 seconds before everything changes forever!?";
    const score = computeHookScore(maximal);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("retourne un entier", () => {
    const score = computeHookScore("Watch this 10 second clip!");
    expect(Number.isInteger(score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Signaux individuels
// ---------------------------------------------------------------------------
describe("computeHookScore — signal question (+20)", () => {
  it("une question augmente le score", () => {
    const withQ = computeHookScore("Are you sure about this one?");
    const withoutQ = computeHookScore("You should be sure about this one.");
    expect(withQ).toBeGreaterThan(withoutQ);
  });
});

describe("computeHookScore — signal exclamation (+15)", () => {
  it("une exclamation augmente le score", () => {
    const withEx = computeHookScore(
      "This is truly amazing content right here!",
    );
    const withoutEx = computeHookScore(
      "This is truly amazing content right here.",
    );
    expect(withEx).toBeGreaterThan(withoutEx);
  });
});

describe("computeHookScore — signal power verb (+20)", () => {
  it("le premier mot 'stop' augmente le score", () => {
    const withPV = computeHookScore(
      "Stop scrolling and watch this amazing thing.",
    );
    const withoutPV = computeHookScore(
      "Please read this and watch this amazing thing.",
    );
    expect(withPV).toBeGreaterThan(withoutPV);
  });

  it("le premier mot 'watch' augmente le score", () => {
    const score = computeHookScore("Watch this before it disappears forever.");
    expect(score).toBeGreaterThanOrEqual(20);
  });

  it("le premier mot 'never' augmente le score", () => {
    const score = computeHookScore("Never do this mistake again in your life.");
    expect(score).toBeGreaterThanOrEqual(20);
  });

  it("power verb français 'regarde' augmente le score", () => {
    // Note : firstWord est extrait via /^\w+/ qui ne capture pas les accents
    // (arrête → firstWord=""). On utilise "regarde" qui est ASCII pur.
    const withPV = computeHookScore("Regarde ce truc incroyable maintenant.");
    const withoutPV = computeHookScore(
      "Ce truc incroyable est vraiment partout.",
    );
    expect(withPV).toBeGreaterThan(withoutPV);
  });
});

describe("computeHookScore — signal longueur 5-12 mots (+20)", () => {
  it("phrase de 8 mots marque full score longueur", () => {
    // 8 mots dans [5,12] → +20
    const score = computeHookScore("This is a very important message for you.");
    // doit avoir le +20 longueur
    expect(score).toBeGreaterThanOrEqual(20);
  });

  it("phrase de 2 mots marque 0 pour longueur", () => {
    // 2 mots — pas dans [3,16] → 0
    const veryShort = computeHookScore("Hello world.");
    const normalLength = computeHookScore(
      "Hello world it is a wonderful sunny day.",
    );
    expect(normalLength).toBeGreaterThan(veryShort);
  });
});

describe("computeHookScore — signal chiffre (+15)", () => {
  it("un chiffre dans la phrase augmente le score", () => {
    const withNum = computeHookScore("I made 1000 dollars last week online.");
    const withoutNum = computeHookScore(
      "I made a thousand dollars last week online.",
    );
    expect(withNum).toBeGreaterThan(withoutNum);
  });
});

describe("computeHookScore — signal pronom direct (+10)", () => {
  it("pronom 'you' tôt dans la phrase augmente le score", () => {
    const withPron = computeHookScore(
      "You will never believe what happened today.",
    );
    const withoutPron = computeHookScore(
      "Something incredible happened to someone today.",
    );
    expect(withPron).toBeGreaterThan(withoutPron);
  });

  it("pronom français 'tu' augmente le score", () => {
    const score = computeHookScore("Tu dois absolument voir ça maintenant.");
    expect(score).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Phrases haute/basse énergie — tests comportementaux
// ---------------------------------------------------------------------------
describe("computeHookScore — phrases représentatives", () => {
  it("phrase haute énergie score ≥ 60", () => {
    // Signaux cumulés :
    //   power-verb "stop" premier mot             → +20
    //   pronom "you" dans les 5 premiers mots     → +10
    //   longueur 7 mots dans [5,12]               → +20
    //   chiffre "10"                              → +15
    // Total = 65 ≥ 60
    // "Stop" "you" "need" "to" "know" = mots 1-5, "you" est bien en position 2
    const highEnergy = "Stop, you need to know 10 secrets.";
    const score = computeHookScore(highEnergy);
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("phrase basse énergie score ≤ 20", () => {
    // Pas de signal fort
    const lowEnergy = "So anyway, moving on.";
    const score = computeHookScore(lowEnergy);
    expect(score).toBeLessThanOrEqual(20);
  });

  it("score croissant quand on accumule les signaux", () => {
    const s1 = computeHookScore("Something happened today.");
    const s2 = computeHookScore("Watch something happen today.");
    const s3 = computeHookScore("Watch you do 3 things today!");
    expect(s3).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s1);
  });
});
