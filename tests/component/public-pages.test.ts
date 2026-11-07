import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const landing = readFileSync(
  resolve(import.meta.dir, "../../src/components/public/AcademyLandingPage.tsx"),
  "utf-8",
);
const coaches = readFileSync(
  resolve(import.meta.dir, "../../src/components/public/CoachesPage.tsx"),
  "utf-8",
);
const config = readFileSync(
  resolve(import.meta.dir, "../../src/config/public-site.ts"),
  "utf-8",
);

test("public landing page preserves registration and login entry points", () => {
  expect(landing).toContain("onLoginClick");
  expect(landing).toContain("onRegisterClick");
  expect(landing).toContain("onCheckStatusClick");
  expect(landing).toContain("/api/public/landing");
  expect(landing).toContain("Menampilkan pratinjau");
});

test("public content pages provide centralized editable placeholders", () => {
  expect(config).toContain('name: "SEMANGAT"');
  expect(config).toContain('name: "MEMBARA"');
  expect(config).toContain('name: "ADVANCE"');
  expect(config).toContain('name: "Coach 01"');
  expect(config).toContain("videoId: \"\"");
  expect(landing).toContain("publicSiteConfig.landing.programs");
  expect(coaches).toContain("publicSiteConfig.coaches.profiles");
  expect(coaches).toContain("publicSiteConfig.coaches.trainingVideos");
});

test("public coaches page is separate from the protected coach portal", () => {
  expect(coaches).toContain("export function CoachesPage");
  expect(
    readFileSync(resolve(import.meta.dir, "../../src/app/coaches/page.tsx"), "utf-8"),
  ).toContain("<CoachesPage />");
  expect(
    readFileSync(resolve(import.meta.dir, "../../src/app/coach/page.tsx"), "utf-8"),
  ).toContain('mode="coach"');
});
