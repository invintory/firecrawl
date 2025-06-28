import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redis = new Redis(process.env.REDIS_URL!);

export async function getResponseFromCache(url: string): Promise<{
  headers: Record<string, string>;
  body: Buffer;
  status: number;
} | null> {
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
