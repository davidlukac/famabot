import { test } from "node:test";
import assert from "node:assert/strict";
import { extractExternalLinks } from "./links.js";

test("extractExternalLinks: finds http(s) URLs in free text", () => {
  const text = "Message me or see https://example.com/listing for more.";
  assert.deepEqual(extractExternalLinks(text), ["https://example.com/listing"]);
});

test("extractExternalLinks: excludes facebook/fbcdn/fb.me domains", () => {
  const text = [
    "https://www.facebook.com/marketplace/item/123/",
    "https://scontent.fbcdn.net/photo.jpg",
    "https://fb.me/shortlink",
    "https://realsite.example/apply",
  ].join(" ");
  assert.deepEqual(extractExternalLinks(text), ["https://realsite.example/apply"]);
});

test("extractExternalLinks: dedupes repeated URLs", () => {
  const text = "https://a.example/x and again https://a.example/x";
  assert.deepEqual(extractExternalLinks(text), ["https://a.example/x"]);
});

test("extractExternalLinks: null/undefined/empty input returns []", () => {
  assert.deepEqual(extractExternalLinks(null), []);
  assert.deepEqual(extractExternalLinks(undefined), []);
  assert.deepEqual(extractExternalLinks(""), []);
});

test("extractExternalLinks: stops at whitespace/quote/paren delimiters", () => {
  const text = 'See (https://example.com/a) or "https://example.com/b" too.';
  assert.deepEqual(extractExternalLinks(text), [
    "https://example.com/a",
    "https://example.com/b",
  ]);
});
