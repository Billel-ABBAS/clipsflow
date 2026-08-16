import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { sentryBeforeBreadcrumb, sentryBeforeSend } from "./sentry-scrubber";

describe("sentryBeforeSend", () => {
  it("retire clés, JWT, emails, credentials URL et query strings partout", () => {
    const event = {
      message: "request failed for alice@example.com Bearer secret-bearer",
      user: { id: "user-1", email: "alice@example.com" },
      exception: {
        values: [
          {
            type: "Error",
            value:
              "provider rejected sk-proj-abcdefghijklmnopqrstuvwxyz at https://user:pass@api.example.com/path?token=signed-value",
          },
        ],
      },
      request: {
        url: "https://api.example.com/file?X-Amz-Signature=very-secret",
        headers: {
          authorization: "Bearer another-secret",
          cookie: "session=secret-cookie",
        },
        data: {
          nested: [
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue",
            { api_key: "gsk_super-secret" },
          ],
        },
      },
      contexts: {
        custom: {
          values: ["safe", "whsec_abcdefghijklmnopqrstuvwxyz"],
        },
      },
      breadcrumbs: [
        {
          message: "signed https://cdn.example.com/a?token=secret",
          data: { password: "nope" },
        },
      ],
    } as unknown as ErrorEvent;

    const result = sentryBeforeSend(event);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "alice@example.com",
      "secret-bearer",
      "sk-proj-",
      "user:pass",
      "signed-value",
      "very-secret",
      "another-secret",
      "secret-cookie",
      "eyJhbGci",
      "gsk_super-secret",
      "whsec_",
      '"nope"',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(
      Array.isArray(
        (result?.contexts?.custom as { values?: unknown[] } | undefined)
          ?.values,
      ),
    ).toBe(true);
  });
});

describe("sentryBeforeBreadcrumb", () => {
  it("assainit le message et les données sans transformer les tableaux", () => {
    const breadcrumb = {
      message: "OpenAI sk-abcdefghijklmnopqrstuvwxyz failed",
      data: {
        urls: [
          "https://cdn.example.com/file?token=one",
          "https://cdn.example.com/other?token=two",
        ],
      },
    } as Breadcrumb;

    const result = sentryBeforeBreadcrumb(breadcrumb);
    expect(result?.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(Array.isArray(result?.data?.urls)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("token=one");
  });
});
