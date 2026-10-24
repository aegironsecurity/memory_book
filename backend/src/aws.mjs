// Real AWS implementations of the db and s3 interfaces the handlers use.
// Handlers only talk to these interfaces, so tests can swap in in-memory fakes.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const pk = (eid) => `EVENT#${eid}`;

function isConditionFailure(e) {
  return e && e.name === 'ConditionalCheckFailedException';
}

export function realDeps(env = process.env) {
  const table = env.TABLE;
  const bucket = env.BUCKET;
  const secretArn = env.SECRET_ARN;

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  // WHEN_REQUIRED stops newer SDKs from adding CRC32 checksum params to presigned URLs.
  // Browsers cannot satisfy those params, so uploads would fail with a signature error.
  const s3c = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const sm = new SecretsManagerClient({});

  let secretCache = null;

  const db = {
    async getEvent(eid) {
      const r = await ddb.send(new GetCommand({ TableName: table, Key: { PK: pk(eid), SK: 'META' }, ConsistentRead: true }));
      return r.Item || null;
    },

    async updateEvent(eid, patch) {
      return updateItem({ PK: pk(eid), SK: 'META' }, patch, 'attribute_exists(PK)');
    },

    async getMemory(eid, mid) {
      const r = await ddb.send(new GetCommand({ TableName: table, Key: { PK: pk(eid), SK: `MEM#${mid}` }, ConsistentRead: true }));
      return r.Item || null;
    },

    // Returns true if created, false if an item with that id already exists.
    async putMemory(eid, item) {
      try {
        await ddb.send(
          new PutCommand({ TableName: table, Item: { PK: pk(eid), SK: `MEM#${item.id}`, ...item }, ConditionExpression: 'attribute_not_exists(PK)' }),
        );
        return true;
      } catch (e) {
        if (isConditionFailure(e)) return false;
        throw e;
      }
    },

    // expectedStatus is optional. Returns the updated item, or null when the condition fails.
    async updateMemory(eid, mid, patch, expectedStatus) {
      return updateItem({ PK: pk(eid), SK: `MEM#${mid}` }, patch, expectedStatus ? 'attribute_exists(PK) AND #st = :exp' : 'attribute_exists(PK)', expectedStatus);
    },

    async deleteMemory(eid, mid) {
      await ddb.send(new DeleteCommand({ TableName: table, Key: { PK: pk(eid), SK: `MEM#${mid}` } }));
    },

    async listMemories(eid) {
      const out = [];
      let key;
      do {
        const r = await ddb.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
            ExpressionAttributeValues: { ':pk': pk(eid), ':p': 'MEM#' },
            ExclusiveStartKey: key,
            ConsistentRead: true,
          }),
        );
        out.push(...(r.Items || []));
        key = r.LastEvaluatedKey;
      } while (key);
      return out;
    },

    // Atomically reserves one file and `bytes` of quota for a guest. Returns false when over a cap.
    async reserveQuota(eid, gid, bytes, caps) {
      if (bytes > caps.maxBytes) return false;
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: pk(eid), SK: `GUEST#${gid}` },
            UpdateExpression: 'ADD fileCount :one, bytesTotal :b',
            ConditionExpression: 'attribute_not_exists(fileCount) OR (fileCount < :maxF AND bytesTotal <= :cap)',
            ExpressionAttributeValues: { ':one': 1, ':b': bytes, ':maxF': caps.maxFiles, ':cap': caps.maxBytes - bytes },
          }),
        );
        return true;
      } catch (e) {
        if (isConditionFailure(e)) return false;
        throw e;
      }
    },

    async releaseQuota(eid, gid, bytes) {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: pk(eid), SK: `GUEST#${gid}` },
          UpdateExpression: 'ADD fileCount :neg, bytesTotal :nb',
          ExpressionAttributeValues: { ':neg': -1, ':nb': -bytes },
        }),
      );
    },

    async getFailures(key) {
      const r = await ddb.send(new GetCommand({ TableName: table, Key: { PK: key, SK: 'CODE' } }));
      return r.Item?.attempts || 0;
    },

    async bumpFailures(key, ttlEpochSec) {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: key, SK: 'CODE' },
          UpdateExpression: 'ADD attempts :one SET #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':ttl': ttlEpochSec },
        }),
      );
    },
  };

  async function updateItem(Key, patch, condition, expectedStatus) {
    const names = {};
    const values = {};
    const sets = [];
    let i = 0;
    for (const [k, v] of Object.entries(patch)) {
      i += 1;
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
    }
    if (expectedStatus) {
      names['#st'] = 'status';
      values[':exp'] = expectedStatus;
    }
    try {
      const r = await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key,
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return r.Attributes;
    } catch (e) {
      if (isConditionFailure(e)) return null;
      throw e;
    }
  }

  const s3 = {
    async createMultipart(key, contentType) {
      const r = await s3c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
      return r.UploadId;
    },
    presignPart(key, uploadId, partNumber, expiresIn) {
      return getSignedUrl(s3c, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });
    },
    async listParts(key, uploadId) {
      const out = [];
      let marker;
      do {
        const r = await s3c.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000 }));
        for (const p of r.Parts || []) out.push({ partNumber: p.PartNumber, size: p.Size, etag: p.ETag });
        marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
      } while (marker);
      return out;
    },
    async complete(key, uploadId, parts) {
      await s3c.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    },
    async abort(key, uploadId) {
      try {
        await s3c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      } catch (e) {
        if (e.name !== 'NoSuchUpload') throw e;
      }
    },
    async head(key) {
      try {
        const r = await s3c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: r.ContentLength, contentType: r.ContentType };
      } catch (e) {
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async getRange(key, start, end) {
      const r = await s3c.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async put(key, body, contentType) {
      await s3c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async del(key) {
      await s3c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    presignGet(key, { expiresIn, filename, contentType } = {}) {
      const params = { Bucket: bucket, Key: key };
      if (filename) params.ResponseContentDisposition = `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
      if (contentType) params.ResponseContentType = contentType;
      return getSignedUrl(s3c, new GetObjectCommand(params), { expiresIn });
    },
  };

  return {
    db,
    s3,
    now: () => Date.now(),
    random: () => Math.floor(Math.random() * 10000).toString().padStart(4, '0'),
    async secret() {
      if (secretCache) return secretCache;
      const r = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
      secretCache = Buffer.from(r.SecretString, 'utf8');
      return secretCache;
    },
    env: { eventId: env.EVENT_ID },
  };
}
