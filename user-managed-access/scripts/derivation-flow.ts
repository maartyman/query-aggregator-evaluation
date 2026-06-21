// Self-contained demo wiring 4 servers using real HTTP requests:
// - Upstream RS: http://localhost:3000 (Solid CSS in this repo)
// - Upstream AS: http://localhost:4000/uma (UMA AS in this repo)
// - Aggregator RS (A): http://localhost:5000
// - Aggregator AS (AAS): http://localhost:4001/uma
// This script starts A and AAS and drives a client through the flow described at the top.

import * as http from 'node:http'
import { URL } from 'node:url'
import { once } from 'node:events'
import { parseAuthenticateHeader } from './util/UMA-client'
import { generateKeyPairSync, createSign, createHash } from 'node:crypto'

// ---- Config
const UPSTREAM_RS = 'http://localhost:3000'
const AGGREGATOR_RS = 'http://localhost:5000'
const AAS_BASE = 'http://localhost:4001/uma'

// Small helpers for logging
const mask = (v?: string, n = 12) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…` : v) : String(v))
const log = (...args: any[]) => console.log('[derivation]', ...args)

// Demo identities
const WEBID_A = 'http://localhost:3000/bob/profile/card#me'
const WEBID_CLIENT = 'http://localhost:3000/alice/profile/card#me'

// Demo resource identifiers
const UPSTREAM_RESOURCE = `${UPSTREAM_RS}/alice/private/resource.txt`
const AGGREGATED_RESOURCE = `${AGGREGATOR_RS}/derived.txt`

// ---- HTTP Message Signatures (server keys and signer)
const SIGNING_KEY_ID = 'k1'
const signingKeys = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as any
  // augment for JWKS
  jwk.kid = SIGNING_KEY_ID
  jwk.use = 'sig'
  jwk.alg = 'RS256'
  return { privateKey, publicJwk: jwk }
})()

async function signedFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: any } = {}): Promise<Response> {
  // Prepare body as a string similar to regular fetch init
  const providedBody = init.body;
  const bodyStr = typeof providedBody === 'string' ? providedBody : (providedBody !== undefined ? JSON.stringify(providedBody) : '');

  // Build signature-related headers without overwriting provided headers
  const hash = createHash('sha256').update(Buffer.from(bodyStr)).digest('base64');
  const contentDigest = `sha-256=${hash}`;
  const dateVal = new Date().toUTCString();
  const created = Math.floor(Date.now() / 1000);
  const label = 'sig1';

  const signatureParams = `${label}=("content-digest" "date");keyid="${SIGNING_KEY_ID}";alg="RS256";created=${created}`;
  const canonical = `"content-digest": ${contentDigest}
