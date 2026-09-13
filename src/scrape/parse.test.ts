import { test } from "node:test";
import assert from "node:assert/strict";
import { collectListings, idFromHref } from "./parse.js";

/**
 * Real Facebook Marketplace GraphQL listing node, captured in production and
 * sanitized (seller name/id replaced, photo URL simplified, listing id
 * swapped for an obviously-fake one) before going into a public fixture —
 * everything else, including field names and nesting, is exactly what FB
 * sent. This is the shape `collectListings`/`toRawListing` actually have to
 * parse, and the README itself warns FB changes this "without notice" — a
 * fixture test is the cheapest way to notice when they do.
 */
const REAL_LISTING_NODE = {
  __typename: "GroupCommerceProductItem",
  id: "9990000000001",
  primary_listing_photo: {
    __typename: "Photo",
    image: { uri: "https://scontent.example.fna.fbcdn.net/v/sample.jpg" },
    id: "1",
  },
  creation_time: 1788713040,
  __isMarketplaceListingRenderable: "GroupCommerceProductItem",
  listing_price: {
    formatted_amount: "CA$1,850",
    amount_with_offset_in_currency: "133802",
    amount: "1850.00",
  },
  strikethrough_price: null,
  location: {
    reverse_geocode: {
      city: "Coquitlam",
      state: "BC",
      city_page: { display_name: "Coquitlam, British Columbia", id: "110019705694079" },
    },
  },
  is_hidden: false,
  is_live: true,
  is_pending: false,
  is_sold: false,
  marketplace_listing_category_id: "1468271819871448",
  marketplace_listing_title: "2 Beds 1 Bath - House",
  custom_title: "2 bedrooms · 1 bathroom",
  custom_sub_titles_with_rendering_flags: [{ subtitle: "Coquitlam, BC" }],
  origin_group: null,
  listing_video: null,
  parent_listing: null,
  marketplace_listing_seller: {
    __typename: "User",
    name: "Test Seller",
    id: "1",
  },
  delivery_types: ["IN_PERSON"],
};

/** Real payloads bury listings several layers deep in edges/node wrappers. */
function wrapInFeed(node: unknown) {
  return {
    data: {
      viewer: {
        marketplace_search: {
          feed_units: {
            edges: [{ node: { listing: node }, cursor: "abc" }],
          },
        },
      },
    },
  };
}

test("collectListings: finds a real listing node nested inside a typical GraphQL feed wrapper", () => {
  const [rl] = collectListings(wrapInFeed(REAL_LISTING_NODE));
  assert.ok(rl);
  assert.equal(rl!.fbId, "9990000000001");
  assert.equal(rl!.url, "https://www.facebook.com/marketplace/item/9990000000001/");
});

test("collectListings: extracts title, price, currency, location, photo, postedAt from the real shape", () => {
  const [rl] = collectListings(REAL_LISTING_NODE);
  assert.equal(rl!.title, "2 Beds 1 Bath - House");
  assert.equal(rl!.price, 1850);
  assert.equal(rl!.currency, null); // this node has no explicit currency/currency_code field
  assert.equal(rl!.location, "Coquitlam, British Columbia");
  assert.equal(rl!.imageUrl, "https://scontent.example.fna.fbcdn.net/v/sample.jpg");
  assert.equal(rl!.postedAt, new Date(1788713040 * 1000).toISOString());
  // raw is kept verbatim for later re-parsing / debugging.
  assert.equal((rl!.raw as { id: string }).id, "9990000000001");
});

test("collectListings: title falls back to custom_title, then title, when marketplace_listing_title is absent", () => {
  const { marketplace_listing_title, ...rest } = REAL_LISTING_NODE;
  void marketplace_listing_title;
  const [rl] = collectListings({ ...rest, custom_title: "Fallback title" });
  assert.equal(rl!.title, "Fallback title");
});

test("collectListings: dedupes the same listing id appearing more than once", () => {
  const payload = { a: REAL_LISTING_NODE, b: { nested: REAL_LISTING_NODE } };
  const results = collectListings(payload);
  assert.equal(results.length, 1);
});

test("collectListings: ignores non-listing objects (has an id, but no price/title signal)", () => {
  const results = collectListings({
    id: "123456",
    __typename: "SomeUnrelatedType",
    nickname: "not a listing",
  });
  assert.equal(results.length, 0);
});

test("collectListings: rejects ids that aren't plain numeric strings", () => {
  const results = collectListings({ ...REAL_LISTING_NODE, id: "not-a-number" });
  assert.equal(results.length, 0);
});

test("collectListings: recognizes a node without __typename via the id+listing_price/title heuristic", () => {
  const { __typename, ...rest } = REAL_LISTING_NODE;
  void __typename;
  const [rl] = collectListings(rest);
  assert.ok(rl);
  assert.equal(rl!.fbId, "9990000000001");
});

test("collectListings: extracts price from a plain string listing_price", () => {
  const [rl] = collectListings({
    id: "9990000000002",
    marketplace_listing_title: "Studio apartment",
    listing_price: "$1,200",
  });
  assert.equal(rl!.price, 1200);
});

test("collectListings: location falls back to a plain string field", () => {
  const [rl] = collectListings({
    id: "9990000000003",
    marketplace_listing_title: "Room for rent",
    listing_price: { amount: "800" },
    location_text: "Burnaby, BC",
  });
  assert.equal(rl!.location, "Burnaby, BC");
});

test("collectListings: survives a circular reference without hanging", () => {
  const node: Record<string, unknown> = { ...REAL_LISTING_NODE };
  node.self = node;
  const results = collectListings({ wrapper: node });
  assert.equal(results.length, 1);
});

test("collectListings: empty/primitive payloads return no results", () => {
  assert.deepEqual(collectListings(null), []);
  assert.deepEqual(collectListings(undefined), []);
  assert.deepEqual(collectListings("just a string"), []);
  assert.deepEqual(collectListings(42), []);
  assert.deepEqual(collectListings({}), []);
});

test("idFromHref: extracts the numeric id from a marketplace item URL", () => {
  assert.equal(
    idFromHref("https://www.facebook.com/marketplace/item/1234567890/"),
    "1234567890",
  );
  assert.equal(idFromHref("/marketplace/item/42?ref=search"), "42");
});

test("idFromHref: null for a URL that isn't a marketplace item link", () => {
  assert.equal(idFromHref("https://www.facebook.com/marketplace/"), null);
  assert.equal(idFromHref("https://example.com/"), null);
});
