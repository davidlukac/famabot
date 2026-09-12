import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanListingText } from "./clean.js";

// Verbatim capture from production listing 1759810525480905 (truncated tail of
// the "Today's picks" carousel — the real one runs ~20 more items).
const RAW = `3 Beds 2 Baths - House
CA$2,400/month
Property to rent
46067 Bonny Ave, Chilliwack, BC
Listed 5 days ago · Available now
Message
Unit details
House
3 beds · 2 baths
Launderette available
Garage parking
1-month tenancy
Property for rent location
Chilliwack, BC, V2P 3H7
Description
Recently renovated house in a desired area of Chilliwack.. Close to all amenties like Day care, schools, shopping complex, bus stop etc. Looking for long term tenants who can keep the home like their own..
No Smoke..
No Pets..
Laundry includes.
Call me- SEVEN-SEVEN-EIGHT-THREE-ONE-SEVEN-ONE-SIX-ZERO-SIX See less
Getting around
Provided by Walk Score®︎
Walk Score®︎
68 out of 100
Some errands can be accomplished on foot.
Transit Score®︎
41 out of 100
A few nearby public transport options.
Bike Score®︎
75 out of 100
Cycling is convenient for most trips.
Nearby transport
Provided by Walk Score®︎
Young at Yates (SB)
Routes: 3 Chilliwack, 53 Chilliwack
619 ft
Ad
Granola - AI notepad
Seller information
Satwinderjit Mann
Joined Facebook in 2009
Send seller a message
Send
Today's picks
Maple Ridge · 65 km
CA$4,700
2023 Kawasaki klr
CA$35,000
1995 Land Rover defender 110`;

test("keeps seller prose + attribute rows + full location widget, drops ad/seller/carousel", () => {
  const out = cleanListingText(RAW)!;

  // kept: seller text, hard-constraint signal, address, attribute rows
  assert.match(out, /No Pets\.\./);
  assert.match(out, /Recently renovated house/);
  assert.match(out, /46067 Bonny Ave/);
  assert.match(out, /3 beds · 2 baths/);

  // kept: the whole "Getting around" widget — scores AND nearby transit
  assert.match(out, /Walk Score/);
  assert.match(out, /68 out of 100/);
  assert.match(out, /Bike Score/);
  assert.match(out, /Nearby transport/);
  assert.match(out, /Young at Yates/);

  // dropped: ad slot, seller card, "Today's picks" carousel
  assert.doesNotMatch(out, /Granola - AI notepad/);
  assert.doesNotMatch(out, /Seller information/);
  assert.doesNotMatch(out, /Satwinderjit Mann/);
  assert.doesNotMatch(out, /Today's picks/);
  assert.doesNotMatch(out, /Kawasaki|Land Rover/);

  // dropped: bare UI lines and the trailing "See less"
  assert.doesNotMatch(out, /^Message$/m);
  assert.doesNotMatch(out, /^Send$/m);
  assert.doesNotMatch(out, /See less/);

  assert.ok(out.length < RAW.length * 0.8, "should be materially shorter");
});

test("works for a non-rental listing (used car)", () => {
  const raw = [
    "2016 Honda Civic EX",
    "CA$14,900",
    "About this vehicle",
    "80,000 km · Automatic · Gas",
    "Exterior colour: Silver",
    "Description",
    "One owner, no accidents, new winter tires. Clean title. Text to view.",
    "Seller information",
    "Bob's Autos",
    "Today's picks",
    "CA$9,000 2012 Corolla",
  ].join("\n");
  const out = cleanListingText(raw)!;
  assert.match(out, /One owner, no accidents/);
  assert.match(out, /80,000 km · Automatic/);
  assert.doesNotMatch(out, /Bob's Autos/);
  assert.doesNotMatch(out, /2012 Corolla/);
});

test("cuts at the seller card when there is no walk-score block", () => {
  const raw = [
    "Nice bright 3 bed house, big fenced yard, cats ok.",
    "Available Oct 1. $2650 + utilities.",
    "Seller information",
    "Jane Doe",
    "Joined Facebook in 2015",
    "More listings from this seller",
    "CA$900 Dining set",
  ].join("\n");
  const out = cleanListingText(raw)!;
  assert.match(out, /fenced yard/);
  assert.doesNotMatch(out, /Jane Doe/);
  assert.doesNotMatch(out, /Dining set/);
});

test("passes through text that has no chrome markers", () => {
  const raw = "Cozy 2 bedroom laneway, no pets, $1900. Text 604-555-0199.";
  assert.equal(cleanListingText(raw), raw);
});

test("falls back to the original if trimming would gut it", () => {
  // Pathological: a marker line sits at the very top, real content below it.
  // Cutting there would leave nothing, so we must keep the original.
  const raw =
    "Today's picks\n" +
    "Actually this is the whole seller description. " +
    "Spacious 3 bed house, fenced yard, pets negotiable, $2800. ".repeat(6);
  const out = cleanListingText(raw)!;
  assert.equal(out, raw.trim());
});

test("null / empty in, null / empty out", () => {
  assert.equal(cleanListingText(null), null);
  assert.equal(cleanListingText(undefined), null);
  assert.equal(cleanListingText(""), "");
});
