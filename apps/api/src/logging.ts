import type { FastifyRequest } from 'fastify';
import type { Writable } from 'node:stream';

/**
 * OIDC callbacks carry the authorization code and state in the query string,
 * and other URLs may carry tokens or secrets. Request logs therefore keep the
 * path only; the query string and any fragment are never written.
 */
export function pathWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

export function loggerOptions(stream?: Writable) {
  return {
    ...(stream ? { stream } : {}),
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: pathWithoutQuery(request.url),
          host: request.host,
          remoteAddress: request.ip
        };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      }
    }
  };
}
