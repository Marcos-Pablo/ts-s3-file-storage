import { existsSync, mkdirSync } from 'fs';

import type { ApiConfig } from '../config';

export function ensureAssetsDir(cfg: ApiConfig) {
  if (!existsSync(cfg.assetsRoot)) {
    mkdirSync(cfg.assetsRoot, { recursive: true });
  }
}

export function mediaTypeToExt(mediaType: string) {
  const split = mediaType.split('/');
  if (split.length !== 2) {
    return 'bin';
  }

  return split[1];
}
