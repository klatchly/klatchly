import type { AugmentationScope, PackageInfo } from '#core/extension.js';

// Writing help: fixes and translation of the draft (the composer's ✨ menu), translation of received messages
// (message menu, one-tap button) and the languages offered (Settings → Translation languages). One augmentation, on
// the models of the llm package (its two uses: their models are chosen on llm's Settings → Default models). What
// both halves share: the package and the module's id (and langs.ts, the supported languages).

export const writingPackage = {
  id: 'writing',
  // 1.1: its models chosen on llm's page (llm 1.1 uses); /api/ai and its AI models page gone. 1.2: pictures
  // translated (POST /api/translate/image, its own use).
  version: '1.3.0',
  // 1.2: the icon of its Settings entry (SettingsSection.icon). 1.9: ChatReader.readImage, the menu's `image`.
  // 1.16: its capability declarations (network / listen / files / spawns, below).
  klatchly: '^2.0',
  requires: { llm: '^1.2' },
  // Capabilities (1.16): its own files in the data volume; the models are called through the llm provider (that
  // package's connections), none of its own.
  files: ['data'],
  // Its chip and ✨ section after the chat agent's.
  order: 70,
} as const satisfies PackageInfo;


/**
 * The augmentation. 'on-demand': it reads one message (translate) or the chat's latest page (translate the
 * draft with context) when the user asks, never the event stream.
 */
export const writingModule = { id: 'writing', scope: 'on-demand' } as const satisfies { id: string; scope: AugmentationScope };
