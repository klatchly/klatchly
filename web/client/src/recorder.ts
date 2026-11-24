import { parseWebmOpus, toOggOpus } from './oggopus';
import type { Chat, SupportLevel } from './types';
import { attachmentPlanFor } from '../../server/attachplan';
import { canAttach } from './caps';

// Voice messages: MediaRecorder with a format picked by feature detection, then the format the chat's
// network accepts for voice notes (capabilities["org.matrix.msc3245.voice"]), remuxing Chromium's
// WebM/Opus to Ogg/Opus when needed (WhatsApp). Falls back to a plain audio attachment when the network
// takes no voice note in any format we can produce.

const VOICE = 'org.matrix.msc3245.voice';
const RECORD_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];

export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export function recordType(): string | undefined {
  if (!canRecord()) return undefined;
  return RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
}

function level(types: Record<string, SupportLevel> | undefined, mime: string): number {
  if (!types) return -2;
  const base = mime.split(';')[0]!.trim();
  const keys = [mime, mime.replace(';', '; '), base, `${base.split('/')[0]}/*`, '*/*'];
  for (const k of keys) if (k in types) return types[k]!;
  return -2;
}

export interface VoicePlan {
  /** Final container: what we upload. */
  mime: 'audio/ogg' | 'audio/webm' | 'audio/mp4';
  remux: boolean;
  /** voice-note when the network takes it as such, else a regular audio attachment. */
  type: 'voice-note' | 'audio';
  maxDuration?: number;
}

/** What to send for a recording made as `recorded` in this chat. */
/**
 * Whether a voice message can go (the mic button): as voicePlan would send it, a voice note the network takes, or
 * audio whose plan is ok. Not where only pictures go (a connector that sends photos only); no capabilities known: wherever files go.
 */
export function canSendVoice(chat: Chat | undefined): boolean {
  if (!canAttach(chat)) return false;
  const c = chat?.capabilities;
  if (!c || !Object.keys(c).length || !c.attachments) return true;
  const plan = voicePlan(chat, recordType() ?? 'audio/webm;codecs=opus');
  return plan.type === 'voice-note' || attachmentPlanFor(c, plan.mime, 1).ok;
}

export function voicePlan(chat: Chat | undefined, recorded: string): VoicePlan {
  const opus = /opus/.test(recorded) || recorded.startsWith('audio/ogg');
  const options: { mime: VoicePlan['mime']; full: string; remux: boolean }[] = recorded.startsWith('audio/mp4')
    ? [{ mime: 'audio/mp4', full: 'audio/mp4', remux: false }]
    : recorded.startsWith('audio/ogg')
      ? [{ mime: 'audio/ogg', full: 'audio/ogg; codecs=opus', remux: false }]
      : [
          ...(opus ? [{ mime: 'audio/ogg' as const, full: 'audio/ogg; codecs=opus', remux: true }] : []),
          { mime: 'audio/webm', full: 'audio/webm; codecs=opus', remux: false },
        ];
  const atts = chat?.capabilities?.attachments;
  if (!atts || !Object.keys(chat?.capabilities ?? {}).length) return { ...options[0]!, type: 'voice-note' };
  const voice = atts[VOICE] as { mimeTypes?: Record<string, SupportLevel>; maxDuration?: number } | undefined;
  for (const min of [2, 1]) {
    const o = options.find((x) => level(voice?.mimeTypes, x.full) >= min);
    if (o) return { mime: o.mime, remux: o.remux, type: 'voice-note', ...(voice?.maxDuration ? { maxDuration: voice.maxDuration } : {}) };
  }
  const audio = atts['m.audio']?.mimeTypes;
  const o = options.find((x) => level(audio, x.full) >= 1) ?? options[0]!;
  return { mime: o.mime, remux: o.remux, type: 'audio' };
}

export interface Recorded {
  file: File;
  duration: number;
  plan: VoicePlan;
}

/** One recording session; the microphone is released on stop/cancel. */
export class Recorder {
  private rec?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private ctx?: AudioContext;
  private raf = 0;
  private startedAt = 0;
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }

  /** Must be called from a user gesture (microphone permission prompt). */
  async start(onLevel: (level: number, seconds: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.rec = new MediaRecorder(this.stream, { mimeType: this.type, audioBitsPerSecond: 32_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.startedAt = performance.now();
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4), (performance.now() - this.startedAt) / 1000);
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // no level meter; recording still works
    }
  }

  private release() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
  }

  cancel(): void {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.release();
    this.chunks = [];
  }

  async stop(chat: Chat | undefined): Promise<Recorded | null> {
    const rec = this.rec;
    if (!rec) return null;
    const seconds = (performance.now() - this.startedAt) / 1000;
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      if (rec.state !== 'inactive') rec.stop();
      else resolve();
    });
    this.release();
    const raw = new Blob(this.chunks, { type: this.type.split(';')[0] });
    this.chunks = [];
    if (seconds < 0.5 || !raw.size) return null;
    let plan = voicePlan(chat, this.type);
    let blob: Blob = raw;
    let duration = seconds;
    if (plan.remux) {
      const parsed = parseWebmOpus(new Uint8Array(await raw.arrayBuffer()));
      if (parsed) {
        const ogg = toOggOpus(parsed);
        blob = new Blob([ogg.bytes as Uint8Array<ArrayBuffer>], { type: 'audio/ogg' });
        duration = ogg.duration || seconds;
      } else plan = { ...plan, mime: 'audio/webm', remux: false };
    }
    const ext = plan.mime === 'audio/ogg' ? 'ogg' : plan.mime === 'audio/mp4' ? 'm4a' : 'webm';
    const file = new File([blob], `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, { type: plan.mime });
    return { file, duration: Math.round(duration * 10) / 10, plan };
  }
}
