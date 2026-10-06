import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { Button, Card, Note } from '../components/ui';
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
  if (editing) {
    return (
      <li className="py-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="flex-1 rounded border border-ink/15 px-2 py-1 text-sm"
            aria-label="Committee name (stays on this device)"
            placeholder={`Committee ${shortId(record.cid)}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button variant="secondary" type="submit">
            Save
          </Button>
        </form>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 py-3">
      <Link to={`/c/${record.cid}`} className="flex flex-1 items-center justify-between hover:text-accent">
        <span className="font-medium">{record.name || `Committee ${shortId(record.cid)}`}</span>
        <span className="text-xs text-ink/50">{record.role === 'organizer' ? 'you run this' : 'you are a member'}</span>
      </Link>
      <Button variant="secondary" onClick={() => setEditing(true)}>
        Rename
      </Button>
    </li>
  );
}

export function Landing() {
  const { records } = useApp();
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <Card>
        <h1 className="mb-2 text-xl font-bold">Shared keys for elections</h1>
        <p className="text-sm leading-relaxed text-ink/80">
          A small group of people jointly holds the key that locks an election’s results. No single person can
          open it alone — only enough of you together.
        </p>
      </Card>

      {records.length > 0 && (
        <Card title="Your committees">
          <ul className="divide-y divide-ink/10">
            {records.map((r) => (
              <CommitteeRow key={r.key} record={r} />
            ))}
          </ul>
        </Card>
      )}

      <Card title="Start or join">
        <div className="flex flex-col gap-3">
          <Button onClick={() => navigate('/new')}>Start a new committee</Button>
          <Note tone="info">
            Got an invitation? Just open the link you were sent — it brings you straight to the right place.
          </Note>
          <Button variant="secondary" onClick={() => navigate('/restore')}>
            Restore from a recovery kit
          </Button>
        </div>
      </Card>
    </div>
  );
}
