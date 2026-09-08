import * as vscode from 'vscode';
import * as oracledb from 'oracledb';

export type EnvironmentKind = 'dev' | 'uat' | 'prod';
export type ApiAuthType = 'none' | 'bearer' | 'basic';
export type ComponentType = 'serviceScript' | 'businessObject' | 'businessService' | 'zone';

export interface EnvironmentProfile {
	name: string;
	kind: EnvironmentKind;
	baseUrl: string;
	apiPath: string;
	authType?: ApiAuthType;
	localDirectory?: string;
	database?: { host: string; port: string; service: string; user: string };
}

export interface Credentials {
	token?: string;
	apiUsername?: string;
	apiPassword?: string;
	databasePassword?: string;
}

export interface ComponentSelection {
	type: ComponentType;
	name: string;
}

export interface ServiceScript extends ComponentSelection {
	type: 'serviceScript';
	description: string;
}

export const componentTypes: Array<{ label: string; type: ComponentType }> = [
	{ label: 'Script', type: 'serviceScript' },
];

const SERVICE_SCRIPT_QUERY = `
	SELECT SCR_CD, DESCR254
	FROM CI_SCR_L
	WHERE OWNER_FLG = 'CM'
	  AND LANGUAGE_CD = 'ENG'
	ORDER BY DESCR254`;

const FILTERED_SERVICE_SCRIPT_QUERY = `
	SELECT SCR_CD, DESCR254
	FROM CI_SCR_L
	WHERE LOWER(SCR_CD) LIKE LOWER(:FILTER_CD)
	  AND OWNER_FLG = 'CM'
	  AND LANGUAGE_CD = 'ENG'
	ORDER BY DESCR254`;

const SERVICE_SCRIPT_API_NAME = 'CmScriptAsTextViewer';

export class OuafStore {
	private static readonly profilesKey = 'ouaf.environments';
	private static readonly connectedEnvironmentsKey = 'ouaf.connectedEnvironments';

	public constructor(private readonly state: vscode.Memento, private readonly secrets: vscode.SecretStorage) {}

	public profiles(): EnvironmentProfile[] {
		return this.state.get<EnvironmentProfile[]>(OuafStore.profilesKey, []);
	}

	public connectedEnvironmentNames(): string[] {
		const stored = this.state.get<string[] | undefined>(OuafStore.connectedEnvironmentsKey);
		return stored ?? this.profiles().map((profile) => profile.name);
	}

	public async setEnvironmentConnected(environmentName: string, connected: boolean): Promise<void> {
		const names = new Set(this.connectedEnvironmentNames());
		if (connected) { names.add(environmentName); } else { names.delete(environmentName); }
		await this.state.update(OuafStore.connectedEnvironmentsKey, [...names]);
	}

	public async saveProfile(profile: EnvironmentProfile, credentials?: Credentials): Promise<void> {
		const profiles = this.profiles().filter((item) => item.name !== profile.name);
		await this.state.update(OuafStore.profilesKey, [...profiles, profile]);
		await this.saveSecret(`ouaf.token.${profile.name}`, credentials?.token);
		await this.saveSecret(`ouaf.api.username.${profile.name}`, credentials?.apiUsername);
		await this.saveSecret(`ouaf.api.password.${profile.name}`, credentials?.apiPassword);
		await this.saveSecret(`ouaf.database.password.${profile.name}`, credentials?.databasePassword);
	}

	private async saveSecret(key: string, value: string | undefined): Promise<void> {
		if (value !== undefined) {
			await this.secrets.store(key, value);
		}
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
		if (component.type === 'serviceScript') {
			return this.fetchServiceScript(profile, component.name);
		}
		const response = await this.request(profile, `${profile.apiPath}/${component.type}/${encodeURIComponent(component.name)}`);
		return response.text();
	}

	private async fetchServiceScript(profile: EnvironmentProfile, scriptCode: string): Promise<string> {
		return this.fetchServiceScriptPart(profile, scriptCode, '');
	}

	public async serviceScriptSteps(profile: EnvironmentProfile, scriptCode: string): Promise<string> {
		return this.fetchServiceScriptPart(profile, scriptCode, 's');
	}

	public async serviceScriptSchema(profile: EnvironmentProfile, scriptCode: string): Promise<string> {
		return this.fetchServiceScriptPart(profile, scriptCode, 'x');
	}

	private async fetchServiceScriptPart(profile: EnvironmentProfile, scriptCode: string, option: '' | 's' | 'x'): Promise<string> {
		const soapPayload = createServiceScriptRequest(scriptCode, option);
		const response = await this.request(
			profile,
			`${profile.apiPath}/${SERVICE_SCRIPT_API_NAME}`,
			'POST',
			soapPayload,
			'text/xml; charset=utf-8',
		);
		const responseText = await response.text();
		if (/^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(responseText)) {
			throw new Error(`${profile.name} returned an HTML page instead of SOAP. Check the target API path and authentication. Response: ${responseText.slice(0, 300)}`);
		}
		return extractServiceScriptContent(responseText, scriptCode, option === 'x' ? 'schemaDefinition' : 'editDataArea');
	}

