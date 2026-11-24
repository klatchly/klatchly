import { useMemo } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { packages as listed } from '../../ext/packages.client';
import { activeSpaces, byOrder, isSpaceLink as isLinkOf, moduleInfo, moduleOn, packageOn, spacePlace, type ExtensionsReply, type ModuleInfo } from '../../server/extension';
import { api } from './endpoints';
import { lowPriorityShown, useConnectorTraits } from './connectors';
import { SETTINGS_SEGMENT } from './settingsroute';
import type { AugmentationUI, ConnectorUI, PackageFrame, SettingsSection, SpaceModule } from './extension';

// The client's view of the packages (see extension.ts): the one import of ext/ on this side. Routing knows every
// space of the build, so a link opens one before the server has answered; the sidebar shows only the spaces of
// the packages the server says are on (GET /api/extensions), with the same URLs as on the server. Augmentations
// and settings sections, too, show only once the server has said their package is on. The connectors' UI sides
// are handed to connectors.ts as this loads. Everything follows the packages' declared order (PackageInfo.order),
// not their place in ext/packages.client.ts: sidebar spaces, slots, sections. The server may turn packages off and
// on while the app runs (Settings → Extensions): it then sends an 'extensions' frame and this asks again.

const packages = [...listed].sort(byOrder);
const owned = packages.flatMap((p) => p.modules.flatMap((m) => (m.type === 'space' ? [{ pkg: p.id, space: m }] : [])));
export const spaces: readonly SpaceModule[] = owned.map((x) => x.space);
const augmentations = packages.flatMap((p) => p.modules.flatMap((m) => (m.type === 'augmentation' ? [{ pkg: p.id, aug: m }] : [])));
const sections = packages.flatMap((p) => (p.settings ?? []).map((section) => ({ pkg: p.id, section })));
// What the connectors' chats and media are like (connectors.ts): known from the build, before the server answers.
useConnectorTraits(packages.flatMap((p) => p.modules.filter((m): m is ConnectorUI => m.type === 'connector')));

/** The space a path is in, and the place it shows (undefined: its home). */
export function spaceAt(path: string): { space: SpaceModule; place: string | undefined } | undefined {
  for (const space of spaces) {
    const m = spacePlace(space, path);
    if (m) return { space, place: m.place };
  }
  return undefined;
}

/** A space's home ('/example'), or one of its places that is a list too: a list, like the chat list. */
export const isSpaceHome = (path: string): boolean =>
  spaces.some((s) => s.path === path || (s.listPlaces ?? []).some((p) => path === `${s.path}/${p}`));

/** Whether a URL is a deep link of a space (a notification target). */
export const isSpaceLink = (url: string): boolean => spaces.some((s) => isLinkOf(s, url));

export const EXTENSIONS = ['extensions'] as const;
const useExtensions = () => useQuery({ queryKey: EXTENSIONS, queryFn: api.extensions, staleTime: Infinity, retry: 1 }).data;

/** The ids of the build's connectors the server has on (undefined until it has said). */
function connectorsOn(data: ExtensionsReply | undefined): ReadonlySet<string> | undefined {
  if (!data) return undefined;
  return new Set(packages.flatMap((p) => p.modules.filter((m) => m.type === 'connector' && moduleOn(data, p.id, 'connector', m.id)).map((m) => m.id)));
}

/**
 * Whether the low-priority inbox shows (connectors.ts lowPriorityShown): a connector that keeps one is on. Before the
 * server has said, the build's; a connector turned off while the app runs takes the tab and its query away.
 */
export function useLowPriorityShown(): boolean {
  const data = useExtensions();
  return useMemo(() => lowPriorityShown(connectorsOn(data)), [data]);
}

const connectorUIs = packages.flatMap((p) => p.modules.flatMap((m) => (m.type === 'connector' ? [{ pkg: p.id, ui: m }] : [])));

