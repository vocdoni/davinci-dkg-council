# Organizer guide

A runbook for the person who creates and shepherds a committee, from creation to opening the
results months later. The app explains each step as it happens; this document is what the app
cannot say in one screen: the decisions that are hard to undo, and the duties between the
ceremony and opening day. The protocol details live in [protocol.md](protocol.md); hosting and
infrastructure duties in [hosting.md](hosting.md); what to do when something breaks in
[incident-response.md](incident-response.md).

## Choosing `t` and `n` for a long election

`t` of your `n` members must come back, with working recovery words, on opening day. Everything
else follows from that:

- **You can lose at most `n − t` members.** Lost means anything: words gone, person unreachable,
  device and kit both destroyed. Every member holds a recoverable share (even one who never
  dealt), so only the words matter — but there is **no resharing and no way to repair a
  committee** after creation. Attrition is silent: you typically discover it on opening day,
  when it is unfixable.
- **Fewer than `t` compromised — cumulatively, over the key's whole lifetime.** A member whose
  kit leaked in month one and another in month four both count against the same bound, forever.
  A higher `t` raises the collusion bar but lowers your loss tolerance.
- For an election opened months later, pick generous slack on both sides. A majority threshold
  with real headroom is a good default: `n = 9, t = 5` tolerates four lost members and needs
  five colluders; `n = 16, t = 9` tolerates seven. Avoid `t = n` (one lost member kills the
  election) and avoid `t = 1` (one leaked kit decrypts everything alone).

## Decryption mode: Scheduled vs Manual, and the fallback date

The opening policy is fixed at creation and can never be changed — no reschedule, pause or
re-open. Choose deliberately:

- **Scheduled**: results become openable at a fixed date, by predicate alone — no transaction,
  no one's presence needed. Use it when the opening date is truly known in advance. It cannot be
  accelerated, even by you.
- **Manual with a fallback date** (the recommended default): you open the results when the
  election ends, and if you cannot — lost kit, unreachable, anything — the fallback date opens
  them without you. The fallback is a **latest-opening backstop, not a "not before"**: you can
  always open earlier. If you need a hard not-before date, that is Scheduled.
- **Manual without a fallback** is an explicit advanced choice: if you disappear, the results
  can never be opened on chain, period. Do not use it for a real election.

Two honesty notes the app also shows: the gate is **policy, not a time lock** — any `t`
colluding members can decrypt off chain at any time, whatever the dates say; and dates take
effect at an included block, not at the displayed second — expect minutes of finality lag, never
plan to the minute. The same disappearance logic applies to registration: Manual registration
without an expiry stalls forever if you never close it, so set an expiry or close promptly.

## One committee per privacy domain

One committee key is one privacy domain: every process bound to it shares the same `t`-collusion
boundary, and a partial computed for one ciphertext is mathematically valid for the same
ciphertext anywhere (protocol §11.2). Therefore:

- **Elections that must be independent get separate ceremonies.** Opening dates cannot split
  them, and nothing else can either.
- **Hard isolation also needs separate roots**: a recovery root's compromise spans every
  ceremony derived from it, so a member serving on two committees that must fail independently
  needs two sets of twelve words, kept apart.
- Retire a key rather than stretching it: the collusion bound is cumulative over its lifetime,
  so a fresh ceremony per election cycle is cheaper than it looks.

## Kit custody

- Every kit file holds the root **in plaintext**: whoever holds the file *is* that member. Treat
  it like the key it is. (Password-encrypted export is a planned future option.)
- Keep **offline copies**: the printed word sheet, on paper, ideally in two places. Browser
  storage is a cache, not a store — Safari deletes site data after about a week without a
  visit — and the words are the only thing that is not optional.
- **Never pool kits.** An organizer collecting members' kits or words "for safekeeping"
  reconstructs the full key in one drawer and silently voids the threshold. Each member keeps
  their own; the protocol's whole point is that no one place holds enough.
- Members keep their words **until the results are opened**, not until the ceremony ends.

## Your records: what to export and keep

Members' names and vote labels live only in your browser and are silently lost if it evicts
them — at month five, "which of the sixteen is Maria?" has no on-chain answer. Until a
one-click organizer-record export exists in the app, keep your own copy of:

- the **committee link** (it contains the committee id) and the **app URL**;
- the deployment identity: chain, manager address, deployment block;
- the decryption policy and its exact dates (opening date or fallback, registration expiry);
- the **member list**: which person got which invitation, and their labels;
- the relayer URL, and a pointer to the deployment's archive (app image and circuit files —
  see [hosting.md](hosting.md)), so a dead host can be rebuilt by anyone.

