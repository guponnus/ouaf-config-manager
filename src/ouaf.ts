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

export interface ProjectEnvironmentConfiguration {
	profiles: EnvironmentProfile[];
	connectedEnvironments?: string[];
}

export interface ComponentSelection {
	type: ComponentType;
	name: string;
}

export interface ServiceScript extends ComponentSelection {
	type: 'serviceScript';
	description: string;
}

export interface ServiceScriptDataArea {
	schemaTypeFlag: string;
	daName: string;
	schemaName: string;
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

export function buildFilteredServiceScriptQuery(): string {
	return `
	SELECT SCR_CD, DESCR254
	FROM CI_SCR_L
	WHERE (LOWER(SCR_CD) LIKE LOWER(:FILTER_CD)
	   OR LOWER(DESCR254) LIKE LOWER(:FILTER_CD))
	  AND OWNER_FLG = 'CM'
	  AND LANGUAGE_CD = 'ENG'
	ORDER BY DESCR254`;
}

const FILTERED_SERVICE_SCRIPT_QUERY = buildFilteredServiceScriptQuery();

const SERVICE_SCRIPT_DATA_AREA_QUERY = `
	SELECT REPLACE(SCHEMA_TYPE_FLG, 'F1', '') AS SCHEMA_TYPE_FLG, DA_NAME, SCHEMA_NAME
	FROM CI_SCR_DA
	WHERE SCR_CD = :SCR_CD
	  AND DA_NAME != 'parm'`;

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

	public async removeProfile(profileName: string): Promise<void> {
		await this.state.update(OuafStore.profilesKey, this.profiles().filter((profile) => profile.name !== profileName));
		await this.setEnvironmentConnected(profileName, false);
		await Promise.all([
			this.secrets.delete(`ouaf.token.${profileName}`),
			this.secrets.delete(`ouaf.api.username.${profileName}`),
			this.secrets.delete(`ouaf.api.password.${profileName}`),
			this.secrets.delete(`ouaf.database.password.${profileName}`),
		]);
	}

	public async replaceProfiles(profiles: EnvironmentProfile[], connectedEnvironments?: string[]): Promise<void> {
		await this.state.update(OuafStore.profilesKey, profiles);
		if (connectedEnvironments) {
			await this.state.update(OuafStore.connectedEnvironmentsKey, connectedEnvironments);
		}
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
		return this.fetchServiceScriptPart(profile, scriptCode, 'S');
	}

	public async serviceScriptSchema(profile: EnvironmentProfile, scriptCode: string): Promise<string> {
		return this.fetchServiceScriptPart(profile, scriptCode, 'X');
	}

	public async serviceScriptDataAreas(profile: EnvironmentProfile, scriptCode: string): Promise<ServiceScriptDataArea[]> {
		const connection = await this.openDatabase(profile, undefined, 'service script data area query');
		try {
			const result = await connection.execute<ServiceScriptDataAreaRow>(SERVICE_SCRIPT_DATA_AREA_QUERY, { SCR_CD: scriptCode }, {
				outFormat: oracledb.OUT_FORMAT_OBJECT,
			});
			return (result.rows ?? []).map((row) => ({
				schemaTypeFlag: row.SCHEMA_TYPE_FLG,
				daName: row.DA_NAME,
				schemaName: row.SCHEMA_NAME,
			}));
		} finally {
			await connection.close();
		}
	}

	public async serviceScriptDataArea(profile: EnvironmentProfile, scriptCode: string, schemaName: string, dataAreaName: string): Promise<string> {
		return this.fetchServiceScriptPart(profile, scriptCode, 'D', schemaName, dataAreaName);
	}

	private async fetchServiceScriptPart(profile: EnvironmentProfile, scriptCode: string, option: '' | 'S' | 'X' | 'D', schemaName?: string, dataAreaName?: string): Promise<string> {
		const soapPayload = createServiceScriptRequest(scriptCode, option, schemaName, dataAreaName);
		const response = await this.request(
			profile,
			`${profile.apiPath}/${SERVICE_SCRIPT_API_NAME}`,
			'POST',
			soapPayload,
			'text/xml; charset=utf-8',
		);
		const responseText = await response.text();
		const soapFault = extractSoapFaultMessage(responseText);
		if (soapFault) {
			throw new Error(`${profile.name} SOAP fault: ${soapFault}`);
		}
		if (/^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(responseText)) {
			throw new Error(`${profile.name} returned an HTML page instead of SOAP. Check the target API path and authentication. Response: ${responseText.slice(0, 300)}`);
		}
		return extractServiceScriptContent(responseText, scriptCode, option === 'X' || option === 'D' ? 'schemaDefinition' : 'editDataArea');
	}