/**
 * The connectors' UI sides the server has on, in the order of the build (none until it has said): their entries in
 * New chat, their links and their chat-menu entries (ConnectorUI.newChat, links, chatActions; 2.1.0).
 */
export function useConnectorUIs(): readonly ConnectorUI[] {
  const data = useExtensions();
  return useMemo(() => (data ? connectorUIs.filter((x) => moduleOn(data, x.pkg, 'connector', x.ui.id)).map((x) => x.ui) : []), [data]);
}

/** The spaces whose package is on (none until the server has said). */
export function useActiveSpaces(): readonly SpaceModule[] {
  const data = useExtensions();
  return useMemo(() => activeSpaces(data, owned), [data]);
}

/**
 * Ids of the build's spaces the server has said are off (none until it has said): a page of one closes, its
 * controller unmounts (a package turned off while the app is open).
 */
export function useSpacesOff(): ReadonlySet<string> {
  const data = useExtensions();
  return useMemo(() => {
    if (!data) return new Set<string>();
    const on = new Set(activeSpaces(data, owned).map((s) => s.id));
    return new Set(spaces.filter((s) => !on.has(s.id)).map((s) => s.id));
  }, [data]);
}

/** An augmentation the server has on, with its module's info from the server. */
export type ActiveAugmentation = AugmentationUI & { info: ModuleInfo };

/** The augmentations the server has on, in the order of the build (none until it has said). */
export function useAugmentations(): readonly ActiveAugmentation[] {
  const data = useExtensions();
  return useMemo(
    () => augmentations.filter((x) => moduleOn(data, x.pkg, 'augmentation', x.aug.id)).map((x) => ({ ...x.aug, info: moduleInfo(data, x.pkg, 'augmentation', x.aug.id) })),
    [data],
  );
}

/** A module's info from the server ({} while its package is off or before the server has said). */
export function useModuleInfo(pkg: string, type: 'augmentation' | 'space' | 'connector', id: string): ModuleInfo {
  const data = useExtensions();
  return useMemo(() => moduleInfo(data, pkg, type, id), [data, pkg, type, id]);
}

/** Fetches the chunks of an augmentation's slots ahead (after launch, with the conversation's). */
export function preloadAugmentation(a: AugmentationUI): void {
  for (const c of [a.composer?.Menu, a.composer?.Tools, a.Header, a.Conversation, a.message?.Actions, a.message?.Below, a.message?.Menu]) c?.preload();
}

/** A package's Settings page: its section, the package it is from, whether that package is on. */
export interface SettingsEntry {
  pkg: string;
  section: SettingsSection;
  active: boolean;
}

/**
 * The packages' Settings pages, in the packages' order then each package's own (undefined until the server has
 * said which packages are on). Only sections whose id fits a URL segment (settingsroute.ts) are listed.
 */
export function useSettingsSections(): readonly SettingsEntry[] | undefined {
  const data = useExtensions();
  return useMemo(() => (data ? sections.filter((x) => SETTINGS_SEGMENT.test(x.section.id)).map((x) => ({ ...x, active: packageOn(data, x.pkg) })) : undefined), [data]);
}

/** A package's Settings section by its URL (the page's title shows before the server has answered). */
export const settingsSection = (pkg: string, id: string): SettingsSection | undefined =>
  sections.find((x) => x.pkg === pkg && x.section.id === id)?.section;

/**
 * A frame from a package's server half (realtime.ts): to its handler (ClientPackage.events), only while the
 * server has its package on and only for its own modules' types. Anything else is ignored.
 */
export function handleFrame(frame: PackageFrame, qc: QueryClient): boolean {
  const reply = qc.getQueryData<ExtensionsReply>(EXTENSIONS);
  for (const p of packages) {
    const run = p.events && Object.hasOwn(p.events, frame.type) ? p.events[frame.type] : undefined;
    if (!run) continue;
    const owner = frame.type.split('.')[0];
    if (!packageOn(reply, p.id) || !p.modules.some((m) => m.id === owner)) return false;
    run(frame, qc);
    return true;
  }
  return false;
}
