import { respondWithJSON } from './json';
import { type ApiConfig } from '../config';
import type { BunRequest } from 'bun';
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import { getBearerToken, validateJWT } from '../auth';
import { getVideo, updateVideo } from '../db/videos';
import { randomBytes } from 'crypto';
import { mediaTypeToExt } from './assets';
import path from 'path';

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId: string };

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
  const videoFile = formData.get('video');

  if (!(videoFile instanceof File)) {
    throw new BadRequestError('Video file missing');
  }

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError('Video file exceeds the maximum allowed size of 1GB');
  }

  const mediaType = videoFile.type;

  if (mediaType !== 'video/mp4') {
    throw new BadRequestError('Missing or invalid media type. Only MP4 allowed');
  }

  const fileExtension = mediaTypeToExt(mediaType);

  const randomIdentifier = randomBytes(32).toString('base64url');
  const fileName = `${randomIdentifier}.${fileExtension}`;
  const localFilePath = path.join(cfg.assetsRoot, fileName);

  await Bun.write(localFilePath, videoFile);
  const localFile = Bun.file(localFilePath);

  const s3file = cfg.s3Client.file(fileName, { type: mediaType });
  await s3file.write(localFile);

  videoMetaData.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileName}`;
  updateVideo(cfg.db, videoMetaData);

  await localFile.delete();

  return respondWithJSON(200, null);
}
