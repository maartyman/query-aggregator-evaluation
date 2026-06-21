import { BadRequestHttpError, ForbiddenHttpError, KeyValueStorage } from '@solid/community-server';
import { Mocked } from 'vitest';
import { ClaimSet } from '../../../src/credentials/ClaimSet';
import { Verifier } from '../../../src/credentials/verify/Verifier';
import { BaseNegotiator } from '../../../src/dialog/BaseNegotiator';
import { DialogInput } from '../../../src/dialog/Input';
import { NeedInfoError, RequiredClaimsInfo } from '../../../src/errors/NeedInfoError';
import { TicketingStrategy } from '../../../src/ticketing/strategy/TicketingStrategy';
import { Ticket } from '../../../src/ticketing/Ticket';
import { SerializedToken, TokenFactory } from '../../../src/tokens/TokenFactory';
import { ResourceDescription } from '../../../src/views/ResourceDescription';

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('ticket-id'),
}));

describe('BaseNegotiator', (): void => {
  const input: DialogInput = {
    permissions: [
      { resource_id: 'id1', resource_scopes: [ 'scope1' ] },
      { resource_id: 'id2', resource_scopes: [ 'scope2' ] },
    ]
  };
  const claims: ClaimSet = { claim1: 'value1', claim2: 'value2' };
  const ticket: Ticket = {
    permissions: [ { resource_id: 'id1', resource_scopes: [ 'scope1' ] } ],
    required: [],
    provided: { claim: 'value' },
  };
  const token: SerializedToken = { token: 'token', tokenType: 'type' };
  let ticketData: Map<string, Ticket>;

  let verifier: Mocked<Verifier>
  let ticketStore: Mocked<KeyValueStorage<string, Ticket>>;
  let resourceStore: Mocked<KeyValueStorage<string, ResourceDescription>>;
  let ticketingStrategy: Mocked<TicketingStrategy>;
  let tokenFactory: Mocked<TokenFactory>;
  let negotiator: BaseNegotiator;

  beforeEach(async(): Promise<void> => {
    verifier = {
      verify: vi.fn().mockResolvedValue(claims),
    };

    ticketData = new Map<string, Ticket>();
    ticketStore = {
      has: vi.fn().mockImplementation(key => ticketData.has(key)),
      get: vi.fn().mockImplementation(key => ticketData.get(key)),
      set: vi.fn().mockImplementation((key, value) => ticketData.set(key, value)),
      delete: vi.fn().mockImplementation(key => ticketData.delete(key)),
      entries: vi.fn().mockImplementation(() => ticketData.entries()),
    };

    resourceStore = {
      has: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
    };

    ticketingStrategy = {
      initializeTicket: vi.fn().mockResolvedValue(ticket),
      validateClaims: vi.fn().mockResolvedValue(ticket),
      resolveTicket: vi.fn().mockResolvedValue({
        success: true,
        value: { resource_id: 'id1', resource_scopes: [ 'scope1' ] },
      }),
    };

    tokenFactory = {
      serialize: vi.fn().mockResolvedValue(token),
      deserialize: vi.fn(),
    };

    negotiator = new BaseNegotiator(verifier, ticketStore, ticketingStrategy, tokenFactory, resourceStore);
  });

  it('errors if the input is in the wrong type.', async(): Promise<void> => {
    await expect(negotiator.negotiate({ ticket: 5 } as any)).rejects.toThrow('value is neither of the union types');
  });

  it('returns the token if everything was successful.', async(): Promise<void> => {
    await expect(negotiator.negotiate(input)).resolves.toEqual({ access_token: 'token', token_type: 'type' });
    expect(ticketStore.get).toHaveBeenCalledTimes(0);
    expect(ticketStore.set).toHaveBeenCalledTimes(0);
    expect(ticketStore.delete).toHaveBeenCalledTimes(0);
    expect(ticketingStrategy.initializeTicket).toHaveBeenCalledTimes(1);
    expect(ticketingStrategy.initializeTicket).toHaveBeenLastCalledWith(input.permissions);
    expect(verifier.verify).toHaveBeenCalledTimes(0);
    expect(ticketingStrategy.validateClaims).toHaveBeenCalledTimes(0);
    expect(tokenFactory.serialize).toHaveBeenCalledTimes(1);
    expect(tokenFactory.serialize).toHaveBeenLastCalledWith(
      { permissions: { resource_id: 'id1', resource_scopes: [ 'scope1' ] } });
  });

  it('returns derivation identifiers and management tokens for derivation creation.', async(): Promise<void> => {
    const crypto = await import('node:crypto');
    vi.mocked(crypto.randomUUID).mockReturnValueOnce('derivation-id' as any);
    tokenFactory.serialize
      .mockResolvedValueOnce({ token: 'access-token', tokenType: 'Bearer' })
      .mockResolvedValueOnce({ token: 'management-token', tokenType: 'Bearer' });

    await expect(negotiator.negotiate({
      ...input,
      scope: 'urn:knows:uma:scopes:derivation-creation',
    })).resolves.toEqual({
      access_token: 'access-token',
      token_type: 'Bearer',
      derivation_resource_id: 'derivation-id',
      management_access_token: {
        access_token: 'management-token',
        token_type: 'Bearer',
      },
    });
    expect(resourceStore.set).toHaveBeenCalledWith('derivation-id', {
      resource_scopes: [ 'urn:knows:uma:scopes:derivation-read' ],
    });
    expect(tokenFactory.serialize).toHaveBeenLastCalledWith({
      permissions: [{
        resource_id: 'derivation-id',
        resource_scopes: [
          'urn:knows:uma:scopes:write',
          'urn:knows:uma:scopes:delete',
        ],
      }],
    });
  });

  it('errors if there is no existing ticket and no permission request.', async(): Promise<void> => {
    await expect(negotiator.negotiate({})).rejects
      .toThrow('A token request without existing ticket should include requested permissions.');
  });

  it('throws an empty 403 if the token is rejected with no requirements.', async(): Promise<void> => {
    ticketingStrategy.resolveTicket.mockResolvedValueOnce({ success: false, value: [] });
    await expect(negotiator.negotiate(input)).rejects.toThrow(ForbiddenHttpError);
    expect(ticketStore.set).toHaveBeenCalledTimes(0);
  });

  it('throws an error with an info request if there are still requirements.', async(): Promise<void> => {
    ticketingStrategy.initializeTicket.mockResolvedValueOnce({
      permissions: [],
      provided: {},
      required: [{ fn: async() => false }],
    })
    ticketingStrategy.resolveTicket.mockResolvedValueOnce({ success: false, value: [] });
    try {
      await negotiator.negotiate(input);
    } catch (error) {
      expect(error).toBeInstanceOf(NeedInfoError);
      expect((error as NeedInfoError).additionalParams).toEqual({
        required_claims: [{ claim_token_format: 'fn' }],
      });
    }
    expect(ticketStore.set).toHaveBeenCalledTimes(1);
  });

  it('requests derivation-access claims using the spec shape.', async(): Promise<void> => {
    ticketingStrategy.initializeTicket.mockResolvedValueOnce({
      permissions: [{ resource_id: 'derived', resource_scopes: [ 'urn:knows:uma:scopes:read' ] }],
      provided: {},
      required: [],
    });
    ticketingStrategy.resolveTicket.mockResolvedValueOnce({ success: false, value: [] });
    resourceStore.get.mockResolvedValueOnce({
      resource_scopes: [ 'urn:knows:uma:scopes:read' ],
      resource_relations: {
        'prov:wasDerivedFrom': [
          { issuer: 'https://upstream.example/uma', derivation_resource_id: 'upstream-derived' },
        ],
      },
    });

    try {
      await negotiator.negotiate({ permissions: [{ resource_id: 'derived', resource_scopes: [ 'urn:knows:uma:scopes:read' ] }] });
    } catch (error) {
      expect(error).toBeInstanceOf(NeedInfoError);
      expect((error as NeedInfoError).additionalParams).toEqual({
        required_claims: [{
          claim_type: 'https://spec.knows.idlab.ugent.be/aggregator-protocol/latest/#derivation-access',
          friendly_name: 'Prove access to source',
          claim_token_format: 'urn:ietf:params:oauth:token-type:access_token',
          issuer: 'https://upstream.example/uma',
          derivation_resource_id: 'upstream-derived',
          resource_scopes: [ 'urn:knows:uma:scopes:derivation-read' ],
        }],
      });
    }
  });

  it('errors if an invalid ticket is provided.', async(): Promise<void> => {
    await expect(negotiator.negotiate({ ...input, ticket: 'ticket' }))
      .rejects.toThrow('The provided ticket is not valid.');
    expect(ticketStore.get).toHaveBeenCalledTimes(1);
    expect(ticketStore.get).toHaveBeenLastCalledWith('ticket');
  });

  it('uses the stored ticket if it is known.', async(): Promise<void> => {
    ticketData.set('ticket', ticket);
    await expect(negotiator.negotiate({ ...input, ticket: 'ticket' })).resolves
      .toEqual({ access_token: 'token', token_type: 'type' });
    expect(ticketStore.get).toHaveBeenCalledTimes(1);
    expect(ticketStore.get).toHaveBeenLastCalledWith('ticket');
    expect(ticketStore.set).toHaveBeenCalledTimes(0);
    expect(ticketStore.delete).toHaveBeenCalledTimes(1);
    expect(ticketStore.delete).toHaveBeenLastCalledWith('ticket');
    expect(ticketingStrategy.initializeTicket).toHaveBeenCalledTimes(0);
    expect(verifier.verify).toHaveBeenCalledTimes(0);
    expect(ticketingStrategy.validateClaims).toHaveBeenCalledTimes(0);
    expect(tokenFactory.serialize).toHaveBeenCalledTimes(1);
    expect(tokenFactory.serialize).toHaveBeenLastCalledWith(
      { permissions: { resource_id: 'id1', resource_scopes: [ 'scope1' ] } });
  });

  it('errors if invalid credentials are provided.', async(): Promise<void> => {
    await expect(negotiator.negotiate({ ...input, claim_token: 'token' }))
      .rejects.toThrow('Request with a "claim_token" must contain a "claim_token_format".');
    await expect(negotiator.negotiate({ ...input, claim_token_format: 'format' }))
      .rejects.toThrow('Request with a "claim_token_format" must contain a "claim_token".');
  });

  it('processes the credentials if they are provided.', async(): Promise<void> => {
    verifier.verify.mockImplementationOnce(async(_credential, claimSet): Promise<ClaimSet> => {
      Object.assign(claimSet!, claims);
      return claimSet!;
    });
    await expect(negotiator.negotiate({ ...input, claim_token: 'token', claim_token_format: 'format' })).resolves
      .toEqual({ access_token: 'token', token_type: 'type' });
    expect(ticketStore.get).toHaveBeenCalledTimes(0);
    expect(ticketStore.set).toHaveBeenCalledTimes(0);
    expect(ticketStore.delete).toHaveBeenCalledTimes(0);
    expect(ticketingStrategy.initializeTicket).toHaveBeenCalledTimes(1);
    expect(ticketingStrategy.initializeTicket).toHaveBeenLastCalledWith(input.permissions);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenLastCalledWith({ token: 'token', format: 'format' }, claims);
    expect(ticketingStrategy.validateClaims).toHaveBeenCalledTimes(1);
    expect(ticketingStrategy.validateClaims).toHaveBeenLastCalledWith(ticket, claims);
    expect(tokenFactory.serialize).toHaveBeenCalledTimes(1);
    expect(tokenFactory.serialize).toHaveBeenLastCalledWith(
      { permissions: { resource_id: 'id1', resource_scopes: [ 'scope1' ] } });
  });
});
