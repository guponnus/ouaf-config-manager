import * as vscode from 'vscode';

export type EnvironmentKind = 'dev' | 'uat' | 'prod';
export type ApiAuthType = 'none' | 'bearer' | 'basic';
export type ComponentType = 'serviceScript' | 'businessObject' | 'businessService' | 'zone';

export interface EnvironmentProfile {
	name: string;
	kind: EnvironmentKind;
	baseUrl: string;
	apiPath: string;
	authType?: ApiAuthType;
	database?: { host: string; port: string; service: string; user: string };
}

export interface ComponentSelection {
	type: ComponentType;
	name: string;
}

export const componentTypes: Array<{ label: string; type: ComponentType }> = [
	{ label: 'Service script', type: 'serviceScript' },
	{ label: 'Business object', type: 'businessObject' },
	{ label: 'Business service', type: 'businessService' },
	{ label: 'Zone', type: 'zone' },
];

export class OuafStore {
	private static readonly profilesKey = 'ouaf.environments';

	public constructor(private readonly state: vscode.Memento, private readonly secrets: vscode.SecretStorage) {}

	public profiles(): EnvironmentProfile[] {
		return this.state.get<EnvironmentProfile[]>(OuafStore.profilesKey, []);
	}

	public async saveProfile(profile: EnvironmentProfile, credentials?: { token?: string; apiUsername?: string; apiPassword?: string; databasePassword?: string }): Promise<void> {
		const profiles = this.profiles().filter((item) => item.name !== profile.name);
		await this.state.update(OuafStore.profilesKey, [...profiles, profile]);
		if (credentials?.token !== undefined) { await this.secrets.store(`ouaf.token.${profile.name}`, credentials.token); }
		if (credentials?.apiUsername !== undefined) { await this.secrets.store(`ouaf.api.username.${profile.name}`, credentials.apiUsername); }
		if (credentials?.apiPassword !== undefined) { await this.secrets.store(`ouaf.api.password.${profile.name}`, credentials.apiPassword); }
		if (credentials?.databasePassword !== undefined) { await this.secrets.store(`ouaf.database.password.${profile.name}`, credentials.databasePassword); }
	}

	public async tokenFor(profileName: string): Promise<string | undefined> {
		return this.secrets.get(`ouaf.token.${profileName}`);
	}

	public async apiCredentialsFor(profileName: string): Promise<{ username?: string; password?: string }> {
		return { username: await this.secrets.get(`ouaf.api.username.${profileName}`), password: await this.secrets.get(`ouaf.api.password.${profileName}`) };
	}

	public async databasePasswordFor(profileName: string): Promise<string | undefined> {
		return this.secrets.get(`ouaf.database.password.${profileName}`);
	}
}

export class OuafClient {
	public constructor(private readonly store: OuafStore) {}

	public async fetch(profile: EnvironmentProfile, component: ComponentSelection): Promise<string> {
		const response = await this.request(profile, `${profile.apiPath}/${component.type}/${encodeURIComponent(component.name)}`);
		return response.text();
	}

	public async testApi(profile: EnvironmentProfile, credentials?: { token?: string; apiUsername?: string; apiPassword?: string }): Promise<void> {
		await this.request(profile, profile.apiPath, credentials);
	}

	public async testDatabase(profile: EnvironmentProfile, credentials?: { token?: string; apiUsername?: string; apiPassword?: string; databasePassword?: string }): Promise<void> {
		await this.request(profile, `${profile.apiPath}/database/test`, credentials, 'POST');
	}

	private async request(profile: EnvironmentProfile, path: string, suppliedCredentials?: { token?: string; apiUsername?: string; apiPassword?: string; databasePassword?: string }, method = 'GET'): Promise<Response> {
		const credentials = suppliedCredentials || { token: await this.store.tokenFor(profile.name), ...(await this.store.apiCredentialsFor(profile.name)), databasePassword: await this.store.databasePasswordFor(profile.name) };
		const headers: Record<string, string> = { Accept: 'application/json, text/plain' };
		if (profile.authType === 'basic' && credentials.apiUsername && credentials.apiPassword) {
			headers.Authorization = `Basic ${Buffer.from(`${credentials.apiUsername}:${credentials.apiPassword}`).toString('base64')}`;
		} else if (profile.authType !== 'none' && credentials.token) {
			headers.Authorization = `Bearer ${credentials.token}`;
		}
		const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '').replace(/\/$/, '')}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify({ database: profile.database, databasePassword: credentials.databasePassword }) } : {}) });
		if (!response.ok) { throw new Error(`${profile.name} returned ${response.status} ${response.statusText}`); }
		return response;
	}
}