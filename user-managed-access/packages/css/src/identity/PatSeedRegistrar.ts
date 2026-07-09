import {
  AccountLoginStorage,
  AccountStore,
  WEBID_STORAGE_DESCRIPTION,
  WEBID_STORAGE_TYPE
} from '@solid/community-server';
import { StaticHandler } from 'asynchronous-handlers';
import { getLoggerFor } from 'global-logger-factory';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UmaClient } from '../uma/UmaClient';
import type { StatusDependant } from '../util/fetch/StatusDependant';
import {
  ACCOUNT_SETTINGS_AS_TOKEN,
  ACCOUNT_SETTINGS_AUTHZ_SERVER,
  UMA_ACCOUNT_STORAGE_TYPE
} from './interaction/account/util/AccountSettings';
import { PatUpdater } from './PatUpdater';

/**
 * This class waits for the status to be set to true,
 * and then registers a PAT client credentials for every account that has a WebID.
 *
 * The intended goal is for this is to ensure seeded accounts automatically get PAT client credentials.
 * It needs to wait until the server is active and listening so the PausableFetcher can be used.
 */
export class PatSeedRegistrar extends StaticHandler implements StatusDependant<boolean> {
  protected readonly logger = getLoggerFor(this);

  private readonly accountStorage: AccountLoginStorage<{ [WEBID_STORAGE_TYPE]: typeof WEBID_STORAGE_DESCRIPTION }>;

  public constructor(
    // Wrong typings to prevent Components.js typing issues
    accountStorage: AccountLoginStorage<Record<string, never>>,
    protected readonly accountStore: AccountStore<UMA_ACCOUNT_STORAGE_TYPE>,
    protected readonly umaClient: UmaClient,
    protected readonly patUpdater: PatUpdater,
    protected readonly rootFilePath?: string,
  ) {
    super();
    this.accountStorage = accountStorage as unknown as typeof this.accountStorage;
  }

  public async changeStatus(status: boolean): Promise<void> {
    if (status) {
      await this.initialize();
    }
  }

  protected async initialize(): Promise<void> {
    const accountMap = new Map<string, string>();
    const tasks: Promise<void>[] = [];
    this.logger.info('Registering PATs for seeded accounts');
    for (const { webId, accountId, issuer: seededIssuer } of await this.getSeededAccounts()) {
      // In case of multiple WebIDs just register the first one
      if (accountMap.has(accountId)) {
        this.logger.warn(`Multiple defined WebIDs for ${accountId}, only using ${accountMap.get(accountId)}`);
        continue;
      }
      accountMap.set(accountId, webId);
      tasks.push(this.initializeAccount(accountId, webId, seededIssuer));
    }
    await Promise.all(tasks);
    console.log(`QUERY_AGGREGATOR_EVALUATION_CSS_PAT_READY rootFilePath=${this.rootFilePath ?? ''} accounts=${accountMap.size}`);
  }

  protected async initializeAccount(accountId: string, webId: string, seededIssuer?: string): Promise<void> {
    if (await this.accountStore.getSetting(accountId, ACCOUNT_SETTINGS_AS_TOKEN)) {
      this.logger.debug(`Account ${accountId} with WebID ${webId} already has PAT client credentials`);
      return;
    }
    const issuer = await this.accountStore.getSetting(accountId, ACCOUNT_SETTINGS_AUTHZ_SERVER) ?? seededIssuer;
    if (!issuer) {
      this.logger.warn(`No issuer defined for account ${accountId} with WebID ${webId}`);
      return;
    }
    const { id, secret } = await this.umaClient.generateClientCredentials(webId, issuer);
    this.logger.info(`Generated client credentials for WebID ${webId}`);

    await this.patUpdater.updateSettings(accountId, id, secret, issuer);
  }

  protected async getSeededAccounts(): Promise<{ accountId: string; webId: string; issuer?: string }[]> {
    try {
      const accounts = [];
      for await (const { webId, accountId } of this.accountStorage.entries(WEBID_STORAGE_TYPE)) {
        accounts.push({ accountId, webId });
      }
      return accounts;
    } catch (error: unknown) {
      this.logger.warn(`Unable to iterate seeded WebID links through account storage: ${error instanceof Error ? error.message : String(error)}`);
      return this.getSeededAccountsFromFiles();
    }
  }

  protected async getSeededAccountsFromFiles(): Promise<{ accountId: string; webId: string; issuer?: string }[]> {
    if (!this.rootFilePath) {
      this.logger.warn('No root file path configured, unable to scan seeded account files');
      return [];
    }

    const accountsDir = path.join(this.rootFilePath, '.internal', 'accounts', 'data');
    const accountFiles = await fs.readdir(accountsDir).catch(() => []);
    const accounts: { accountId: string; webId: string; issuer?: string }[] = [];

    for (const file of accountFiles) {
      if (!file.endsWith('$.json')) {
        continue;
      }

      const content = await fs.readFile(path.join(accountsDir, file), 'utf8');
      const account = JSON.parse(content).payload as {
        id?: string;
        authzServer?: string;
        '**webIdLink**'?: Record<string, { webId?: string }>;
      };
      const accountId = account.id;
      const webId = Object.values(account['**webIdLink**'] ?? {}).find((link) => link.webId)?.webId;
      if (accountId && webId) {
        accounts.push({ accountId, webId, issuer: account.authzServer });
      }
    }

    return accounts;
  }
}
