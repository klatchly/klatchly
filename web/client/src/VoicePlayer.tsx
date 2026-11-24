import { useEffect, useRef, useState } from 'react';
import { useT } from './i18n';
import { duration as fmt } from './format';

const SPEEDS = [1, 1.5, 2];

/** Compact voice-note player: play/pause, seekable progress, time, playback speed 1× / 1.5× / 2×. */
export function VoicePlayer({ src, seconds }: { src?: string; seconds?: number }) {
  const t = useT();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(seconds ?? 0);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    const a = audio.current;
    if (a) a.playbackRate = SPEEDS[speed]!;
  }, [speed]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setPlaying(false));
    else a.pause();
  };
  const seek = (fraction: number) => {
    const a = audio.current;
    const d = Number.isFinite(a?.duration) && a!.duration ? a!.duration : total;
    if (!a || !d) return;
    a.currentTime = Math.max(0, Math.min(d, fraction * d));
    setPos(a.currentTime);
  };
  const seekAt = (el: HTMLElement, x: number) => {
    const r = el.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (x - r.left) / r.width)));
  };
  const progress = total ? Math.min(1, pos / total) : 0;

  return (
    <div className={`voice ${playing ? 'playing' : ''}`} data-testid="voice-player">
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPos(0);
          }}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setTotal(e.currentTarget.duration)}
        />
      )}
      <button type="button" className="voice-play" aria-label={playing ? t.msg.pause : t.msg.play} data-testid="voice-play" disabled={!src} onClick={toggle}>
        {playing ? (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
          </svg>
        )}
      </button>
      {/* 24 px tall to hit with a finger; the visible bar is 6 px. Tap or drag to seek. */}
      <div
        className="voice-track"
        role="slider"
        tabIndex={0}
        aria-label={t.msg.position}
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(pos)}
        data-testid="voice-track"
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekAt(e.currentTarget, e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture?.(e.pointerId)) seekAt(e.currentTarget, e.clientX);
        }}
        // The bubble's own touch gestures (swipe to reply, long-press) stay out of a drag here.
        onTouchStart={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seek((pos + 5) / (total || 1));
          if (e.key === 'ArrowLeft') seek((pos - 5) / (total || 1));
        }}
      >
        <span className="voice-line">
          <span className="voice-fill" style={{ width: `${progress * 100}%` }} />
        </span>
      </div>
      <span className="voice-time">{fmt(playing || pos ? pos : total)}</span>
      <button
        type="button"
        className="voice-speed"
        aria-label={t.msg.speed(String(SPEEDS[speed]))}
        data-testid="voice-speed"
        onClick={() => setSpeed((s) => (s + 1) % SPEEDS.length)}
      >
        {SPEEDS[speed]}×
      </button>
    </div>
  );
}
