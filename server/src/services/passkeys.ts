import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { config } from '../config.js';
import { getSettings, updateSettings } from './settings.js';

const CEREMONY_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CEREMONIES = 10_000;

interface CeremonyContext {
  challenge: string;
  origin: string;
  rpID: string;
  expiresAt: number;
  sessionVersion?: number;
  name?: string;
}

const registrationCeremonies = new Map<string, CeremonyContext>();
const authenticationCeremonies = new Map<string, CeremonyContext>();

function cleanupCeremonies(): void {
  const now = Date.now();
  for (const [id, ceremony] of registrationCeremonies) {
    if (ceremony.expiresAt <= now) registrationCeremonies.delete(id);
  }
  for (const [id, ceremony] of authenticationCeremonies) {
    if (ceremony.expiresAt <= now) authenticationCeremonies.delete(id);
  }
}

function assertCeremonyCapacity(store: Map<string, CeremonyContext>): void {
  cleanupCeremonies();
  if (store.size >= MAX_PENDING_CEREMONIES) {
    throw Object.assign(new Error('Too many Passkey requests; try again later'), { status: 429 });
  }
}

function requestWebAuthnContext(req: Request): { origin: string; rpID: string } {
  const configuredOrigin = config.passkeyOrigin;
  const candidate =
    configuredOrigin ??
    req.get('origin') ??
    `${req.protocol}://${req.get('host') ?? req.hostname}`;
  let origin: URL;
  try {
    origin = new URL(candidate);
  } catch {
    throw Object.assign(new Error('Unable to determine the Passkey origin'), { status: 400 });
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) {
    throw Object.assign(
      new Error('Passkeys require HTTPS (or localhost for local development)'),
      { status: 400 },
    );
  }
  const rpID = config.passkeyRpId ?? origin.hostname;
  if (origin.hostname !== rpID && !origin.hostname.endsWith(`.${rpID}`)) {
    throw Object.assign(new Error('PASSKEY_RP_ID must match the Passkey origin domain'), {
      status: 400,
    });
  }
  return { origin: origin.origin, rpID };
}

function ownerUserId(jwtSecret: string): Uint8Array<ArrayBuffer> {
  const hash = createHash('sha256').update(`webobsidian:owner:${jwtSecret}`).digest();
  const result = new Uint8Array(new ArrayBuffer(hash.length));
  result.set(hash);
  return result;
}

export async function registrationOptions(
  req: Request,
  name: string,
): Promise<{ ceremonyId: string; options: Awaited<ReturnType<typeof generateRegistrationOptions>> }> {
  assertCeremonyCapacity(registrationCeremonies);
  const settings = await getSettings();
  const { origin, rpID } = requestWebAuthnContext(req);
  const options = await generateRegistrationOptions({
    rpName: 'WebObsidian',
    rpID,
    userName: 'owner',
    userDisplayName: 'WebObsidian Owner',
    userID: ownerUserId(settings.auth.jwtSecret),
    attestationType: 'none',
    excludeCredentials: settings.auth.passkeys.map((passkey) => ({
      id: passkey.id,
      transports: passkey.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: 60_000,
  });
  const ceremonyId = randomBytes(24).toString('base64url');
  registrationCeremonies.set(ceremonyId, {
    challenge: options.challenge,
    origin,
    rpID,
    expiresAt: Date.now() + CEREMONY_TTL_MS,
    sessionVersion: settings.auth.sessionVersion,
    name,
  });
  return { ceremonyId, options };
}

export async function finishRegistration(
  ceremonyId: string,
  response: RegistrationResponseJSON,
): Promise<void> {
  cleanupCeremonies();
  const ceremony = registrationCeremonies.get(ceremonyId);
  registrationCeremonies.delete(ceremonyId);
  if (!ceremony) {
    throw Object.assign(new Error('Passkey registration expired; please try again'), { status: 400 });
  }
  const settings = await getSettings();
  if (ceremony.sessionVersion !== settings.auth.sessionVersion) {
    throw Object.assign(new Error('Your session changed; please start again'), { status: 409 });
  }
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw Object.assign(new Error('Passkey registration could not be verified'), { status: 400 });
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error('Passkey registration could not be verified'), { status: 400 });
  }
  const {
    credential,
    credentialDeviceType,
    credentialBackedUp,
  } = verification.registrationInfo;
  await updateSettings((draft) => {
    if (draft.auth.passkeys.some((passkey) => passkey.id === credential.id)) {
      throw Object.assign(new Error('This Passkey is already registered'), { status: 409 });
    }
    draft.auth.passkeys.push({
      id: credential.id,
      name: ceremony.name || 'Passkey',
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? response.response.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
  });
}

export async function authenticationOptions(
  req: Request,
): Promise<{ ceremonyId: string; options: Awaited<ReturnType<typeof generateAuthenticationOptions>> }> {
  assertCeremonyCapacity(authenticationCeremonies);
  const settings = await getSettings();
  if (settings.auth.passkeys.length === 0) {
    throw Object.assign(new Error('No Passkey is registered'), { status: 404 });
  }
  const { origin, rpID } = requestWebAuthnContext(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    timeout: 60_000,
  });
  const ceremonyId = randomBytes(24).toString('base64url');
  authenticationCeremonies.set(ceremonyId, {
    challenge: options.challenge,
    origin,
    rpID,
    expiresAt: Date.now() + CEREMONY_TTL_MS,
  });
  return { ceremonyId, options };
}

export async function finishAuthentication(
  ceremonyId: string,
  response: AuthenticationResponseJSON,
): Promise<void> {
  cleanupCeremonies();
  const ceremony = authenticationCeremonies.get(ceremonyId);
  authenticationCeremonies.delete(ceremonyId);
  if (!ceremony) {
    throw Object.assign(new Error('Passkey login expired; please try again'), { status: 400 });
  }
  const settings = await getSettings();
  const passkey = settings.auth.passkeys.find((item) => item.id === response.id);
  if (!passkey) {
    throw Object.assign(new Error('Passkey is not registered'), { status: 401 });
  }
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpID,
      credential: {
        id: passkey.id,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: true,
    });
  } catch {
    throw Object.assign(new Error('Passkey login could not be verified'), { status: 401 });
  }
  if (!verification.verified) {
    throw Object.assign(new Error('Passkey login could not be verified'), { status: 401 });
  }
  await updateSettings((draft) => {
    const stored = draft.auth.passkeys.find((item) => item.id === passkey.id);
    if (!stored) throw Object.assign(new Error('Passkey is no longer registered'), { status: 409 });
    stored.counter = verification.authenticationInfo.newCounter;
    stored.backedUp = verification.authenticationInfo.credentialBackedUp;
    stored.deviceType = verification.authenticationInfo.credentialDeviceType;
    stored.lastUsedAt = new Date().toISOString();
  });
}

export async function listPasskeys() {
  const settings = await getSettings();
  return settings.auth.passkeys.map(({ id, name, createdAt, lastUsedAt, backedUp, deviceType }) => ({
    id,
    name,
    createdAt,
    lastUsedAt,
    backedUp,
    deviceType,
  }));
}

export async function deletePasskey(id: string): Promise<boolean> {
  let removed = false;
  await updateSettings((draft) => {
    const before = draft.auth.passkeys.length;
    draft.auth.passkeys = draft.auth.passkeys.filter((passkey) => passkey.id !== id);
    removed = draft.auth.passkeys.length !== before;
    if (removed) draft.auth.sessionVersion += 1;
  });
  return removed;
}