"date": ${dateVal}
"@signature-params": ("content-digest" "date");keyid="${SIGNING_KEY_ID}";alg="RS256";created=${created}`;

  const signer = createSign('RSA-SHA256');
  signer.update(canonical);
  signer.end();
  const sigB64 = signer.sign(signingKeys.privateKey).toString('base64');
  const signatureValue = `${label}=:${sigB64}:`;

  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (!('accept' in Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(), v])))) {
    headers['accept'] = 'application/json';
  }
  headers['Content-Digest'] = contentDigest;
  headers['Date'] = dateVal;
  headers['Signature-Input'] = signatureParams;
  headers['Signature'] = signatureValue;
  // The AS discovers our JWKS using this cred value
  headers['Authorization'] = `HttpSig cred="${AGGREGATOR_RS}"`;

  const method = init.method ?? 'POST';

  log('[sign] POST', url, 'digest=', contentDigest, 'date=', dateVal);
  log('[sign] Signature-Input =', signatureParams);
  return fetch(url, { method, headers, body: bodyStr });
}

// ---- Helper to ensure upstream private resource exists (PUT with UMA flow)
async function addResourceToUpstreamRS() {
  const privateResource = UPSTREAM_RESOURCE
  const initialBody = 'Some text ...'

  console.log(`\n== Upstream RS: PUT ${privateResource} (no token)`)
  const noTokenResponse = await fetch(privateResource, { method: 'PUT', body: initialBody })
  console.log('Upstream RS responded', noTokenResponse.status)

  // Expect UMA challenge
  const { tokenEndpoint, ticket } = parseAuthenticateHeader(noTokenResponse.headers)
  console.log('Parsed UMA challenge for upstream RS:', { tokenEndpoint, ticket: mask(ticket) })

  const content = {
    grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
    ticket,
    claim_token: encodeURIComponent(WEBID_CLIENT),
    claim_token_format: 'urn:solidlab:uma:claims:formats:webid',
  }

  console.log(`== Upstream AS: POST token ${tokenEndpoint}`)
  const asRequestResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(content),
  })
  const asResponse: any = await asRequestResponse.json()
  console.log('Upstream AS responded', asRequestResponse.status, 'token =', mask(asResponse?.access_token))

  if (asRequestResponse.status !== 200) {
    throw new Error(`Failed to obtain token for creating upstream resource: ${asRequestResponse.status}`)
  }

  console.log(`== Upstream RS: PUT ${privateResource} (with token)`)
  const tokenResponse = await fetch(privateResource, {
    method: 'PUT',
    headers: { 'Authorization': `${asResponse.token_type} ${asResponse.access_token}` },
    body: initialBody,
  })
  console.log('Create private resource status =', tokenResponse.status)
  if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
    throw new Error(`Failed to create upstream resource, status ${tokenResponse.status}`)
  }
}

// ---- Aggregator RS (A)

type AggregatorState = {
  upstreamIssuer?: string
  derivation_resource_id?: string
  // UMA id of the aggregated resource at AAS. For current AS config, this equals the name we register.
  aasUmaId?: string
}

function startAggregatorRS(state: AggregatorState) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) return res.end()
      const url = new URL(req.url, AGGREGATOR_RS)
      log('RS request', req.method, url.pathname)

      // Expose JWKS for signature verification by AAS
      if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [ signingKeys.publicJwk ] }))
        return
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Aggregator RS running')
        return
      }

      if (req.method === 'GET' && url.pathname === '/derived.txt') {
        const auth = req.headers['authorization']
        log('GET /derived.txt auth header present =', Boolean(auth))
        if (!auth) {
          if (!state.aasUmaId) { res.writeHead(500).end('Aggregator not initialized'); return }
          // Ask AAS (4001) for a permission ticket on this aggregated resource
          const permissionsBody = [
            {
              resource_id: state.aasUmaId,
              resource_scopes: [ 'urn:example:css:modes:read' ],
            }
          ]
          log('Requesting UMA ticket from AAS for resource', state.aasUmaId)
          const confRes = await fetch(`${AAS_BASE}/.well-known/uma2-configuration`)
          const conf = await confRes.json()
          log('AAS configuration loaded. permission_endpoint =', conf.permission_endpoint)
          // Sign the permission request per HTTP Message Signatures
          const permRes = await signedFetch(conf.permission_endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: permissionsBody,
          })
          log('AAS permission response status =', permRes.status)
          if (permRes.status !== 201 && permRes.status !== 200) { res.writeHead(500).end('Failed to get UMA ticket'); return }
          const { ticket } = (permRes.status === 201) ? await permRes.json() : { ticket: undefined }
          if (ticket) log('Obtained UMA ticket =', mask(ticket))
          // Return UMA challenge; if 200 from AS, resource might be public but we still challenge per spec here
          const tktHeader = ticket ? `, ticket="${ticket}"` : ''
          log('Challenging client with UMA header. as_uri =', AAS_BASE, 'ticket =', ticket ? mask(ticket) : 'none')
          res.writeHead(401, { 'WWW-Authenticate': `UMA as_uri="${AAS_BASE}"${tktHeader}` }).end()
          return
        }

        // Validate token via AAS introspection
        try {
          const token = auth.split(/\s+/)[1]
          log('Introspecting token with AAS. token =', mask(token))
          const confRes = await fetch(`${AAS_BASE}/.well-known/uma2-configuration`)
          const conf = await confRes.json()
          log('AAS configuration loaded. introspection_endpoint =', conf.introspection_endpoint)

          // Per UmaClient.verifyOpaqueToken: use form-encoded body without HTTP signatures
          const iRes = await signedFetch(conf.introspection_endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json',
            },
            body: `token_type_hint=access_token&token=${token}`,
          })

          if (iRes.status >= 400) {
            throw new Error(`Introspection endpoint responded ${iRes.status}`)
          }

          const ij: any = await iRes.json()
          log('Introspection response status =', iRes.status, 'active =', ij?.active)
          if (!(ij?.active === true || ij?.active === 'true')) { res.writeHead(403).end('forbidden'); return }
        } catch (e) {
          log('Introspection failed', e)
          res.writeHead(500).end('introspection_failed');
          return
        }

        // Authorized → return derived view
        log('Authorized. Returning derived view')
        res.writeHead(200, { 'content-type': 'text/plain' }).end('derived view of sourceData')
        return
      }

      res.writeHead(404).end('not_found')
    } catch (e: any) {
      log('RS error:', e?.message ?? e)
      res.writeHead(500).end(`error:${e?.message ?? e}`)
    }
  })

  server.listen(5000)
  return server
}

// ---- Aggregator initialization
async function initializeAggregator(state: AggregatorState) {
  // 1) A → Upstream RS (no token) to obtain UMA challenge
  log('[init] Trigger upstream UMA challenge', UPSTREAM_RESOURCE)
  const first = await fetch(UPSTREAM_RESOURCE)
  log('[init] Upstream RS responded', first.status, 'WWW-Authenticate =', first.headers.get('www-authenticate'))
  if (first.status !== 401) throw new Error(`Expected 401 from upstream RS, got ${first.status}`)
  const { tokenEndpoint, ticket } = parseAuthenticateHeader(first.headers)
  log('[init] Parsed challenge tokenEndpoint =', tokenEndpoint, 'ticket =', mask(ticket))
  const upstreamIssuer = tokenEndpoint.replace(/\/token$/, '')

  // 2) A → Upstream AS: request derivation-creation to obtain derivation_resource_id
  log('[init] Request derivation-creation at upstream AS')
  const derivationRes = await fetch(tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      scope: 'urn:knows:uma:scopes:derivation-creation',
      claim_token: encodeURIComponent(WEBID_A),
      claim_token_format: 'urn:solidlab:uma:claims:formats:webid'
    })
  })
  log('[init] Upstream AS derivation response status =', derivationRes.status)
  if (derivationRes.status !== 200) throw new Error(`Upstream AS derivation request failed: ${derivationRes.status}`)
  const derivation = await derivationRes.json() as any
  log('[init] Received derivation_resource_id =', mask(derivation?.derivation_resource_id))
  if (!derivation.derivation_resource_id) throw new Error('No derivation_resource_id returned by upstream AS')

  state.upstreamIssuer = upstreamIssuer
  state.derivation_resource_id = derivation.derivation_resource_id
  log('[init] State updated. upstreamIssuer =', upstreamIssuer, 'derivation_resource_id =', mask(state.derivation_resource_id))

  // 3) Register aggregated resource with AAS including prov:wasDerivedFrom
  const confRes = await fetch(`${AAS_BASE}/.well-known/uma2-configuration`)
  const conf = await confRes.json()
  log('[init] AAS resource_registration_endpoint =', conf.resource_registration_endpoint)
  const registrationBody = {
    name: AGGREGATED_RESOURCE, // current AS uses name as UMA id
    resource_scopes: [ 'urn:example:css:modes:read' ],
    resource_relations: {
      'prov:wasDerivedFrom': [{
        issuer: state.upstreamIssuer,
        derivation_resource_id: state.derivation_resource_id
      }]
    }
  }
  // Sign request per HTTP Message Signatures
  const regRes = await signedFetch(conf.resource_registration_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: registrationBody,
  })
  log('[init] AAS registration response status =', regRes.status)
  if (regRes.status !== 200 && regRes.status !== 201) throw new Error(`AAS registration failed: ${regRes.status}`)
  // For this AS version, UMA id equals the Solid URL when name is provided
  state.aasUmaId = AGGREGATED_RESOURCE
  log('[init] Aggregated UMA resource registered. aasUmaId =', state.aasUmaId)
}

// ---- Client flow (uses fetch only)

async function runClientFlow() {
  console.log(`\n== Client → A: GET ${AGGREGATED_RESOURCE} (no token)`)
  const first = await fetch(AGGREGATED_RESOURCE)
  console.log(`A responded ${first.status}`)
  const { tokenEndpoint, ticket } = parseAuthenticateHeader(first.headers)
  console.log(`Parsed UMA challenge: tokenEndpoint=${tokenEndpoint} ticket=${mask(ticket)}`)

  console.log('\n== Client → AAS: POST token (webid only)')
  const needInfoRes = await fetch(tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent(WEBID_CLIENT),
      claim_token_format: 'urn:solidlab:uma:claims:formats:webid'
    })
  })
  const needInfo = await needInfoRes.json() as any
  console.log(`AAS responded ${needInfoRes.status}`)
  console.log('need_info payload:', JSON.stringify(needInfo))

  // Expect need_info
  if (needInfo.error !== 'need_info') {
    throw new Error(`Expected need_info from AAS, got: ${JSON.stringify(needInfo)}`)
  }

  const details = needInfo.required_claims?.[0]?.details
  if (!details?.issuer || !details?.resource_id || !details?.resource_scopes) throw new Error('AAS missing details for upstream-access')
  console.log('need_info details: issuer =', details.issuer, 'resource_id =', mask(details.resource_id), 'resource_scopes =', mask(details.resource_scopes))

  console.log('\n== Client → Upstream AS: redeem derivation handle for upstream AT')
  const upstreamTokenRes = await fetch(`${details.issuer}/token`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      permissions: [
        {
          resource_id: details.resource_id,
          resource_scopes: details.resource_scopes
        }
      ],
      claim_token: encodeURIComponent(WEBID_CLIENT),
      claim_token_format: 'urn:solidlab:uma:claims:formats:webid'
    })
  })
  const upstreamToken = await upstreamTokenRes.json() as any
  console.log(`Upstream AS responded ${upstreamTokenRes.status} access_token=${mask(upstreamToken?.access_token)}`)

  console.log('\n== Client → AAS: POST token (webid + upstream access token)')
  const aasTokenRes = await fetch(tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket: needInfo.ticket,
      claim_tokens: [
        {
          claim_token: encodeURIComponent(WEBID_CLIENT),
          claim_token_format: 'urn:solidlab:uma:claims:formats:webid'
        },
        {
          claim_token_format: 'urn:ietf:params:oauth:token-type:access_token',
          claim_token: upstreamToken.access_token
        }
      ]
    })
  })
  const aasToken = await aasTokenRes.json() as any
  console.log(`AAS issued aggregator access_token: ${aasTokenRes.status} token_type=${aasToken?.token_type} token=${mask(aasToken?.access_token)}`)

  console.log(`\n== Client → A: GET ${AGGREGATED_RESOURCE} (with AAS token)')`)
  const ok = await fetch(AGGREGATED_RESOURCE, { headers: { 'authorization': `${aasToken.token_type} ${aasToken.access_token}` } })
  console.log(`A responded ${ok.status} with body: ${await ok.text()}`)
}

// ---- Bootstrap

;(async () => {
  const aggState: AggregatorState = {}
  const aggServer = startAggregatorRS(aggState)
  await once(aggServer, 'listening')
  console.log('Aggregator RS listening on 5000')

  await addResourceToUpstreamRS()

  await initializeAggregator(aggState)
  console.log('Aggregator initialized: derivation handle acquired and AAS registration completed')

  await runClientFlow()

  aggServer.close()
})().catch(e => {
  console.error(e)
  process.exitCode = 1
})
