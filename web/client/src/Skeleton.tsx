// Placeholders while the first page loads: the shape of what is coming instead of a bare "…".

const BUBBLES: { own: boolean; w: number; h: number }[] = [
  { own: false, w: 62, h: 38 },
  { own: false, w: 44, h: 38 },
  { own: true, w: 56, h: 38 },
  { own: false, w: 70, h: 58 },
  { own: true, w: 38, h: 38 },
  { own: true, w: 64, h: 58 },
  { own: false, w: 50, h: 38 },
];

export function MessagesSkeleton() {
  return (
    <div className="skeleton-msgs" aria-hidden="true" data-testid="skeleton">
      {BUBBLES.map((b, i) => (
        <div key={i} className={`skeleton-bubble ${b.own ? 'own' : ''}`} style={{ width: `${b.w}%`, height: b.h }} />
      ))}
    </div>
  );
}

export function ChatsSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div className="skeleton-chats" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-avatar" />
          <span className="skeleton-lines">
            <span className="skeleton-line" style={{ width: `${45 + ((i * 37) % 35)}%` }} />
            <span className="skeleton-line short" style={{ width: `${60 + ((i * 23) % 30)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}
