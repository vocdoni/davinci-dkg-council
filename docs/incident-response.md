# Incident response

What to do when a bug is found in a Council deployment while an election is running. Written for
the people operating the deployment (app, relayer, mirrors) and for organizers of live
committees. Read it before the first real election, not during the incident.

## The ground rule: the contracts cannot be changed

`CouncilManager` has no owner, no pause, no proxy and no upgrade path. `abort` is permissionless
but only accepts provably dead ceremonies, and only in Registration or Dealing — a `Live`
ceremony can never be stopped, paused or modified on chain. Every fix is a **new deployment**
(a new manager, usually a new circuit release), and nothing migrates: a ceremony is bound to its
manager by `ctx` and by every signature in it.

So an incident response never patches the chain. It works with the three levers that do exist:
the clients (app and relayer) can stop participating, the organizer can decline to open
decryption (Manual mode), and `t` members can always decrypt off chain from surviving state.

## Severity triage

Decide which of these you are in before doing anything else:

| Class | Meaning | Examples | First move |
|---|---|---|---|
| **Soundness** | Forged data could be accepted as valid | trusted-setup compromise, verifier or circuit bug, point-authentication hole | Suspend participation everywhere; results under affected keys are untrustworthy — plan a rerun |
| **Liveness** | Honest actions are blocked | `submitPartial`/`combine` revert on valid input, a gate predicate stuck | Keep clients up but informed; prepare the off-chain tally path |
| **Peripheral** | Protocol fine, infrastructure broken | app origin down, relayer dry or dead, RPC provider stuck, mirror gone | Fix or rotate the service ([hosting.md](hosting.md)); no protocol consequence |

A soundness bug in the *circuits* also taints off-chain proofs made with the same release;
a soundness bug in the *contracts* usually leaves the off-chain path intact (the math and the
pinned circuits still hold). Note which one you have.

## Suspending client participation

The contract stays open no matter what; what you control is every honest client:

1. **Relayer**: stop the service (or stop sponsorship; the relayer is the only production sender
   the app knows, so this halts all non-technical participation immediately). Every pending
   signed action stays valid — nothing is lost by stopping.
2. **App**: redeploy the static bundle with an incident banner, or replace the origin with a
   static notice page. The app origin is in members' kits ([hosting.md](hosting.md)), so never
   let it serve a known-bad deployment silently. A `statusUrl`/known-issues feed in
   `config.json` (checked and displayed, never trusted for security decisions) is planned so a
   banner does not require a redeploy; until it exists, the redeploy is the kill switch.
3. **Organizers**: tell them, out of band, not to open decryption (Manual mode) and not to run
   the pre-opening drill as if nothing happened. A Scheduled opening or a Manual fallback date
   **cannot be delayed** — the predicate flips by itself — so for those, suspension means the
   clients refuse, not the chain.

None of this stops a determined self-paying user: suspension bounds honest participation, it is
not a lock.

## Communication

There are no notifications in the protocol by design, so every channel is out of band:

- a dated incident notice at the app origin (the one URL members have);
- direct word to every affected organizer, who relays to their members;
- word to the DAVINCI process operators whose elections are bound to affected ceremonies — their
  processes may be stuck in the RESULTS phase (see below);
- a public post-mortem once resolved.

Disclosure timing for a soundness bug (fix-first vs. immediate) is a policy decision —
see "Roles and decision authority" below.

## Exceptional tallying: `t` members decrypt off chain

Shares, aggregates and ciphertexts live in plain contract state forever, so a liveness bug can
delay a tally but cannot destroy it: any `t` honest members can recover their shares, compute
partials and combine **off chain**, with nothing from the broken code path.

**When it is acceptable.** Only when the on-chain path is provably blocked (a liveness bug, not
impatience), the ceremony's opening policy would have been satisfied (the Scheduled or fallback
date has passed, or the organizer consents in Manual mode — the gate binds honest clients even
when the chain cannot enforce it), and the participating members consent. It must never be used
to open results early or to bypass a policy: that is exactly the off-chain collusion the
protocol documents as unpreventable, and doing it officially would make the policy meaningless.

