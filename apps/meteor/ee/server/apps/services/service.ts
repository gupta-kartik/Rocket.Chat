import { ServiceClass } from '@rocket.chat/core-services';
import type { AppsEngineAppResult, IAppsEngineService } from '@rocket.chat/core-services';
import type { AppStatus } from '@rocket.chat/apps-engine/definition/AppStatus';
import { AppStatusUtils } from '@rocket.chat/apps-engine/definition/AppStatus';
import type { ISetting } from '@rocket.chat/core-typings';
import type { IAppStorageItem } from '@rocket.chat/apps-engine/server/storage';
import type { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import type { IGetAppsFilter } from '@rocket.chat/apps-engine/server/IGetAppsFilter';
import type { Db } from 'mongodb';
import type { IExternalComponent } from '@rocket.chat/apps-engine/definition/externalComponent';

import type { AppServerOrchestrator } from '../orchestrator';
import { Apps, AppEvents } from '../orchestrator';
import { SystemLogger } from '../../../../server/lib/logger/system';
import { OrchestratorFactory } from './orchestratorFactory';
import { transformProxiedAppToAppResult } from './lib/transformProxiedAppToAppResult';

export class AppsEngineService extends ServiceClass implements IAppsEngineService {
	protected name = 'apps-engine';

	private apps: AppServerOrchestrator;

	constructor(db: Db) {
		super();

		this.apps = OrchestratorFactory.getOrchestrator(db);
	}

	async started(): Promise<void> {
		this.initializeEventListeners();

		return this.apps.load();
	}

	async isInitialized(): Promise<boolean> {
		return Apps.isInitialized();
	}

	async getApps(query?: IGetAppsFilter): Promise<AppsEngineAppResult[] | undefined> {
		return Apps.getManager()?.get(query).map(transformProxiedAppToAppResult) as AppsEngineAppResult[];
	}

	async getAppStorageItemById(appId: string): Promise<IAppStorageItem | undefined> {
		const app = Apps.getManager()?.getOneById(appId);

		if (!app) {
			return;
		}

		return app.getStorageItem();
	}

	async triggerEvent(event: string, ...payload: any): Promise<any> {
		return this.apps.triggerEvent(event, ...payload);
	}

	async updateAppsMarketplaceInfo(apps: Array<IAppInfo>): Promise<AppsEngineAppResult[] | undefined> {
		return this.apps
			.updateAppsMarketplaceInfo(apps)
			.then((apps) => (apps ? (apps.map(transformProxiedAppToAppResult) as AppsEngineAppResult[]) : undefined));
	}

	async load(): Promise<void> {
		return this.apps.load();
	}

	async unload(): Promise<void> {
		return this.apps.unload();
	}

	async isLoaded(): Promise<boolean> {
		return this.apps.isLoaded();
	}

	async getMarketplaceUrl(): Promise<string> {
		return this.apps.getMarketplaceUrl() as string;
	}

	async getProvidedComponents(): Promise<IExternalComponent[]> {
		return this.apps.getProvidedComponents();
	}

	async fetchAppSourceStorage(storageItem: IAppStorageItem): Promise<Buffer | undefined> {
		return this.apps.getAppSourceStorage()?.fetch(storageItem);
	}

	async setStorage(value: string): Promise<void> {
		return this.apps.getAppSourceStorage()?.setStorage(value);
	}

	async setFileSystemStoragePath(value: string): Promise<void> {
		return this.apps.getAppSourceStorage()?.setFileSystemStoragePath(value);
	}

	private initializeEventListeners() {
		this.onEvent('presence.status', async ({ user, previousStatus }): Promise<void> => {
			await Apps.triggerEvent(AppEvents.IPostUserStatusChanged, {
				user,
				currentStatus: user.status,
				previousStatus,
			});
		});

		this.onEvent('apps.added', async (appId: string): Promise<void> => {
			// if the app already exists in this instance, don't load it again
			const app = Apps.getManager()?.getOneById(appId);

			if (app) {
				return;
			}

			await (Apps.getManager() as any)?.loadOne(appId);
		});

		this.onEvent('apps.removed', async (appId: string): Promise<void> => {
			const app = Apps.getManager()?.getOneById(appId);
			if (!app) {
				return;
			}

			await Apps.getManager()?.removeLocal(appId);
		});

		this.onEvent('apps.updated', async (appId: string): Promise<void> => {
			const storageItem = await Apps.getStorage()?.retrieveOne(appId);
			if (!storageItem) {
				return;
			}

			const appPackage = await Apps.getAppSourceStorage()?.fetch(storageItem);
			if (!appPackage) {
				return;
			}

			await Apps.getManager()?.updateLocal(storageItem, appPackage);
		});

		this.onEvent('apps.statusUpdate', async (appId: string, status: AppStatus): Promise<void> => {
			const app = Apps.getManager()?.getOneById(appId);
			if (!app || app.getStatus() === status) {
				return;
			}

			if (AppStatusUtils.isEnabled(status)) {
				await Apps.getManager()?.enable(appId).catch(SystemLogger.error);
			} else if (AppStatusUtils.isDisabled(status)) {
				await Apps.getManager()?.disable(appId, status, true).catch(SystemLogger.error);
			}
		});

		this.onEvent('apps.settingUpdated', async (appId: string, setting: ISetting & { id: string }): Promise<void> => {
			const app = Apps.getManager()?.getOneById(appId);
			const oldSetting = app?.getStorageItem().settings[setting.id].value;

			// avoid updating the setting if the value is the same,
			// which caused an infinite loop
			if (oldSetting === setting.value) {
				return;
			}

			const appManager = Apps.getManager();
			if (!appManager) {
				return;
			}

			await appManager.getSettingsManager().updateAppSetting(appId, setting as any);
		});
	}
}