	public async testApi(profile: EnvironmentProfile, credentials?: Credentials): Promise<void> {
		await this.request(profile, profile.apiPath, 'GET', undefined, undefined, credentials);
	}

	public async testDatabase(profile: EnvironmentProfile, credentials?: Credentials): Promise<void> {
		const connection = await this.openDatabase(profile, credentials?.databasePassword, 'connection test');
		try {
			await connection.execute('SELECT 1 FROM DUAL');
		} finally {
			await connection.close();
		}
	}

	public async serviceScripts(profile: EnvironmentProfile, filter?: string, credentials?: Credentials): Promise<ServiceScript[]> {
		const connection = await this.openDatabase(profile, credentials?.databasePassword, 'service script query');
		try {
			const query = filter ? buildFilteredServiceScriptQuery() : SERVICE_SCRIPT_QUERY;
			const binds = filter ? { FILTER_CD: `%${filter}%` } : [];
			const result = await connection.execute<ServiceScriptRow>(query, binds, {
				outFormat: oracledb.OUT_FORMAT_OBJECT,
			});
			return (result.rows ?? []).map(toServiceScript);
		} finally {
			await connection.close();
		}
	}

	private async openDatabase(profile: EnvironmentProfile, password: string | undefined, operation: string): Promise<oracledb.Connection> {
		const database = profile.database;
		if (!database) {
			throw new Error(`${profile.name} has no Oracle database settings.`);
		}
		const databasePassword = password ?? await this.store.databasePasswordFor(profile.name);
		if (!databasePassword) {
			throw new Error(`A database password is required for ${profile.name}.`);
		}
		try {
			return await oracledb.getConnection({
				user: database.user,
				password: databasePassword,
				connectString: `${database.host}:${database.port}/${database.service}`,
			});
		} catch (error) {
			throw new Error(`Database ${operation} failed for ${profile.name}: ${errorMessage(error)}`);
		}
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
		let response: Response;
		try {
			response = await fetch(url, { method, headers, body: requestBody });
		} catch (error) {
			throw new Error(`API request failed for ${profile.name} (${method} ${url}): ${errorMessage(error)}`);
		}
		if (!response.ok) {
			const responseText = await response.text();
			const soapFault = extractSoapFaultMessage(responseText);
			const responseMessage = soapFault ?? extractResponseMessage(responseText) ?? responseText.slice(0, 300);
			throw new Error(`API request failed for ${profile.name} (${response.status} ${response.statusText}): ${responseMessage}`);
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

interface ServiceScriptDataAreaRow {
	SCHEMA_TYPE_FLG: string;
	DA_NAME: string;
	SCHEMA_NAME: string;
}

function toServiceScript(row: ServiceScriptRow): ServiceScript {
	return {
		type: 'serviceScript',
		name: row.SCR_CD,
		description: row.DESCR254,
	};
}

function createServiceScriptRequest(scriptCode: string, option: '' | 'S' | 'X' | 'D', schemaName?: string, dataAreaName?: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
	<Body>
        <${SERVICE_SCRIPT_API_NAME} xmlns="http://oracle.com/CmScriptAsTextViewer.xsd">
			<option>${option}</option>
            <script>${escapeXml(scriptCode)}</script>
			${schemaName ? `<schemaName>${escapeXml(schemaName)}</schemaName>` : ''}
			${dataAreaName ? `<dataAreaName>${escapeXml(dataAreaName)}</dataAreaName>` : ''}
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function extractResponseMessage(response: string): string | undefined {
	try {
		const parsed = JSON.parse(response) as { message?: unknown; error?: unknown };
		const message = parsed.message ?? parsed.error;
		return typeof message === 'string' ? message : undefined;
	} catch {
		return undefined;
	}
}

export function extractSoapFaultMessage(xml: string): string | undefined {
	const match = xml.match(/<(?:[\w.-]+:)?Text(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?Text>/i);
	return match ? decodeXml(match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : undefined;
}