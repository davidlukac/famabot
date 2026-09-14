# Disclaimer

famabot is a personal, experimental project. It automates a browser session to read pages
from Facebook Marketplace on your behalf. Read this before you run it against your own
account.

## Not affiliated with Meta

famabot is an independent, unofficial tool. It is not affiliated with, endorsed by, or
connected to Meta Platforms, Inc., Facebook, or Facebook Marketplace in any way. "Facebook"
and "Marketplace" are used here only to describe what the tool interacts with.

## This violates Facebook's Terms of Service

Facebook's [Terms of Service](https://www.facebook.com/terms.php) and
[Automated Data Collection Terms](https://www.facebook.com/apps/site_scraping_tos_terms.php)
prohibit automated access, scraping, and data collection without Facebook's prior written
permission. Running famabot against your Facebook account is a violation of those terms,
full stop — no amount of "slow, human-like pacing" changes that. This project's pacing,
scroll-depth randomization, and other anti-detection choices reduce the *chance and speed*
of Facebook noticing, not the fact that it's against the rules.

**Realistic consequences of running this** include, at Facebook's sole discretion and without
warning: your account being temporarily checkpoint-restricted, permanently disabled, or
having Marketplace access specifically revoked. If your Facebook account is tied to your real
identity, or shared with things you'd genuinely miss losing access to (family photos, a
business Page, ad accounts, other apps using Facebook login), weigh that before pointing
famabot at it. Consider a dedicated/secondary account if you want to isolate that risk — that
doesn't make the scraping compliant, but it does contain the blast radius.

## Educational, experimental, and personal use only

This project exists as a personal tool and a public example of a small agentic-scraping
system — not as a product, service, or something to build a business on. It is published
in case the code or approach is useful or interesting to someone else, in the same spirit as
sharing a script. It is **not** intended for:

- commercial use, resale, or any use serving other people's accounts on their behalf,
- high-volume or multi-account operation designed to evade Facebook's abuse detection at
  scale,
- any use that isn't "one person, running it against their own account, to help with their
  own search."

## No warranty, no accuracy guarantee, use at your own risk

Beyond the [MIT license](LICENSE)'s standard "as is, no warranty" terms, specifically for
this project:

- **The evaluator can be wrong.** It's an LLM reading listing text and applying criteria you
  wrote — it can misread a listing, miss a red flag, hallucinate a detail, or score something
  well that turns out to be a scam or a bait-and-switch. Treat every `candidate` as "worth a
  human look," never as a verified recommendation. Don't wire money, sign anything, or make a
  decision based solely on famabot's output — verify everything yourself, the way you would
  with any Marketplace listing found by hand.
- **Scraped data can be stale, wrong, or incomplete**, especially if Facebook changes its
  page structure (famabot falls back to a DOM scrape and stores the raw payload for
  re-parsing, but a silent field-mapping mismatch is possible until someone — you — notices).
- **Facebook may rate-limit, throttle, or serve degraded/redirected pages** to automated
  traffic without any error famabot can detect, silently narrowing what it actually sees.
- **You are responsible for how you use anything you find** through this tool, including
  contacting sellers, arranging viewings, and any transaction that follows — famabot only
  surfaces listings, it has no role in and no liability for what you do next.

## If you choose to run it anyway

- Use your own account, for your own search, and keep the pacing conservative
  (see [`.env.example`](.env.example) and the [Freshness and poll frequency](README.md#freshness-and-poll-frequency)
  section of the README) rather than cranking it up to scrape faster.
- Don't share your `.env` or Chromium session profile (`.data/chromium-profile/`) — they hold
  your live Facebook session.
- Expect to occasionally need to fix a selector or re-tune pacing as Facebook's site changes;
  this is not maintained as a production service with guaranteed uptime or support.

By running famabot, you accept these terms and the risk of any consequence Facebook (or
anyone else) may impose as a result — entirely on your own account and at your own
discretion.
