import { createHostHandler } from './host.mjs';
import { realDeps } from './aws.mjs';

export const handler = createHostHandler(realDeps());