**How to do it verifiably.** The tally must be independently checkable by anyone, or it is just
`t` people asserting numbers:

1. Each member recovers its share `s_i` from current contract state (protocol §8.6) and computes
   `D_i = s_i·C1_k` for every field, **plus the same Groth16 partial proof the contract would
   have verified** (the pinned `partial.circom` statement, proven with the pinned zkey). The
   proof is what makes `D_i` trustworthy without the chain.
2. Combine with the public Lagrange formula (protocol §10.3) and solve the small discrete logs;
   check every field against the exact per-field group equation using the on-chain ciphertexts
   and the member keys recomputed from the on-chain aggregates.
3. Publish a bundle: request id, member set, every `D` vector with its proof and public-input
   vector, the plaintexts, and a signed statement by each participating member (an EIP-712-style
   message over the hash of all of it). Anyone can then re-verify the proofs against the pinned
   verification keys and re-run the combine check from public state.

A runnable CLI for this procedure is planned; until it lands, the SDK primitives (share
recovery, partial, combine) are the procedure and a competent operator drives them. Caveat: with
a development trusted setup the off-chain proofs are only as trustworthy as the setup — one more
reason the DEV release is rehearsal-only.

**The DAVINCI side.** An off-chain tally never reaches `finalizeResultsFromDKG`, so the DAVINCI
process stays in its RESULTS phase on chain. The results are published out of band with the
verification bundle; what the registry record ultimately says about that process is a
governance decision, not a protocol one.

## Cancellation and rerun

- **Registration or Dealing**: abort (permissionless once the ceremony is provably dead, or the
  organizer simply never closes/finalizes) and create a new ceremony — on a *fixed* deployment
  if the bug was in the contracts. Dealing rederivation is deterministic, so members lose only
  time.
- **Live, mid-election**: the ceremony cannot be stopped. The choice is: continue (peripheral
  bug), tally exceptionally (liveness bug), or declare the election void and rerun it on a new
  deployment — new manager, new circuit release if needed, new ceremony, new key, new DAVINCI
  process. Nothing migrates and nothing should: the old key may be exactly what is broken.
- **Soundness bug or setup compromise**: results produced under an affected key cannot be
  trusted, whether decrypted on chain or off. There is no salvage path; rerun is the only
  honest outcome. Say so plainly and early.

## What can never be undone

- **Leaked recovery words or kit files.** A kit holds the root in plaintext; a leak is full
  impersonation of that participant, retroactively, across every ceremony derived from that
  root. There is no share refresh or resharing in any version, and even a future refresh could
  not erase exposure: old ciphertexts stay decryptable by old share sets.
- **`t` members compromised, cumulatively, over the key's lifetime.** Everything ever encrypted
  to that key is readable, forever. The ciphertexts are public chain state; they cannot be
  recalled.
- **An opened decryption.** Opening is irreversible and ceremony-wide; published partials are
  public data the moment they exist.

An incident involving any of these is a confidentiality loss to acknowledge, not a system state
to repair. The response is disclosure, key retirement (stop binding new processes to the
ceremony) and rerun — never a quiet continuation.

## Roles and decision authority

> **TODO(owner) — governance.** This section is a placeholder; the authority model is a decision
> for the project owner, to be settled before the first real election. It must name, per
> deployment:
>
> - who may declare an incident and its severity class;
> - who may stop the relayer and who may change the app (banner, notice page, config);
> - who authorizes an exceptional off-chain tally and who signs the member statement;
> - who speaks publicly for the deployment, and the disclosure policy (timeline, channels,
>   fix-first window for soundness bugs);
> - who decides void-and-rerun for an election, together with the election's own governing body;
> - who funds recovery transactions if the relayer and its operator are gone.
