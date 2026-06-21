import { randomUUID } from 'node:crypto';
import { Ticket } from '../ticketing/Ticket';
import { Verifier } from '../credentials/verify/Verifier';
import { TokenFactory } from '../tokens/TokenFactory';
import { Negotiator } from './Negotiator';
import { NeedInfoError } from '../errors/NeedInfoError';
import { DialogInput } from './Input';
import { DialogOutput } from './Output';
import { reType } from '../util/ReType';
import { TicketingStrategy } from '../ticketing/strategy/TicketingStrategy';
import {
  BadRequestHttpError, ForbiddenHttpError,
  getLoggerFor,
  HttpErrorClass,
  KeyValueStorage
} from '@solid/community-server';
import { getOperationLogger } from '../logging/OperationLogger';
import { serializePolicyInstantiation } from '../logging/OperationSerializer';
import { Permission } from '../views/Permission';
import { ResourceDescription } from '../views/ResourceDescription';
import {ClaimSet} from "../credentials/ClaimSet";
import {DERIVATION_ACCESS, UPSTREAMPERMISSION} from "../credentials/Claims";
import {ACCESSTOKEN} from "../credentials/Formats";

/**
 * A concrete Negotiator that verifies incoming Claims and processes Tickets
 * according to a TicketingStrategy.
 */
export class BaseNegotiator implements Negotiator {
  protected readonly logger = getLoggerFor(this);
  protected readonly operationLogger = getOperationLogger();

  /**
   * Construct a new Negotiator
   * @param verifier - The Verifier used to verify Claims of incoming Credentials.
   * @param ticketStore - A KeyValueStorage to track Tickets.
   * @param ticketingStrategy - The strategy describing the life cycle of a Ticket.
   * @param tokenFactory - A factory for minting Access Tokens.
   * @param resourceStore - Store with ResourceRegistration to discover upstream relations.
   */
  public constructor(
    protected verifier: Verifier,
    protected ticketStore: KeyValueStorage<string, Ticket>,
    protected ticketingStrategy: TicketingStrategy,
    protected tokenFactory: TokenFactory,
    protected readonly resourceStore: KeyValueStorage<string, ResourceDescription>,
  ) {}

  /**
   * Performs UMA grant negotiation.
   */
  public async negotiate(input: DialogInput): Promise<DialogOutput> {
    reType(input, DialogInput);

    // Create or retrieve ticket
    let ticket = await this.getTicket(input);
    this.logger.debug(`Processing ticket. ${JSON.stringify(ticket)}`);

    const additionalScopes = input.scope?.split(' ');
    if (additionalScopes) {
      for (const permission of ticket.permissions) {
        permission.resource_scopes = permission.resource_scopes.concat(additionalScopes)
      }
      ticket = await this.ticketingStrategy.initializeTicket(ticket.permissions);
      this.logger.debug(`Updated ticket with additional scopes. ${JSON.stringify(ticket)}`);
    }

    // Process pushed credentials
    const updatedTicket = await this.processCredentials(input, ticket);
    this.logger.debug(`resolved result ${JSON.stringify(updatedTicket)}`);

    // Try to resolve ticket ...
    const resolved = await this.ticketingStrategy.resolveTicket(updatedTicket);
    this.logger.debug(`Resolved ticket ${JSON.stringify(resolved)}`);

    // ... on success, create Access Token
    if (resolved.success) {
      // Retrieve / create instantiated policy
      const { token, tokenType } = await this.tokenFactory.serialize({ permissions: resolved.value });
      this.logger.debug(`Minted token ${JSON.stringify(token)}`);

      // TODO:: test logging
      this.operationLogger.addLogEntry(serializePolicyInstantiation())

      const resultObj: DialogOutput = {
        access_token: token,
        token_type: tokenType
      };

      if (additionalScopes?.includes("urn:knows:uma:scopes:derivation-creation")) {
        const handle_id = randomUUID();
        this.resourceStore.set(handle_id, {
          resource_scopes: ["urn:knows:uma:scopes:derivation-read"],
        });
        const managementToken = await this.tokenFactory.serialize({
          permissions: [{
            resource_id: handle_id,
            resource_scopes: [
              "urn:knows:uma:scopes:write",
              "urn:knows:uma:scopes:delete",
            ],
          }],
        });
        resultObj['derivation_resource_id'] = handle_id;
        resultObj['management_access_token'] = {
          access_token: managementToken.token,
          token_type: managementToken.tokenType,
        };
      }

      // TODO:: dynamic contract link to stored signed contract.
      // If needed we can always embed here directly into the return JSON
      return resultObj;
    }

    // ... on failure, deny if no solvable requirements
    // Build detailed required_claims with upstream discovery if possible
    const requiredClaims = await this.buildUpstreamRequiredClaims(ticket.permissions);
    for (const req of ticket.required) {
      for (const key of Object.keys(req)){
        if (key !== UPSTREAMPERMISSION) {
          requiredClaims.push({
            "claim_token_format": key
          });
        }
      }
    }
    if (requiredClaims.length === 0) throw new ForbiddenHttpError();

    // ... require more info otherwise
    const id = randomUUID();
    await this.ticketStore.set(id, ticket);
    throw new NeedInfoError('Need more info to authorize request ...', id, {
      required_claims: requiredClaims,
    });
  }

