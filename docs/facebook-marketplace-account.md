# Dedicated Facebook account for Marketplace — attempt guide

Field guide for Phase 4's outstanding Facebook Marketplace source. Written to be read on a phone at the cafe.

**Read §1 before you leave the house.** There is a ten-minute test that may make the trip unnecessary, and a structural risk that may make it a bad idea.

---

## 1. Do this before you go

### 1.1 Check whether you need an account at all (10 minutes, at home)

Craigslist already works without a login. Before creating anything, find out how much of Marketplace is reachable logged out:

1. Open a **private window** (no Facebook session).
2. Try a Marketplace search URL directly for a real query and your region.
3. Note what you get: full results, a partial list behind a login prompt, or an immediate wall.

**If search results render logged out**, you don't need an account — you need a Craigslist-shaped adapter, and this entire document is moot. That is by far the best outcome and costs ten minutes to rule in or out.

**If you hit a wall immediately**, continue to §1.2.

### 1.2 Understand what the cafe actually buys you

The cafe changes **the IP address at signup**. That is one signal among several, and not the strongest one. Facebook associates accounts primarily through:

- **Phone number** — the strongest link by far, and effectively mandatory for new accounts (see §1.3).
- **Device and browser fingerprint** — persists regardless of network.
- **IP history over time** — not the signup IP, but where the account is *used*. You will use this account from your homelab, on the same residential connection as your real account, every day.
- **Behavioral patterns** — an account that only ever runs Marketplace searches on a schedule looks like exactly what it is.

So: signing up at a cafe and then operating the account from home means the separation lasts about one day. If IP separation genuinely matters to you, the cafe is the wrong tool — it would need to be an ongoing arrangement, not a one-time trip.

### 1.3 The phone number is the real decision

New Facebook accounts effectively require SMS verification. This is the fork:

- **Use your real number** → the new account is linked to your existing one immediately and permanently. The cafe accomplishes nothing.
- **Use a different number you control** → a second SIM, a carrier line, a number tied to you some other way. Whether you have one of these is the actual go/no-go, not the cafe.

I'm not going to cover SMS-verification services or number-laundering approaches — that's the point where this stops being "set up a second account" and becomes evading account-linking detection, and I'd rather you make that call knowingly than have me hand you a recipe for it.

### 1.4 The risk runs the direction you don't want

The obvious downside is losing the new account. That's cheap — it holds nothing.

**The real risk is Facebook linking the new account to your real one and actioning the real one.** Your personal account has your actual social graph, photos, and history in it. Facebook's terms permit one personal account per person, so a second one is a terms violation on its face, and automation on top of it is a second.

Worth sitting with: a dedicated account may *increase* total risk to the thing you care about, compared with either using your real account very conservatively or not touching Marketplace at all. `SPEC.md` §15 already logs this as accepted residual risk — this is the moment to actually decide it rather than inherit it.

### 1.5 New accounts often can't use Marketplace anyway

Facebook gates Marketplace for new accounts specifically because scammers and bots create them constantly. Expect some combination of an account-age requirement, a friends/activity threshold, or restricted access on day one.

**Consequence: a fresh account may not expose the surface Magpie needs, and you may not find out for days or weeks.** Budget for the possibility that the whole thing dead-ends after the account matures.

---

## 2. At the cafe

Only if §1 came out in favor.

**Bring:** a laptop or phone, and the phone number you settled on in §1.3.

1. **Use an ordinary browser, not the Playwright profile.** Do not touch `browser-profile/` here. Signup should look like a person signing up, because it is one. Wiring it into Magpie is a separate, later step.
2. **Do it manually and unhurriedly.** No automation, no scripts, no extensions.
3. **Expect a checkpoint.** Photo ID requests, phone re-verification, and immediate holds are routine on new accounts. If you hit an ID checkpoint, stop — that's a signal about how this account will be treated going forward.
4. **Do not open Marketplace on day one.** Create the account and leave.
5. **Record what happened** in `log.md`: what verification was demanded, whether a checkpoint fired, what Marketplace access looked like if you glanced at it.

**Do not** log into your real Facebook account on the cafe network in the same session. Sharing an IP with the new account at the exact moment it's created is the one association the trip is meant to avoid.

---

## 3. After — before wiring anything into Magpie

1. **Let it sit.** Days, not hours. An account that is created and immediately begins issuing searches is the pattern the abuse systems are tuned for.
2. **Log in manually a few times** from the machine that will eventually run it, and browse normally.
3. **Check Marketplace access by hand.** Can you search? Do results render? Does pagination work? If not, §1.5 happened and the plan is dead — record it and stop.
4. **Only then** run `bun run login` to capture the session into `browser-profile/`, and only then write the adapter.
5. **First automated runs should be deliberately tiny.** One search, then stop for the day. `pacing.ts` and the `ChallengeDetectedError` cooldown from the Phase 4 hardening branch already exist — make sure Marketplace is wired into the challenge detection *before* the first run, not after the first ban.

---

## 4. Alternatives, ranked

| Option | Verdict |
|---|---|
| **Logged-out adapter** (§1.1) | Best case. Costs ten minutes to test. Do this first. |
| **Skip Marketplace** | Genuinely reasonable. Craigslist is merged and covers much of the same local-listing ground. Marketplace is one source in a plan that is about to gain dozens (vision doc §3.1). |
| **Manual-in-the-loop** | Magpie builds and posts the Marketplace search URL to Discord; you click it. Zero automation risk, keeps Marketplace in the workflow, loses ranking and dedup. |
| **Real account, very conservative** | One search per day, long pacing, no scheduled watches. Accepts risk to the account you care about in exchange for not maintaining a second identity. |
| **Dedicated account** | This document. Highest setup cost, real linkage risk, may not clear §1.5. |

---

## 5. Go / no-go

Go only if **all** of these are true:

- [ ] Logged-out access is genuinely walled (§1.1)
- [ ] You have a phone number that isn't tied to your primary account (§1.3)
- [ ] You've decided you accept the risk to your **real** account, not just the new one (§1.4)
- [ ] You're willing for this to dead-end at §1.5 after weeks of waiting
- [ ] Marketplace is worth more to you than the four other options in §4

If any box is unchecked, the honest answer is manual-in-the-loop or skipping Marketplace — and either one unblocks the far more valuable Phase 5–7 work sitting behind it.
