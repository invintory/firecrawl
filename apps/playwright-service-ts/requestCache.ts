import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

let redis: Redis | undefined;

const cacheEnabled =
  process.env.REDIS_CACHE_ENABLED === "true" &&
  process.env.REDIS_HOST &&
  process.env.REDIS_HOST !== "" &&
  process.env.REDIS_PORT &&
  process.env.REDIS_PORT !== "";

if (cacheEnabled) {
  console.log(
    "Connecting to Redis",
    process.env.REDIS_HOST,
    process.env.REDIS_PORT
  );
  redis = new Redis({
    host: process.env.REDIS_HOST!,
    port: parseInt(process.env.REDIS_PORT!),
    db: 2,
  });
} else {
  console.log(
    "Redis cache disabled (REDIS_CACHE_ENABLED, REDIS_HOST, and REDIS_PORT must all be set)"
  );
}

export async function getResponseFromCache(url: string): Promise<{
  headers: Record<string, string>;
  body: Buffer;
  status: number;
} | null> {
  if (!redis) {
    return null;
  }

  const response = await redis.get(`response:${url}`);
  if (response) {
    const parsedResponse = JSON.parse(response);
    return {
      headers: parsedResponse.headers,
      body: Buffer.from(parsedResponse.body, "utf8"),
      status: parsedResponse.status,
    };
  }
  return null;
}

export async function setResponseInCache(
  url: string,
  response: {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }
) {
  if (!redis) {
    return;
  }

  return await redis.set(
    `response:${url}`,
    JSON.stringify({
      status: response.status,
      headers: response.headers,
      body: response.body.toString("utf8"),
    }),
    "EX",
    60 * 60 * 24
  ); // 24 hours
}
