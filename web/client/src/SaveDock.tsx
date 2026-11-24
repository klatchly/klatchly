// Progress of a file fetched for the share sheet (iOS), then the "Tap to save" button the second tap needs,
// or a short note ("Image copied"). One per place that can save: the conversation, the lightbox and the file
// viewer (both modal dialogs, where anything outside is inert), each showing the tasks started there.
import { useT } from './i18n';
import { dismissTask, manyState, retryFetch, retryMany, shareManyReady, shareReady, useFileEntry, useTask, type Scope } from './save';

export function SaveDock({ scope }: { scope: Scope }) {
  const t = useT();
  const task = useTask(scope);
  const entry = useFileEntry(task?.kind === 'share' ? task.target.src : undefined);
  if (!task) return null;
  if (task.kind === 'note') {
    return (
      <div className="save-dock note" role="status" data-testid="save-note">
        {task.text === 'copied' ? t.media.copied : t.media.copyFailed}
      </div>
    );
  }
  const close = (
    <button type="button" className="save-dock-close" aria-label={t.common.close} data-testid="save-dock-close" onClick={dismissTask}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </button>
  );
  if (task.kind === 'shareMany') {
    // Several files (the chat's media page): one bar for all, then one tap for one share sheet with every file.
    const st = manyState(task.targets);
    if (task.error === 'unshareable' || st.status === 'error') {
      return (
        <div className="save-dock error" role="alert" data-testid="save-dock" data-state="error">
          <span className="save-dock-text">{task.error === 'unshareable' ? t.media.cannotShare : st.tooLarge ? t.media.tooLarge : t.media.fetchFailed}</span>
          {!task.error && !st.tooLarge && (
            <button type="button" className="text-btn" onClick={() => retryMany(task.targets)}>
              {t.common.retry}
            </button>
          )}
          {close}
        </div>
      );
    }
    if (st.status === 'ready') {
      return (
        <div className="save-dock ready" data-testid="save-dock" data-state="ready">
          <button type="button" className="save-dock-go" data-testid="save-dock-go" autoFocus onClick={() => shareManyReady(task.targets)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{t.media.tapToSave} ({task.targets.length})</span>
          </button>
          {close}
        </div>
      );
    }
    const pctMany = st.total ? Math.min(99, Math.floor((st.loaded / st.total) * 100)) : null;
    return (
      <div className="save-dock" role="status" data-testid="save-dock" data-state="loading">
        <span className="save-dock-bar" aria-hidden="true">
          <span style={{ width: pctMany === null ? undefined : `${pctMany}%` }} className={pctMany === null ? 'indeterminate' : ''} />
        </span>
        <span className="save-dock-text">
          {t.media.preparing(pctMany)}
          <span className="save-dock-name"> · {t.gallery.selected(task.targets.length)}</span>
        </span>
        {close}
      </div>
    );
  }
  if (task.error === 'unshareable' || entry?.status === 'error') {
    const msg = task.error === 'unshareable' ? t.media.cannotShare : entry?.status === 'error' && entry.reason === 'too-large' ? t.media.tooLarge : t.media.fetchFailed;
    return (
      <div className="save-dock error" role="alert" data-testid="save-dock" data-state="error">
        <span className="save-dock-text">{msg}</span>
        {entry?.status === 'error' && entry.reason === 'failed' && (
          <button type="button" className="text-btn" onClick={() => retryFetch(task.target)}>
            {t.common.retry}
          </button>
        )}
        {close}
      </div>
    );
  }
  if (entry?.status === 'ready') {
    return (
      <div className="save-dock ready" data-testid="save-dock" data-state="ready">
        <button type="button" className="save-dock-go" data-testid="save-dock-go" autoFocus onClick={() => shareReady(task.target)}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{t.media.tapToSave}</span>
        </button>
        {close}
      </div>
    );
  }
  const pct = entry?.status === 'loading' && entry.total ? Math.min(99, Math.floor((entry.loaded / entry.total) * 100)) : null;
  return (
    <div className="save-dock" role="status" data-testid="save-dock" data-state="loading">
      <span className="save-dock-bar" aria-hidden="true">
        <span style={{ width: pct === null ? undefined : `${pct}%` }} className={pct === null ? 'indeterminate' : ''} />
      </span>
      <span className="save-dock-text">
        {t.media.preparing(pct)}
        <span className="save-dock-name"> · {task.target.name}</span>
      </span>
      {close}
    </div>
  );
}
