import { getBearerToken, validateJWT } from '../auth';
import { respondWithJSON } from './json';
import { getVideo, updateVideo } from '../db/videos';
import type { ApiConfig } from '../config';
import type { BunRequest } from 'bun';
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import { getInMemoryUrl } from './assets';

const MAX_UPLOAD_SIZE = 10 << 20;

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError('Invalid video ID');
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError('Thumbnail not found');
  }

  return new Response(thumbnail.data, {
    headers: {
      'Content-Type': thumbnail.mediaType,
      'Cache-Control': 'no-store',
    },
  });
}

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

  const fileData = await file.arrayBuffer();
  if (!fileData) {
    throw new Error('Error reading file data');
  }

  const thumbnail = {
    data: fileData,
    mediaType,
  } satisfies Thumbnail;

  videoThumbnails.set(videoMetaData.id, thumbnail);

  const url = getInMemoryUrl(cfg, videoId);
  videoMetaData.thumbnailURL = url;

  updateVideo(cfg.db, videoMetaData);

  return respondWithJSON(200, videoMetaData);
}