Your own organizer kit matters as much as a member's: in Manual mode it is the only thing that
can open results *early* — lose it and the fallback date is your only path.

## The pre-opening drill (about two weeks before)

The single most valuable thing you can do for a months-later opening. Around T−2 weeks:

1. Ask every member, out of band (there are no in-app notifications, by design), to run the
   **restore check**: open the app on a fresh browser profile, restore from the twelve words and
   the committee link, and confirm the app recognizes them as their member.
2. Tally the confirmations yourself. If fewer than `t` members confirm, you now know **before**
   opening day — start chasing the silent ones while there is still time.
3. Check the infrastructure: both RPC providers healthy and current ([hosting.md](hosting.md)),
   the app origin up and the six circuit files still verifying, the relayer alive and funded
   (below), and the budget raised for opening week.

## Monitoring the relayer

The relayer is the only sender the app knows, so on opening day it is a single point of
liveness. Whoever operates it (you, or your host) should watch, at minimum:

- **`GET /v1/health`** — expect `{ "ok": true, "chainId", "manager", "relayer", "balanceWei" }`.
  Alert on: the endpoint down, `ok` false, or `balanceWei` below roughly **twice the worst-case
  opening cost at current gas prices**. For scale: a full 16-member, 16-field opening is about
  48M gas of partials and combines — ≈ 0.05 native units at 1 gwei, ≈ 1 unit if gas spikes to
  20 gwei. Size the daily budget (`COUNCIL_DAILY_BUDGET_WEI`) and the key balance for
  opening-week prices, not ceremony-week prices.
- **Logs** — `hot key balance too low` (error), `BUDGET_EXHAUSTED` responses, and a repeating
  `combiner tick failed` are the three lines that matter on opening day.

> **Coordination note.** Field names above follow the current `/v1/health` response in
> [relayer.md](relayer.md). The relayer is slated to grow budget/spend visibility (extra health
> fields or a `/v1/metrics` endpoint); when that lands, confirm the exact names against
> `relayer/README.md` and `docs/relayer.md` and update this section.

Operating the relayer itself — budget sizing, quotas, the standby procedure when one dies — is
[relayer.md](relayer.md) and [hosting.md](hosting.md).

## Connections: adapter grants are load-bearing

Under "Connections" you allow a **voting-system adapter** and authorize an **election creator**.
These grants are the only thing standing between your committee and becoming a decryption oracle:
any contract you allow as an adapter can bind "processes" and submit decryption requests that
your members' clients will treat as legitimate.

- Allow **only the official DAVINCI adapter** — the `CouncilAdapter` created by the DAVINCI
  process registry on your chain, read from the registry itself (`councilAdapter()`), never from
  a message, an email or a link.
- Authorize only the creator address you expect to run the election, confirmed out of band.
- When in doubt, don't grant: grants can be added later, but a decryption that a rogue adapter
  obtained can never be taken back.

### Connecting to DAVINCI Elections with a pairing code

If your organization uses DAVINCI Elections and this deployment has the connection configured,
the dashboard shows a "Connect to DAVINCI Elections" card once the committee is Live. It makes
both grants for you, safely:

1. In DAVINCI Elections, open **Committees → "Get a pairing code"**. The code (`XXXX-XXXX-XXXX`)
   works once and only for a short while.
2. Type it into the card — by hand; the app never reads a code from a link — and press
   Continue. The app talks only to the Elections server pinned in its configuration and checks
   that the server runs on the same chain, manager and registry as this committee; on any
   difference it stops without changing anything.
3. Confirm the screen: the **organization name**, the committee fingerprint and the **creator
   address** whose elections you are authorizing. This is the same irreversible act as a manual
   grant on the Connections card — read it before pressing Connect.
4. The app signs the two grants (the adapter read on chain from the pinned registry, the creator
   from the resolved code), tells Elections, and offers a link back. If the code expires midway,
   ask for a new one and type it; steps already done are skipped.

"This code is not valid anymore" means expired, already used or mistyped — get a fresh one.
"Different voting network" means the Elections server does not run on this committee's
deployment; nothing was granted, contact whoever gave you the code.

## Pre-opening checklist (condensed)

- [ ] T−2 weeks: every member ran the restore check; at least `t` confirmed (chase the rest)
- [ ] RPC providers: both current and agreeing; rotate a lagging one ([hosting.md](hosting.md))
- [ ] App origin up; circuit files verify against their pins
- [ ] Relayer `/v1/health` ok; key topped up and budget sized for opening-week gas
- [ ] Manual mode: your organizer kit restores; you know the fallback date
- [ ] Your records (member labels, dates, deployment identity) are where you can find them
