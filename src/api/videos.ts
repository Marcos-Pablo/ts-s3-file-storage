import { respondWithJSON } from './json';
import { cfg, type ApiConfig } from '../config';
import type { BunRequest } from 'bun';
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import { getBearerToken, validateJWT } from '../auth';
import { getVideo, updateVideo, type Video } from '../db/videos';
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
  const localFileName = `${randomIdentifier}.${fileExtension}`;
  const localFilePath = path.join(cfg.assetsRoot, localFileName);

  await Bun.write(localFilePath, videoFile);
  const localFile = Bun.file(localFilePath);

  const [processedLocalFilePath, aspectRatio] = await Promise.all([
    processVideoForFastStart(localFilePath),
    getVideoAspectRatio(localFilePath),
  ]);
  const processedLocalFile = Bun.file(processedLocalFilePath);

  const s3FileName = `${aspectRatio}/${localFileName}`;
  const s3file = cfg.s3Client.file(s3FileName, { type: mediaType });
  await s3file.write(processedLocalFile);

  videoMetaData.videoURL = s3FileName;
  updateVideo(cfg.db, videoMetaData);

  await Promise.all([localFile.delete(), processedLocalFile.delete()]);

  const signedVideo = dbVideoToSignedVideo(cfg, videoMetaData);

  return respondWithJSON(200, signedVideo);
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    return video;
  }
  const presignedUrl = generatePresignedURL(cfg, video.videoURL, 5 * 60);
  video.videoURL = presignedUrl;
  return video;
}

export function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  const presignedUrl = cfg.s3Client.presign(key, { expiresIn: expireTime });
  return presignedUrl;
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(
    [
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      filePath,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ffprobe error: ${stderr}`);
  }

  const stdout = await new Response(proc.stdout).json();

  const { width, height } = stdout?.streams[0] ?? {};

  if (!width || !height || typeof width !== 'number' || typeof height !== 'number') {
    throw new Error('Failed to get video aspect ratio');
  }

  if (width === Math.floor(16 * (height / 9))) return 'landscape';
  if (height === Math.floor(16 * (width / 9))) return 'portrait';
  return 'other';
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + '.processed';
  const proc = Bun.spawn(
    [
      'ffmpeg',
      '-i',
      inputFilePath,
      '-movflags',
      'faststart',
      '-map_metadata',
      '0',
      '-codec',
      'copy',
      '-f',
      'mp4',
      outputFilePath,
    ],
    {
      stderr: 'pipe',
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg error: ${stderr}`);
  }

  return outputFilePath;
}
