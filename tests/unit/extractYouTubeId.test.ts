/**
 * Unit tests for extractYouTubeId — the client-side YouTube URL parser used
 * by ChildVideos.tsx to construct safe embed URLs.
 *
 * Verifies:
 * - Only explicitly supported YouTube hostnames are accepted.
 * - Malformed URLs and unexpected hosts are rejected (return null).
 * - Arbitrary external URLs cannot become iframe sources.
 * - Valid supported YouTube URL formats continue to work.
 * - Invalid URLs result in a safe fallback (null → no iframe).
 */

import { test, expect } from "bun:test";
import { extractYouTubeId } from "@/lib/parent-ui/format";

// === Valid YouTube URLs (should return the 11-char video ID) ============

test("extractYouTubeId: valid youtube.com/watch?v=ID returns ID", () => {
  expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("extractYouTubeId: valid youtube.com without www returns ID", () => {
  expect(extractYouTubeId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("extractYouTubeId: valid youtu.be short URL returns ID", () => {
  expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("extractYouTubeId: youtube.com/watch with extra query params returns ID", () => {
  expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=shared&t=10")).toBe("dQw4w9WgXcQ");
});

test("extractYouTubeId: HTTP (non-HTTPS) youtube URL returns ID", () => {
  expect(extractYouTubeId("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

// === Invalid YouTube URLs (should return null — no iframe) ==============

test("extractYouTubeId: video ID too short returns null", () => {
  expect(extractYouTubeId("https://www.youtube.com/watch?v=short")).toBe(null);
});

test("extractYouTubeId: video ID too long returns null", () => {
  expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQAAA")).toBe(null);
});

test("extractYouTubeId: empty v param returns null", () => {
  expect(extractYouTubeId("https://www.youtube.com/watch?v=")).toBe(null);
});

test("extractYouTubeId: youtu.be with no path returns null", () => {
  expect(extractYouTubeId("https://youtu.be/")).toBe(null);
});

test("extractYouTubeId: youtu.be with short path returns null", () => {
  expect(extractYouTubeId("https://youtu.be/short")).toBe(null);
});

test("extractYouTubeId: youtube.com non-/watch path returns null", () => {
  expect(extractYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(null);
  expect(extractYouTubeId("https://www.youtube.com/other")).toBe(null);
});

// === Non-YouTube hosts (must return null — no arbitrary iframe) =========

test("extractYouTubeId: evil.com returns null", () => {
  expect(extractYouTubeId("https://evil.com/watch?v=dQw4w9WgXcQ")).toBe(null);
});

test("extractYouTubeId: vimeo.com returns null", () => {
  expect(extractYouTubeId("https://vimeo.com/12345")).toBe(null);
});

test("extractYouTubeId: lookalike hostname youtube.com.evil.com returns null", () => {
  expect(extractYouTubeId("https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ")).toBe(null);
});

test("extractYouTubeId: lookalike hostname wwwyoutube.com returns null", () => {
  expect(extractYouTubeId("https://wwwyoutube.com/watch?v=dQw4w9WgXcQ")).toBe(null);
});

// === Malformed/dangerous inputs (must return null — no iframe) ==========

test("extractYouTubeId: plain string (not a URL) returns null", () => {
  expect(extractYouTubeId("not a url")).toBe(null);
});

test("extractYouTubeId: javascript: URL returns null", () => {
  expect(extractYouTubeId("javascript:alert(1)")).toBe(null);
});

test("extractYouTubeId: data: URL returns null", () => {
  expect(extractYouTubeId("data:text/html,<script>alert(1)</script>")).toBe(null);
});

test("extractYouTubeId: empty string returns null", () => {
  expect(extractYouTubeId("")).toBe(null);
});

test("extractYouTubeId: URL without protocol returns null", () => {
  expect(extractYouTubeId("www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(null);
});

// === Result is always a safe 11-char string or null (never an arbitrary URL) ===

test("extractYouTubeId: result is always exactly 11 chars or null", () => {
  const valid = extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  expect(valid).not.toBe(null);
  expect(valid!.length).toBe(11);
  expect(valid).toMatch(/^[A-Za-z0-9_-]{11}$/);
  // The result is safe to interpolate into https://www.youtube.com/embed/{vid}
  // because it's a validated 11-char alphanumeric+underscore+hyphen string.
});
