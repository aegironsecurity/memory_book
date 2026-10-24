import { createGuestHandler } from './guest.mjs';
import { realDeps } from './aws.mjs';

export const handler = createGuestHandler(realDeps());
