import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import {
  ArrowRightIcon,
  ChevronRightIcon,
  KeyIcon,
  LockIcon,
  MailIcon,
  PencilIcon,
  ShieldIcon,
  SmartphoneIcon,
  UnlockIcon,
  UserPlusIcon,
  UsersIcon,
} from '../components/icons';
import { Badge, Button, KeyDots } from '../components/ui';
import { shortId } from '../lib/format';
import { updateRecord, type CeremonyRecord } from '../lib/records';

function CommitteeRow({ record }: { record: CeremonyRecord }) {
  const { refreshRecords } = useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(record.name ?? '');
  const save = async () => {
    await updateRecord(record.chainId, record.manager, record.cid, { name: name.trim() || undefined });
    await refreshRecords();
    setEditing(false);
  };
  const organizer = record.role === 'organizer';
  if (editing) {
    return (
      <li className="px-4 py-3 sm:px-5">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="input flex-1"
            aria-label="Committee name (stays on this device)"
            placeholder={`Committee ${shortId(record.cid)}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button variant="primary" size="sm" type="submit">
            Save
          </Button>
        </form>
      </li>
    );
  }
  return (
    <li className="group flex items-center gap-2 pr-2 transition-colors hover:bg-wash/60 sm:pr-3">
      <Link
        to={`/c/${record.cid}`}
        className="flex min-w-0 flex-1 items-center gap-3.5 rounded-lg py-3.5 pl-4 sm:pl-5"
      >
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
            organizer ? 'bg-ink text-white' : 'border border-line bg-wash text-ink'
          }`}
          aria-hidden="true"
        >
          {organizer ? <UsersIcon size={18} /> : <KeyIcon size={18} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{record.name || `Committee ${shortId(record.cid)}`}</span>
          <span className="mt-0.5 block text-sm text-muted first-letter:uppercase">
            {organizer ? 'you run this' : 'you are a member'}
          </span>
        </span>
        <ChevronRightIcon size={18} className="text-faint transition-transform group-hover:translate-x-0.5" />
      </Link>
      <Button variant="ghost" size="sm" className="max-sm:px-2.5" onClick={() => setEditing(true)}>
        <PencilIcon size={15} />
        <span className="sr-only sm:not-sr-only">Rename</span>
      </Button>
    </li>
  );
}

/** The product at a glance: a committee whose key is ready and whose results were opened by 3 of 5. */
function Illustration() {
  const people: [string, string, boolean][] = [
    ['MA', '7F3A91C2', true],
    ['JR', 'B04E6D1F', true],
    ['LP', '29C8A7E0', false],
    ['SK', 'E51D03B9', true],
    ['TN', '6A2F84C5', false],
  ];
  return (
    <div aria-hidden="true" className="relative isolate mx-auto w-full max-w-md select-none lg:mx-0">
      <div className="absolute -inset-4 -z-10 rounded-[28px] bg-linear-to-b from-wash to-transparent" />
      <div className="card overflow-hidden shadow-raised">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Committee</p>
            <p className="mt-0.5 font-semibold text-ink">Annual general meeting</p>
          </div>
          <Badge tone="ok" dot>
            Key ready
          </Badge>
        </div>
        <div className="px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-2">Any 3 of 5 can open the results</p>
            <KeyDots t={3} n={5} />
          </div>
          <ul className="mt-4 space-y-2.5">
            {people.map(([initials, code, turned]) => (
              <li key={code} className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-full bg-wash text-xs font-semibold text-ink-2">
                  {initials}
                </span>
                <span className="font-mono text-xs tracking-wide text-muted">{code}</span>
                <span className="ml-auto">
                  {turned ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ok">
                      <UnlockIcon size={14} /> Key turned
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-faint">
                      <LockIcon size={14} /> Not needed
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-3 border-t border-line bg-wash/60 px-5 py-3.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-ink text-white">
            <UnlockIcon size={16} />
          </span>
          <div className="text-sm">
            <p className="font-medium text-ink">Results opened</p>
            <p className="text-xs text-muted">3 members turned their key together</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function EntryCard({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <section className="card flex flex-col p-6 sm:p-7">
      <span className="flex size-11 items-center justify-center rounded-xl bg-ink text-white">{icon}</span>
      <h2 className="mt-5 text-lg font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-2 flex-1 text-[15px] leading-relaxed text-muted">{children}</div>
      <div className="mt-6 [&>.btn]:w-full sm:[&>.btn]:w-auto">{action}</div>
    </section>
  );
}

const HOW: [string, string][] = [
  [
    'Set up the committee',
    'Choose how many people are on it and how many of them are needed to open the results. You get one personal invitation link per person.',
  ],
  [
    'Members join',
    'Each member opens their link, creates a key on their own device and keeps a recovery kit: twelve words on paper or a small file.',
  ],
  [
    'The key is made together',
    'Once the list is locked, every member adds their part. Votes connected to the committee seal their results with the shared key.',
  ],
  [
    'Open the results together',
    'When it is time to count, enough members turn their key from their browser. No single person can open the results alone.',
  ],
];

const POINTS: [ReactNode, string][] = [
  [<KeyIcon key="k" size={18} />, 'No single person can open the results'],
  [<SmartphoneIcon key="s" size={18} />, 'Works in the browser, phones included'],
  [<ShieldIcon key="h" size={18} />, 'Every step is checked against the public record'],
  [<UsersIcon key="u" size={18} />, 'Committees of 2 to 16 people'],
];

export function Landing() {
  const { records } = useApp();
  const navigate = useNavigate();
  return (
    <div className="space-y-16 sm:space-y-20">
      {/* Phones read the pitch, then the two ways in, then the picture; desktops put the picture beside the pitch. */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-x-16 lg:gap-y-14">
        <div className="lg:col-start-1 lg:row-start-1 lg:self-center">
          <p className="inline-flex rounded-full border border-line bg-white px-3.5 py-1.5 text-sm text-ink-2 shadow-xs">
            For boards, assemblies and election committees
          </p>
          <h1 className="mt-6 text-[40px] leading-[1.06] font-normal tracking-[-0.03em] text-ink sm:text-[54px]">
            Shared keys for elections
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            An election committee is a small group of people you trust — board members, delegates, auditors — who
            together hold the key that keeps a vote’s results sealed. No one can open them alone: only enough
            members together, when the time comes.
          </p>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
            Members join from a personal link in about two minutes. Nothing to install, nothing to pay.
          </p>
        </div>

        <div className="order-last lg:order-none lg:col-start-2 lg:row-start-1 lg:self-center">
          <Illustration />
        </div>

        {records.length > 0 && (
          <section aria-labelledby="your-committees" className="min-w-0 space-y-4 lg:col-span-2">
            <div className="flex items-end justify-between gap-4">
              <h2 id="your-committees" className="text-xl font-semibold tracking-tight text-ink">
                Your committees
              </h2>
              <p className="hidden text-sm text-muted sm:block">Names stay on this device.</p>
            </div>
            <ul className="card divide-y divide-line overflow-hidden">
              {records.map((r) => (
                <CommitteeRow key={r.key} record={r} />
              ))}
            </ul>
          </section>
        )}

        <div className="grid gap-5 md:grid-cols-2 lg:col-span-2">
          <EntryCard
            icon={<UserPlusIcon size={22} />}
            title="Create a committee"
            action={
              <Button size="lg" onClick={() => navigate('/new')}>
                Start a new committee
                <ArrowRightIcon size={18} />
              </Button>
            }
          >
            For organizers. Pick how many members there are and how many of them are needed to open the results,
            then hand out the invitations. It takes about five minutes.
          </EntryCard>
          <EntryCard
            icon={<MailIcon size={22} />}
            title="I was invited"
            action={
              <Button variant="secondary" size="lg" onClick={() => navigate('/restore')}>
                Restore from a recovery kit
              </Button>
            }
          >
            Open the personal link you were sent — it brings you straight to the right place. On a new device, or
            cleared this browser? Bring your key back with your twelve words or your kit file.
          </EntryCard>
        </div>
      </div>

      <section aria-labelledby="how-it-works">
        <p className="eyebrow text-center">How it works</p>
        <h2 id="how-it-works" className="mt-3 text-center text-[28px] leading-tight font-normal tracking-[-0.02em] text-ink sm:text-[32px]">
          From invitation to opened results
        </h2>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOW.map(([title, text], i) => (
            <li key={title} className="card p-6">
              <span className="flex size-8 items-center justify-center rounded-full bg-ink text-sm font-medium text-white">
                {i + 1}
              </span>
              <h3 className="mt-4 font-semibold text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <ul className="grid gap-x-8 gap-y-4 border-y border-line py-7 sm:grid-cols-2 lg:grid-cols-4">
        {POINTS.map(([icon, text]) => (
          <li key={text} className="flex items-center gap-3 text-sm text-ink-2">
            <span className="text-ink">{icon}</span>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
