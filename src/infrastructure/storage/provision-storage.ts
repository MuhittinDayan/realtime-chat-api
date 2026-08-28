import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface StorageProvisioningConfig {
  avatarBucket: string;
  attachmentBucket: string;
  frontendOrigin: string;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const value = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  return (
    value.name === "NotFound" ||
    value.name === "NoSuchBucket" ||
    value.$metadata?.httpStatusCode === 404
  );
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }

    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function configureCors(
  client: S3Client,
  bucket: string,
  frontendOrigin: string,
): Promise<void> {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [frontendOrigin],
            AllowedMethods: ["GET", "HEAD", "PUT"],
            AllowedHeaders: ["Content-Type"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3_600,
          },
        ],
      },
    }),
  );
}

function publicAvatarPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadProcessedPublicAvatars",
        Effect: "Allow",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/public/*`],
      },
    ],
  });
}

export async function provisionStorage(
  client: S3Client,
  config: StorageProvisioningConfig,
): Promise<void> {
  if (config.avatarBucket === config.attachmentBucket) {
    throw new Error("Avatar and attachment storage must use separate buckets");
  }

  await ensureBucket(client, config.avatarBucket);
  await ensureBucket(client, config.attachmentBucket);
  await configureCors(client, config.avatarBucket, config.frontendOrigin);
  await configureCors(client, config.attachmentBucket, config.frontendOrigin);
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: config.avatarBucket,
      Policy: publicAvatarPolicy(config.avatarBucket),
    }),
  );
}
