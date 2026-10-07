import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

export interface FakeOidcProvider {
  readonly issuer: string;
  readonly endpoint: URL;
  readonly jwks: unknown;
  readonly idToken: string;
  close(): Promise<void>;
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function startFakeOidcProvider(input: { issuer: string; jwks: unknown; idToken: string }): Promise<FakeOidcProvider> {
  const codes = new Map<string, { challenge: string; redirectUri: string; state: string }>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer: input.issuer, authorization_endpoint: `${input.issuer}/authorize`, token_endpoint: `${input.issuer}/token`, jwks_uri: `${input.issuer}/jwks`, id_token_signing_alg_values_supported: ['RS256'] }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/jwks') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(input.jwks)); return;
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri'); const state = url.searchParams.get('state'); const codeChallenge = url.searchParams.get('code_challenge');
      if (!redirectUri || !state || !codeChallenge || url.searchParams.get('code_challenge_method') !== 'S256') { response.statusCode = 400; response.end('invalid authorization request'); return; }
      const code = randomBytes(24).toString('base64url'); codes.set(code, { challenge: codeChallenge, redirectUri, state });
      const callback = new URL(redirectUri); callback.searchParams.set('code', code); callback.searchParams.set('state', state); response.writeHead(302, { location: callback.href }); response.end(); return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const body = await new Promise<string>((resolve, reject) => { let value = ''; request.setEncoding('utf8'); request.on('data', (part: string) => { value += part; }); request.once('end', () => resolve(value)); request.once('error', reject); });
      const form = new URLSearchParams(body); const record = codes.get(form.get('code') ?? '');
      if (!record || form.get('redirect_uri') !== record.redirectUri || !form.get('code_verifier') || challenge(form.get('code_verifier')!) !== record.challenge) { response.statusCode = 400; response.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      codes.delete(form.get('code')!); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id_token: input.idToken, token_type: 'Bearer' })); return;
    }
    response.statusCode = 404; response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fake provider has no TCP address');
  return { issuer: input.issuer, endpoint: new URL(`http://127.0.0.1:${address.port}`), jwks: input.jwks, idToken: input.idToken, close: async () => { server.close(); await once(server, 'close'); } };
}
