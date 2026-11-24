import type { FileKind } from './files';

// A page with a folded corner, tinted by kind, the extension written on it (up to 4 letters).
const TINT: Record<FileKind, string> = {
  pdf: '#d93025',
  doc: '#2b6fd6',
  sheet: '#188038',
  slides: '#e8710a',
  archive: '#9a6a00',
  audio: '#8e44ad',
  video: '#c2185b',
  image: '#00897b',
  text: '#5f6b7a',
  generic: '#6b7785',
};

export function FileIcon({ kind, ext, size = 40 }: { kind: FileKind; ext: string; size?: number }) {
  const label = ext.slice(0, 4).toUpperCase();
  return (
    <svg className="file-icon" viewBox="0 0 40 48" width={size * (40 / 48)} height={size} aria-hidden="true" data-kind={kind}>
      <path d="M4 2h22l10 10v32a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill={TINT[kind]} />
      <path d="M26 2v8a2 2 0 0 0 2 2h8z" fill="#fff" opacity="0.45" />
      {label && (
        <text x="19" y="36" textAnchor="middle" fontSize={label.length > 3 ? 9 : 10.5} fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">
          {label}
        </text>
      )}
    </svg>
  );
}
