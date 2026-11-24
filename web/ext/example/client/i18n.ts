import { useMemo } from 'react';
import { useCatalog, useT as useCoreT, type Messages } from '../../../client/src/sdk';
import { exampleCatalog, type ExampleMessages } from '../locales/index';

// The package's components read the core's strings (t.common.back, t.shell.settings…: typed, a missing key fails
// the build) and their own under t.example, in the language the user chose, re-rendered when it changes.
export type T = Messages & { example: ExampleMessages };

export function useT(): T {
  const core = useCoreT();
  const example = useCatalog(exampleCatalog);
  return useMemo(() => ({ ...core, example }), [core, example]);
}
