# Hosting and mirror policy

What has to stay online, for how long, and with how many independent copies, for every committee
a deployment ever created. The rule of thumb: a committee's results may be opened six months
after the ceremony, so **everything a returning member needs must survive for the life of the
longest-lived ceremony on the deployment** — not for the life of the current release, the
current host or the current operator.

What a returning member needs (architecture §6.6): the chain state (the chain's problem), two
working RPC providers, a hosted copy of a compatible app with its six pinned circuit files, a
relayer or any funded sender, and `t` members' recovery words (the organizer's problem —
[organizer-guide.md](organizer-guide.md)). This document is about the middle three.

## One origin per deployment — the app URL is part of the kit

Every exported recovery kit records the app origin (`appUrl`) it was made at. Months later that
URL is what a member types; the app at it must be a build pinned to the **same deployment**
(manager, chain, artifact set) or it can only turn the member away.

- **Never reuse an origin for a new manager.** A v2 stack gets a new origin; the old origin
  keeps serving the old deployment for the life of its ceremonies. Versioned origins make this
  stick (`council-v1.example.org` frozen forever, `council-v2.example.org` next, a bare
  `council.example.org` that only redirects to the newest).
- **Keep legacy deployments listed.** The app's `config.json` names one *current* deployment
  (new committees) and may carry older managers on the same chain in `legacyDeployments`
  (architecture §6): their kits and links keep resolving on the same origin, each with its own
  relayers. Operators keep a copy of each historical config (and an origin serving it) as long
  as any of its ceremonies could still open. Decommissioning an origin while a ceremony under it
  is Live is an incident, not a cleanup.

## Circuit artifacts: several independent mirrors

The SDK pins the sha256 of all six circuit files and stream-verifies every byte, so **any mirror
is trustworthy** — the only real failure mode is *zero surviving copies*, not a wrong copy.
Policy for a production deployment:

- at least **two mirrors on independent infrastructure** (different providers, different billing
  relationships), both CORS-enabled and both listed up front in the app's `artifactsBaseUrls`
  (architecture §6) so the app fails over by itself — no config change on the day a mirror dies.
  A `{release}` placeholder in an entry keeps one mirror layout valid across releases;
- the canonical GitHub release counts as a mirror for Node clients, CI and scripts only: its
  downloads redirect without CORS headers, so browsers cannot read it even once the repository
  is public. The app's own origin serving the files counts as a browser mirror only if the app
  has a second copy elsewhere (otherwise one outage takes both);
- the files are ~78 MB per release and immutable: a dumb static bucket is enough.

What runs today: every release is on the DAVINCI CDN
(`https://davinci-assets.fra1.cdn.digitaloceanspaces.com/council/<release>/`, DigitalOcean
Spaces, public), which the SDK and the scripts try first, and on the GitHub release second. The
hosted apps list a copy baked into the app's own image (`/<release>/` on its origin) first, then
the CDN, then the GitHub release. A browser can read the CDN only once the bucket's CORS rule is
set (and the CDN cache purged); until then the app's own copy is the only one a browser can use,
and a refused mirror just falls through to the next. The Sepolia rehearsal app still runs its only relayer on the same Railway hobby
project as the app; the Gnosis production beta does too (its own project). Neither has a
standby relayer or a second app copy yet: a single point of failure each, acceptable for a beta
whose operators watch it, and the first thing to add before a deployment carries elections that
cannot wait for a redeploy.

## A second app copy

Pre-stage the exact app build on a **second provider**: same image (pin the tag *and* digest),
same `config.json`. It can sit cold; what matters is that losing the primary host (billing, ToS,
platform exit) four months into an election is a DNS/announcement problem, not a rebuild
problem. Archive, per deployment, so that *anyone* can rebuild a dead host:

- the app image reference (tag + digest) and the rendered `config.json`;
- the six circuit files with their sha256s and `release.json`;
- the manager address, views address, deployment block and chain id;
- the SDK version (or any compatible client) and a snapshot of the docs.

## Relayer redundancy

The relayer holds no user secrets and no protocol state (its state file is budgets and quotas
only), so a standby is cheap: a second funded key nothing else uses, the same `COUNCIL_*`
environment, pointed at the same manager. The recovery procedure when the primary dies:

1. start the standby (or any fresh relayer) — no state handover is needed; a restarted combine
   worker re-sources everything it needs from state and bounded log reads;
2. if the standby was already listed in the app's `relayerUrls` (architecture §6), nothing else:
   the app fails over to it by itself. Otherwise add it there (a config redeploy) — target well
   under an hour;
3. fund and size its budget as the primary's ([relayer.md](relayer.md)), and register the open
   ceremonies with it (`POST /v1/track`, [relayer.md](relayer.md)) so its combine worker serves
   them without waiting for log discovery.

A production deployment should list the standby in `relayerUrls` from day one. The app still
offers no *user-entered* relayer override, so adding a relayer the config never named is strictly
an operator action — the committee waits until it is done. (Relayers add no trust either way:
every action is signed and a relayer can alter nothing.) Protocol-level, any funded account can also send every action
directly — that is the floor the ecosystem can always fall back to, not something to expect of a
non-technical committee.

## Public RPC policy

The app performs every security-relevant read against **all** configured providers and requires
them to agree on the finalized block: safety over availability, N-of-N, by design (protocol
§9.3). The operational consequences:

- **At least two independently administered providers**, always; on a production chain the app
  refuses to run with fewer.
- **One lagging or frozen provider stalls every read** — agreement is N-of-N, not 2-of-3, so a
  third provider adds another thing that can halt you, not headroom. Add a third only if it is
  well maintained (the 1rpc Sepolia endpoint froze at the pre-fork block and would have stopped
  the app; it was removed).
- **Rotation is a config redeploy**: there is deliberately no in-app provider override. Keep a
  vetted replacement provider on file and document who performs the rotation and how fast
  (target: same day).
- **Provider hygiene is an active duty**: a quarterly review plus a pre-opening check
  ([organizer-guide.md](organizer-guide.md)) — each provider current, serving the finalized
  block, agreeing with the others; before a hard fork, confirm fork support
  ([forks.md](forks.md)).

## Monitoring (external, synthetic)

The app is telemetry-free and the relayer exposes one health endpoint, so monitoring lives
outside, run by the deployment operator:

- app origin up; the six artifact files answering 200 **and hashing to their pins**, on every
  mirror, on a schedule;
- relayer `/v1/health` up, `balanceWei` above threshold ([organizer-guide.md](organizer-guide.md)
  has numbers; confirm field names against `relayer/README.md` as the relayer's metrics evolve);
- an RPC probe performing the same finalized-block agreement check the app does, per provider,
  alerting on sustained lag or divergence;
- calendar watchers around each committee's known dates (opening day, fallback dates, dealing
  deadlines).
