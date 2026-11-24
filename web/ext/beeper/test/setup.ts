import { Registry } from '#core/registry.js';
import beeper from '../server/index.js';

// The beeper package's tests run the core's routes against a canned Desktop API (test/mock.js, on KLATCHLY_UPSTREAM):
// importing this makes the beeper connector the one those routes ask, as in the app (the registry hands its
// connectors to the core when it is built). Nothing is started: no upstream socket.
export const registry = new Registry([beeper]);