  // TODO:
  protected denyRequest(ticket: Ticket): never {
    const requiredClaims = ticket.required.map(req => Object.keys(req));
    if (requiredClaims.length === 0) throw new ForbiddenHttpError();

    // ... require more info otherwise
    const id = randomUUID();
    this.ticketStore.set(id, ticket);
    throw new NeedInfoError('Need more info to authorize request ...', id, {
      required_claims: {
        claim_token_format: requiredClaims,
      },
    });
  }

  /**
   * Helper function that retrieves a Ticket from the TicketStore if it exists,
   * or initializes a new one otherwise.
   *
   * @param input - The input of the negotiation dialog.
   *
   * @returns The Ticket describing the dialog at hand.
   */
  protected async getTicket(input: DialogInput): Promise<Ticket> {
    const { ticket, permissions } = input;

    if (ticket) {
      const stored = await this.ticketStore.get(ticket);
      if (!stored) this.error(BadRequestHttpError, 'The provided ticket is not valid.');

      await this.ticketStore.delete(ticket);
      return stored;
    }

    if (!permissions) {
      this.error(BadRequestHttpError, 'A token request without existing ticket should include requested permissions.');
    }

    return await this.ticketingStrategy.initializeTicket(permissions);
  }

  /**
   * Helper function that checks for the presence of Credentials and, if present,
   * verifies them and validates them in context of the provided Ticket.
   *
   * @param input - The input of the negotiation dialog.
   * @param ticket - The Ticket against which to validate any Credentials.
   *
   * @returns An updated Ticket in which the Credentials have been validated.
   */
  protected async processCredentials(input: DialogInput, ticket: Ticket): Promise<Ticket> {
    const claims: ClaimSet = {};

    const { claim_token: token, claim_token_format: format } = input;
    if (token || format) {
      if (!token) this.error(BadRequestHttpError, 'Request with a "claim_token_format" must contain a "claim_token".');
      if (!format) this.error(BadRequestHttpError, 'Request with a "claim_token" must contain a "claim_token_format".');

      await this.verifier.verify({ token, format }, claims);
    }
    if (input.claim_tokens) {
        for (const cred of input.claim_tokens) {
          if (!cred.claim_token)
            this.error(BadRequestHttpError, 'Request with a "claim_token_format" must contain a "claim_token".');
          if (!cred.claim_token_format)
            this.error(BadRequestHttpError, 'Request with a "claim_token" must contain a "claim_token_format".');

          await this.verifier.verify({
            token: cred.claim_token,
            format: cred.claim_token_format
          }, claims);
        }
    }
    if (Object.keys(claims).length > 0){
      return await this.ticketingStrategy.validateClaims(ticket, claims);
    }

    return ticket;
  }

  /**
   * Logs and throws an error
   *
   * @param {HttpErrorClass} constructor - The error constructor.
   * @param {string} message - The error message.
   *
   * @throws An Error constructed with the provided constructor with the
   * provided message
   */
  protected error(constructor: HttpErrorClass, message: string): never {
    this.logger.warn(message);
    throw new constructor(message);
  }

  /**
   * Build required_claims array based on upstream derivations in resource_relations.
   * Performs UMA discovery by issuing HEAD to RS1 to obtain as_uri and ticket (T1).
   */
  protected async buildUpstreamRequiredClaims(permissions: Permission[]): Promise<any[]> {
    const claims: any[] = [];

    for (const perm of permissions ?? []) {
      const desc = await this.resourceStore.get(perm.resource_id);
      const relations = desc?.resource_relations as NodeJS.Dict<string[] | unknown> | undefined;
      if (!relations) continue;

      const upstream = Array.isArray(relations['prov:wasDerivedFrom'])
        ? relations['prov:wasDerivedFrom'] as {issuer: string, derivation_resource_id: string}[]
        : [relations['prov:wasDerivedFrom'] as {issuer: string, derivation_resource_id: string}];

      for (const src of upstream) {
        claims.push({
          claim_type: DERIVATION_ACCESS,
          friendly_name: "Prove access to source",
          claim_token_format: ACCESSTOKEN,
          issuer: src.issuer,
          derivation_resource_id: src.derivation_resource_id,
          resource_scopes: ["urn:knows:uma:scopes:derivation-read"],
        });
      }
    }

    return claims;
  }
}
