import { getBearerToken, validateJWT } from '../auth';
import { respondWithJSON } from './json';
import { getVideo, updateVideo } from '../db/videos';
import type { ApiConfig } from '../config';
import type { BunRequest } from 'bun';
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import path from 'path';
import { mediaTypeToExt } from './assets';

const MAX_UPLOAD_SIZE = 10 << 20;

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError('Invalid video ID');
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const videoMetaData = getVideo(cfg.db, videoId);

  if (!videoMetaData) {
    throw new NotFoundError(`Video with id ${videoId} not found`);
  }

  if (videoMetaData.userID !== userID) {
    throw new UserForbiddenError(`Not authorized to update this video`);
  }

  const formData = await req.formData();
  const file = formData.get('thumbnail');

  if (!(file instanceof File)) {
    throw new BadRequestError('Thumbnail file missing');
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError('Thumbnail file exceeds the maximum allowed size of 10MB');
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError('Missing Content-Type for thumbnail');
  }
  const fileExtension = mediaTypeToExt(mediaType);

  const fileData = await file.arrayBuffer();
  if (!fileData) {
    throw new Error('Error reading file data');
  }

  const fileName = `${videoId}.${fileExtension}`;
  const filePath = path.join(cfg.assetsRoot, fileName);

  await Bun.write(filePath, fileData);

  videoMetaData.thumbnailURL = `http://localhost:${cfg.port}/${filePath}`;

  updateVideo(cfg.db, videoMetaData);

  return respondWithJSON(200, videoMetaData);
}
