import { useEffect, useState } from 'react';
import { Archive, Images, LoaderCircle } from 'lucide-react';

export type GalleryEntry = {
  id: string;
  createdAt: string;
  a: { name: string };
  b: { name: string };
  surfaces: true;
};

function formatWhen(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function Gallery({
  refreshKey,
  onOpen,
}: {
  refreshKey: number;
  onOpen: (entry: GalleryEntry) => void;
}) {
  const [entries, setEntries] = useState<GalleryEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetch('/api/gallery')
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<GalleryEntry[]>;
      })
      .then((data) => {
        if (cancelled) return;
        setEntries(data);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <section className="gallery">
      <div className="gallery-title">
        <span>
          <Images size={14} /> GALLERY
        </span>
        <small>
          {status === 'loading'
            ? 'LOADING ARCHIVE…'
            : status === 'error'
              ? 'ARCHIVE UNAVAILABLE'
              : `${entries.length} SAVED PAIR${entries.length === 1 ? '' : 'S'}`}
        </small>
      </div>

      {status === 'loading' ? (
        <div className="gallery-empty">
          <LoaderCircle size={16} className="spin" />
          READING SAVED MODELS + UV MAPS
        </div>
      ) : entries.length === 0 ? (
        <div className="gallery-empty">
          <Archive size={16} />
          NO ARCHIVED PAIRS YET
          <br />
          EXCHANGE A PAIR TO SAVE BOTH GLBS AND UV ATLASES
        </div>
      ) : (
        <div className="gallery-grid">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="gallery-card"
              onClick={() => onOpen(entry)}
            >
              <div className="gallery-atlases">
                <img
                  src={`/api/gallery/${entry.id}/surface-a.png`}
                  alt={`${entry.a.name} UV`}
                />
                <img
                  src={`/api/gallery/${entry.id}/surface-b.png`}
                  alt={`${entry.b.name} UV`}
                />
              </div>
              <div className="gallery-pair">
                <span>
                  {entry.a.name.replace(/\.glb$/i, '')} <i>↔</i>{' '}
                  {entry.b.name.replace(/\.glb$/i, '')}
                </span>
                <small>
                  <Archive size={11} /> {formatWhen(entry.createdAt)} · 2 GLB + 2 UV
                </small>
              </div>
              <b>OPEN PAIR</b>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
