import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '../../../client/src/sdk';
import type { ComposerMenuProps, SpaceListProps, SpaceMainProps } from '../../../client/src/sdk';
import { countText } from '../words';
import { exampleApi, keys } from './api';
import { useT } from './i18n';
import './example.css';

// The Example chunk: every component client/index.tsx plugs into the core's slots (by these export names), with
// its strings and styles. Loaded the first time one of them shows (the space, the ✨ menu, the Settings page).
//
// Conventions the core's tests hold every package to:
// - CSS classes: the core's (styles.css: .space-*, .set-*, .assist-*…) or the package's own, prefixed with its id
//   (example.css: .example-*), never another package's;
// - strings: the core's catalog or the package's (useT()), never another package's; no text written in a component;
// - test ids (data-testid) prefixed with the package id, so end-to-end scripts find them and nothing collides.

/** The greeting card: the server route's answer. In the list (the page on a phone) and the main pane (wide screens). */
function HelloCard() {
  const t = useT();
  // React Query (the app's own cache): fetched once, refetched on demand; a package namespaces its keys.
  const hello = useQuery({ queryKey: keys.hello, queryFn: exampleApi.hello });
  if (hello.isError) return <p className="space-banner warn" data-testid="example-unavailable">{t.example.unavailable}</p>;
  if (!hello.data) {
    return (
      <div className="space-skeleton" aria-hidden="true">
        <div className="skeleton-line" />
        <div className="skeleton-line short" />
      </div>
    );
  }
  const { greeting, startedAt, calls } = hello.data;
  return (
    <section className="space-card" data-testid="example-card">
      <h2 className="space-h">{t.example.serverSays}</h2>
      <p className="example-greeting" data-testid="example-greeting">{greeting ?? t.example.defaultGreeting}</p>
      <p className="space-note" data-testid="example-calls">
        {t.example.calls(calls)}
        {startedAt && ` · ${t.example.startedAt(relativeTime(startedAt))}`}
      </p>
      <div>
        <button type="button" className="space-btn" data-testid="example-refresh" disabled={hello.isFetching} onClick={() => void hello.refetch()}>
          {t.example.refresh}
        </button>
      </div>
    </section>
  );
}

/** The space's list column: the core's header (connection dot, section tabs, Settings button) and the card. */
export function ExampleList({ online, onSettings, settingsIcon, tabs }: SpaceListProps) {
  const t = useT();
  return (
    <>
      <header className="list-header space-header sections-header">
        <span className={`conn-dot ${online ? 'on' : 'off'}`} title={online ? t.shell.connected : t.shell.reconnecting} />
        {tabs}
        <span className="header-actions">
          <button type="button" className="icon-btn" aria-label={t.shell.settings} title={t.shell.settings} data-testid="open-settings" onClick={onSettings}>
            {settingsIcon}
          </button>
        </span>
      </header>
      <div className="space-scroll example-list" data-testid="example-list">
        <p className="space-note">{t.example.intro}</p>
        <HelloCard />
        <p className="space-note">{t.example.tryIt}</p>
      </div>
    </>
  );
}

/** The right pane: the space's home (it has no places: `place` is always undefined here). */
export function ExampleMain(_: SpaceMainProps) {
  const t = useT();
  return (
    <div className="conversation space-main" data-testid="example-main">
      <header className="conv-header">
        <div className="conv-title">
          <span className="conv-name">{t.example.title}</span>
          <span className="conv-sub">{t.example.subtitle}</span>
        </div>
      </header>
      <div className="space-board narrow">
        <HelloCard />
        <p className="space-note">{t.example.tryIt}</p>
      </div>
    </div>
  );
}

/** The stored preference, shared by the ✨ section and the Settings page (one query, one cache entry). */
const usePrefs = () => useQuery({ queryKey: keys.prefs, queryFn: exampleApi.prefs });

/**
 * Its section of the composer's ✨ menu: direct children of the menu, buttons with role="menuitem". `api` is what
 * the composer hands an augmentation (the draft's text, rewrite, run, fill, notify); this one only reads the text
 * and shows a line in the conversation's toast. Nothing leaves the browser.
 */
export function ExampleMenu({ api, close }: ComposerMenuProps) {
  const t = useT();
  const prefs = usePrefs();
  const count = () => {
    const { words, characters } = countText(api.text);
    api.notify(prefs.data?.characters ? t.example.wordsAndCharacters(words, characters) : t.example.words(words));
    close();
  };
  return (
    <>
      <p className="assist-h">{t.example.menuHeading}</p>
      <button type="button" role="menuitem" disabled={!api.text} data-testid="example-count" onClick={count}>
        {t.example.countWords}
      </button>
    </>
  );
}

/**
 * Settings → Example (/settings/ext/example/prefs): rows of the core's Settings (its .set-* classes). A change is
 * saved at once, the cache updated from the server's answer. A sensitive setting (a key, where data goes) would
 * guard its route with the server sdk's requireStepUp and show the sdk's StepUpBox here.
 */
export function ExampleSettings() {
  const t = useT();
  const qc = useQueryClient();
  const prefs = usePrefs();
  const [note, setNote] = useState<string>();
  const save = useMutation({
    mutationFn: exampleApi.setPrefs,
    onSuccess: (p) => {
      qc.setQueryData(keys.prefs, p);
      setNote(t.example.saved);
    },
    onError: () => setNote(t.example.failed),
  });
  return (
    <div data-testid="example-settings">
      <div className="set-row" role="group" aria-labelledby="example-characters-label" data-testid="example-characters-row">
        <div className="set-text">
          <h3 className="set-label" id="example-characters-label">
            {t.example.charactersLabel}
          </h3>
          <p className="settings-hint">{t.example.charactersHint}</p>
        </div>
        <div className="set-control">
          <input
            type="checkbox"
            aria-labelledby="example-characters-label"
            checked={prefs.data?.characters ?? false}
            disabled={!prefs.data || save.isPending}
            data-testid="example-characters"
            onChange={(e) => save.mutate({ characters: e.target.checked })}
          />
        </div>
      </div>
      {note && (
        <p className="settings-note" role="status" data-testid="example-note">
          {note}
        </p>
      )}
    </div>
  );
}