	public async testApi(profile: EnvironmentProfile, credentials?: Credentials): Promise<void> {
		await this.request(profile, profile.apiPath, 'GET', undefined, undefined, credentials);
	}

	public async testDatabase(profile: EnvironmentProfile, credentials?: Credentials): Promise<void> {
		const connection = await this.openDatabase(profile, credentials?.databasePassword);
		try {
			await connection.execute('SELECT 1 FROM DUAL');
		} finally {
			await connection.close();
		}
	}

	public async serviceScripts(profile: EnvironmentProfile, filter?: string, credentials?: Credentials): Promise<ServiceScript[]> {
		const connection = await this.openDatabase(profile, credentials?.databasePassword);
		try {
			const query = filter ? FILTERED_SERVICE_SCRIPT_QUERY : SERVICE_SCRIPT_QUERY;
			const binds = filter ? { FILTER_CD: `%${filter}%` } : [];
			const result = await connection.execute<ServiceScriptRow>(query, binds, {
				outFormat: oracledb.OUT_FORMAT_OBJECT,
			});
			return (result.rows ?? []).map(toServiceScript);
		} finally {
			await connection.close();
		}
	}

	private async openDatabase(profile: EnvironmentProfile, password: string | undefined): Promise<oracledb.Connection> {
		const database = profile.database;
		if (!database) {
			throw new Error(`${profile.name} has no Oracle database settings.`);
		}
		const databasePassword = password ?? await this.store.databasePasswordFor(profile.name);
		if (!databasePassword) {
			throw new Error(`A database password is required for ${profile.name}.`);
		}
		return oracledb.getConnection({
			user: database.user,
			password: databasePassword,
			connectString: `${database.host}:${database.port}/${database.service}`,
		});
	}

	private async request(profile: EnvironmentProfile, path: string, method = 'GET', body?: string, contentType?: string, suppliedCredentials?: Credentials): Promise<Response> {
		const credentials = suppliedCredentials ?? await this.loadCredentials(profile.name);
		const headers: Record<string, string> = { Accept: 'application/json, text/plain, text/xml' };
		if (contentType) {
			headers['Content-Type'] = contentType;
		}
		if (profile.authType === 'basic' && credentials.apiUsername && credentials.apiPassword) {
			headers.Authorization = `Basic ${Buffer.from(`${credentials.apiUsername}:${credentials.apiPassword}`).toString('base64')}`;
		} else if (profile.authType !== 'none' && credentials.token) {
			headers.Authorization = `Bearer ${credentials.token}`;
		}
		const url = `${profile.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '').replace(/\/$/, '')}`;
		const requestBody = body ?? (method === 'POST' ? JSON.stringify({ database: profile.database, databasePassword: credentials.databasePassword }) : undefined);
		const response = await fetch(url, { method, headers, body: requestBody });
		if (!response.ok) {
			const responseText = (await response.text()).slice(0, 300);
			throw new Error(`${profile.name} returned ${response.status} ${response.statusText} for ${url}. Response: ${responseText}`);
		}
		return response;
	}

	private async loadCredentials(profileName: string): Promise<Credentials> {
		const apiCredentials = await this.store.apiCredentialsFor(profileName);
		return {
			token: await this.store.tokenFor(profileName),
			apiUsername: apiCredentials.username,
			apiPassword: apiCredentials.password,
			databasePassword: await this.store.databasePasswordFor(profileName),
		};
	}
}

interface ServiceScriptRow {
	SCR_CD: string;
	DESCR254: string;
}

function toServiceScript(row: ServiceScriptRow): ServiceScript {
	return {
		type: 'serviceScript',
		name: row.SCR_CD,
		description: row.DESCR254,
	};
}

function createServiceScriptRequest(scriptCode: string, option: '' | 's' | 'x'): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
	<Body>
        <${SERVICE_SCRIPT_API_NAME} xmlns="http://oracle.com/CmScriptAsTextViewer.xsd">
			<option>${option}</option>
            <script>${escapeXml(scriptCode)}</script>
        </${SERVICE_SCRIPT_API_NAME}>
	</Body>
</Envelope>`;
}

function extractServiceScriptContent(xml: string, scriptCode: string, elementName: 'schemaDefinition' | 'editDataArea'): string {
	const response = xml.trim();
	const elementPattern = new RegExp(`<(?:[\\w.-]+:)?${elementName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${elementName}>`, 'i');
	const match = response.match(elementPattern);
	if (!match) {
		const escapedResponse = decodeXml(response);
		const escapedMatch = escapedResponse.match(elementPattern);
		if (escapedMatch) {
			return cleanServiceScriptContent(escapedMatch[1]);
		}
		throw new Error(`The ${SERVICE_SCRIPT_API_NAME} response did not contain ${elementName} for ${scriptCode}. Response: ${response.slice(0, 300)}`);
	}
	return cleanServiceScriptContent(match[1]);
}

function cleanServiceScriptContent(value: string): string {
	return decodeXml(value.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim());
}

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
	return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}