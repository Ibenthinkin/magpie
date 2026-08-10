# Magpie — one-pager

*A personal AI shopping agent that finds the best price on anything, and is slowly learning to find the best* **product***, too.*

## The problem

Getting a genuinely good deal means checking a dozen sites by hand — retail, eBay, Craigslist, Marketplace — while mentally tracking which membership, coupon, or store card applies where. And half the time the harder problem isn't price, it's *which product* — turning "a cheap workstation that takes my server RAM" into an actual model number worth searching for.

## What it is

Magpie is a browser agent that shops for you, talked to entirely through Discord. It drives a real, logged-in Chrome session on your own machine — the same one you'd use — so it can reach places a scraper can't: login-walled marketplaces, membership pricing, local listings. It's not a bot pretending to be a person; it's automation of a session that's already yours.

Everything it does reduces to one idea: **hunts**. A hunt takes a target (an exact item, a described style, a thing you buy on a schedule) and an objective (cheapest, best-matching, best value against history), searches the sources that apply, and reports back ranked, with a one-line reason for each result. Every mode below is the same engine pointed at a different combination of those two things — not a separate product.

## What it does today

- **One-shot hunt** — describe an item, get back the top results across every enabled source, ranked by *landed cost* (price + shipping, minus your memberships and coupons), with a plain-language verdict on each.
- **Product advisor** — describe a fuzzy need instead of a product; Magpie asks clarifying questions and proposes concrete candidates, then hands the winner straight to a hunt or a watch.
- **Standing watchlists** — save a search once; Magpie checks it on a schedule (dozens to hundreds in parallel) and only pings you when something *new* shows up, never a repeat.
- **A persistent profile** — memberships, coupon sources, and recurring specs ("HDDs ≥10TB, CMR only") are stored once and applied automatically to every ranking, consistently, forever — the thing a human forgets to do.
- **Cost discipline built in** — every AI call is metered to the cent against a hard monthly ceiling, so "helpful" never turns into a surprise bill.
- **Sources**: eBay live today; Craigslist live and geo-aware; Facebook Marketplace next, via a deliberately manual, ban-safe handoff rather than automating a fragile account.

## Where it's headed

The original scope was "find the best price." The current one is broader: **help with any purchase, not just the ones you already know how to describe.**

- **Price memory** — Magpie starts remembering what things have actually cost over time, so a result can say "lowest it's been in three months," not just "cheapest right now."
- **Self-expanding source catalog** — instead of hand-writing an adapter per site, Magpie *probes* a new site to learn how its search works, then adds it permanently. This is what takes it from a handful of sources to dozens, including obscure ones (a Japanese camera auction site) without custom code.
- **Style search** — "find me this jacket, new or used" plus a reference photo, matched by *look* across resale and retail sites where the listing text is useless but the picture isn't.
- **Promotions inbox** — forward a retailer's coupon email; Magpie parses it and quietly applies it to anything you're already watching, and warns you before it expires unused.
- **Plain-language interface** — talk to it like a person instead of typing slash commands; it learns your preferences (quality over color, brand loyalties) from corrections over time instead of asking every time.
- **Routine purchases** — groceries and repeat buys tracked against a real price baseline, so it can tell you when *this week's* price is actually good.

## Why it's worth having

- **Collapses tab-hopping into one message.** The comparison shopping that takes twenty minutes and six tabs becomes one Discord embed.
- **Never forgets a discount.** Every hunt applies every membership and coupon you've told it about — the exact thing that quietly costs people money when done by hand.
- **Watches so you don't have to.** Standing searches mean you hear about a deal the day it appears, not whenever you next remember to look.
- **Private by construction.** It runs on your own hardware, through your own logged-in sessions. Nothing about it is a hosted product with your data on someone else's server — that's a deliberate constraint, not a limitation.
- **One engine, not a pile of scripts.** Every new capability — style matching, routines, promos — is the same hunt mechanism pointed at a new combination of target and objective, so the system gets more capable without getting more fragile.
