import * as vscode from 'vscode';
import { ComponentSelection, componentTypes, EnvironmentKind, EnvironmentProfile, OuafClient, OuafStore } from './ouaf';

class OuafTreeDataProvider implements vscode.TreeDataProvider<EnvironmentProfile | ComponentSelection> {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly onDidChangeTreeData = this.changed.event;
	public constructor(private readonly store: OuafStore) {}
	public refresh(): void { this.changed.fire(); }
	public getTreeItem(item: EnvironmentProfile | ComponentSelection): vscode.TreeItem {
		if ('kind' in item) {
			const treeItem = new vscode.TreeItem(`${item.name} (${item.kind.toUpperCase()})`, vscode.TreeItemCollapsibleState.Expanded);
			treeItem.description = item.baseUrl;
			treeItem.iconPath = new vscode.ThemeIcon(item.kind === 'prod' ? 'shield' : item.kind === 'uat' ? 'testing-passed-icon' : 'code-oss');
			treeItem.command = { command: 'ouaf-config-manager.editEnvironment', title: 'Edit OUAF Environment', arguments: [item.name] };
			return treeItem;
		}
		const treeItem = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None);
		treeItem.description = componentTypes.find((type) => type.type === item.type)?.label;
		treeItem.iconPath = new vscode.ThemeIcon(componentIcon(item.type));
		treeItem.command = { command: 'ouaf-config-manager.compare', title: 'Compare OUAF Component', arguments: [item] };
		return treeItem;
	}
	public getChildren(item?: EnvironmentProfile | ComponentSelection): Array<EnvironmentProfile | ComponentSelection> {
		if (!item) { return this.store.profiles(); }
		return 'kind' in item ? componentTypes.map((type) => ({ type: type.type, name: `Select ${type.label.toLowerCase()}...` })) : [];
	}
}

function componentIcon(type: ComponentSelection['type']): string {
	return type === 'serviceScript' ? 'symbol-method' : type === 'businessObject' ? 'symbol-class' : type === 'businessService' ? 'server' : 'layout';
}

export function activate(context: vscode.ExtensionContext): void {
	const store = new OuafStore(context.workspaceState, context.secrets);
	const client = new OuafClient(store);
	const provider = new OuafTreeDataProvider(store);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('ouaf-config-manager.explorer', provider));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.addEnvironment', () => openEnvironmentPanel(context, store, provider)));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.editEnvironment', (name?: string) => openEnvironmentPanel(context, store, provider, name)));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.refresh', () => provider.refresh()));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.compare', async (component?: ComponentSelection) => {
		const picked = component?.name.startsWith('Select ') ? await pickComponent() : component ?? await pickComponent();
		if (!picked) { return; }
		const profiles = store.profiles();
		if (profiles.length < 2) { vscode.window.showWarningMessage('Add at least two OUAF environments before comparing.'); return; }
		const sourcePick = await profilePick(store, 'Source environment');
		const targetPick = await profilePick(store, 'Target environment', sourcePick?.name);
		if (sourcePick && targetPick) { await compare(client, sourcePick, targetPick, picked); }
	}));
	for (const command of ['refreshComponent', 'checkout'] as const) {
		context.subscriptions.push(vscode.commands.registerCommand(`ouaf-config-manager.${command}`, async () => {
			const component = await pickComponent();
			const profile = await pickProfile(store, command === 'checkout' ? 'Checkout from environment' : 'Refresh from environment');
			if (!component || !profile) { return; }
			try { await writeSnapshot(profile, component, await client.fetch(profile, component)); } catch (error) { showError(error); }
		}));
	}
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.checkin', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { vscode.window.showWarningMessage('Open a checked-out OUAF component before checking it in.'); return; }
		const profile = await pickProfile(store, 'Check in to environment');
		if (profile) {
			await editor.document.save();
			vscode.window.showInformationMessage(`Saved local changes for ${profile.name}. Commit the .ouaf files with VS Code Git to version them.`);
		}
	}));
}

async function pickComponent(): Promise<ComponentSelection | undefined> {
	const type = await vscode.window.showQuickPick(componentTypes, { placeHolder: 'Component type' });
	if (!type) { return undefined; }
	const name = await vscode.window.showInputBox({ prompt: `Name of ${type.label}`, placeHolder: 'Component name or code' });
	return name ? { type: type.type, name } : undefined;
}

async function pickProfile(store: OuafStore, placeHolder: string): Promise<EnvironmentProfile | undefined> { return profilePick(store, placeHolder); }

async function profilePick(store: OuafStore, placeHolder: string, excludedName?: string): Promise<EnvironmentProfile | undefined> {
	const profiles = store.profiles().filter((profile) => profile.name !== excludedName);
	const picked = await vscode.window.showQuickPick(profiles.map((profile) => ({ label: profile.name, description: `${profile.kind.toUpperCase()} - ${profile.baseUrl}`, profile })), { placeHolder });
	return picked?.profile;
}

async function compare(client: OuafClient, source: EnvironmentProfile, target: EnvironmentProfile, component: ComponentSelection): Promise<void> {
	try {
		const [sourceContent, targetContent] = await Promise.all([client.fetch(source, component), client.fetch(target, component)]);
		const left = await vscode.workspace.openTextDocument({ language: 'json', content: sourceContent });
		const right = await vscode.workspace.openTextDocument({ language: 'json', content: targetContent });
		await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${component.name}: ${source.name} <-> ${target.name}`);
	} catch (error) { showError(error); }
}

async function writeSnapshot(profile: EnvironmentProfile, component: ComponentSelection, content: string): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) { vscode.window.showErrorMessage('Open a workspace to store OUAF components.'); return; }
	const directory = vscode.Uri.joinPath(folder.uri, '.ouaf', profile.name, component.type);
	await vscode.workspace.fs.createDirectory(directory);
	const file = vscode.Uri.joinPath(directory, `${component.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
	await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
	vscode.window.showInformationMessage(`Saved ${component.name} from ${profile.name} to ${vscode.workspace.asRelativePath(file)}.`);
}

function showError(error: unknown): void { vscode.window.showErrorMessage(`OUAF operation failed: ${error instanceof Error ? error.message : String(error)}`); }

export function deactivate(): void {}

function openEnvironmentPanel(context: vscode.ExtensionContext, store: OuafStore, provider: OuafTreeDataProvider, profileName?: string): void {
		const existing = store.profiles().find((profile) => profile.name === profileName);
		const panel = vscode.window.createWebviewPanel('ouafEnvironment', existing ? 'Edit OUAF Environment' : 'Add OUAF Environment', vscode.ViewColumn.One, { enableScripts: true });
		panel.webview.html = environmentForm(panel.webview, existing, vscode.workspace.getConfiguration('ouaf-config-manager').get<string>('defaultApiPath', '/api/ouaf/config'));
		panel.webview.onDidReceiveMessage(async (message: { type: string; profile?: EnvironmentProfile; credentials?: { token?: string; apiUsername?: string; apiPassword?: string; databasePassword?: string } }) => {
			if (message.type === 'cancel') { panel.dispose(); return; }
			if ((message.type === 'testApi' || message.type === 'testDatabase') && message.profile) {
				try {
					const testClient = new OuafClient(store);
					if (message.type === 'testApi') { await testClient.testApi(message.profile, message.credentials); }
					else { await testClient.testDatabase(message.profile, message.credentials); }
					panel.webview.postMessage({ type: 'testResult', success: true, target: message.type });
				} catch (error) { panel.webview.postMessage({ type: 'testResult', success: false, target: message.type, error: error instanceof Error ? error.message : String(error) }); }
				return;
			}
			if (message.type !== 'save' || !message.profile) { return; }
			try {
				await store.saveProfile(message.profile, message.credentials);
				provider.refresh();
				vscode.window.showInformationMessage(`Saved OUAF environment ${message.profile.name}.`);
				panel.dispose();
			} catch (error) { showError(error); }
		}, undefined, context.subscriptions);
}

function environmentForm(webview: vscode.Webview, profile: EnvironmentProfile | undefined, defaultApiPath: string): string {
	const value = (input: string | undefined): string => escapeHtml(input || '');
	const database = profile?.database;
	const authType = profile?.authType || 'bearer';
	const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>OUAF Environment</title><style>
		:root{color-scheme:light dark}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:860px;margin:auto}h1{font-size:22px;font-weight:600;margin:0 0 6px}p{color:var(--vscode-descriptionForeground);margin:0 0 24px}.section{border-top:1px solid var(--vscode-panel-border);padding:20px 0}.section h2{font-size:15px;margin:0 0 14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px}.field{display:flex;flex-direction:column;gap:6px}.wide{grid-column:1/-1}label{font-size:12px;color:var(--vscode-descriptionForeground)}input,select{box-sizing:border-box;width:100%;padding:8px 9px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}input:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}.actions{display:flex;justify-content:flex-end;gap:8px;padding-top:22px}button{padding:8px 16px;border:1px solid var(--vscode-button-border);border-radius:3px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button.secondary{background:transparent;color:var(--vscode-foreground)}button.test{justify-self:start;padding:6px 12px}.status{font-size:12px;min-height:18px;color:var(--vscode-descriptionForeground)}.success{color:var(--vscode-testing-iconPassed)}.failure{color:var(--vscode-testing-iconFailed)}.hidden{display:none}@media(max-width:600px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}}
		</style></head><body><h1>${profile ? 'Edit' : 'Add'} OUAF environment</h1><p>Store connection metadata once, then use it for compare, refresh, and checkout operations.</p><form id="form">
		<div class="section"><h2>Environment</h2><div class="grid"><div class="field"><label for="name">Name</label><input id="name" required value="${value(profile?.name)}" placeholder="Development"></div><div class="field"><label for="kind">Type</label><select id="kind"><option value="dev" ${profile?.kind === 'dev' ? 'selected' : ''}>Development</option><option value="uat" ${profile?.kind === 'uat' ? 'selected' : ''}>UAT</option><option value="prod" ${profile?.kind === 'prod' ? 'selected' : ''}>Production</option></select></div></div></div>
		<div class="section"><h2>OUAF API</h2><div class="grid"><div class="field wide"><label for="baseUrl">Base URL</label><input id="baseUrl" type="url" required value="${value(profile?.baseUrl)}" placeholder="https://ouaf.example.com"></div><div class="field wide"><label for="apiPath">Configuration API path</label><input id="apiPath" required value="${value(profile?.apiPath || defaultApiPath)}" placeholder="/api/ouaf/config"></div><div class="field"><label for="authType">Authentication</label><select id="authType"><option value="none" ${authType === 'none' ? 'selected' : ''}>None</option><option value="bearer" ${authType === 'bearer' ? 'selected' : ''}>Bearer token</option><option value="basic" ${authType === 'basic' ? 'selected' : ''}>Basic authentication</option></select></div><div class="field" id="tokenField"><label for="token">Bearer token</label><input id="token" type="password" placeholder="Leave blank to keep existing"></div><div class="field hidden" id="basicUsernameField"><label for="apiUsername">API username</label><input id="apiUsername" value=""></div><div class="field hidden" id="basicPasswordField"><label for="apiPassword">API password</label><input id="apiPassword" type="password" placeholder="Leave blank to keep existing"></div><button type="button" class="test" id="testApi">Test API connection</button><div class="status wide" id="apiStatus"></div></div></div>
		<div class="section"><h2>Oracle database</h2><div class="grid"><div class="field"><label for="dbHost">Host</label><input id="dbHost" value="${value(database?.host)}" placeholder="db.example.com"></div><div class="field"><label for="dbPort">Port</label><input id="dbPort" value="${value(database?.port || '1521')}" placeholder="1521"></div><div class="field"><label for="dbService">Service name / SID</label><input id="dbService" value="${value(database?.service)}"></div><div class="field"><label for="dbUser">Database user</label><input id="dbUser" value="${value(database?.user)}"></div><div class="field"><label for="dbPassword">Database password</label><input id="dbPassword" type="password" placeholder="Leave blank to keep existing"></div><button type="button" class="test" id="testDatabase">Test database connection</button><div class="status wide" id="databaseStatus"></div></div></div>
		<div class="actions"><button type="button" class="secondary" id="cancel">Cancel</button><button type="submit">Save environment</button></div></form><script nonce="${nonce}">
		const vscode=acquireVsCodeApi();const get=(id)=>document.getElementById(id).value.trim();const authType=document.getElementById('authType');const updateAuth=()=>{const basic=authType.value==='basic';document.getElementById('tokenField').classList.toggle('hidden',basic||authType.value==='none');document.getElementById('basicUsernameField').classList.toggle('hidden',!basic);document.getElementById('basicPasswordField').classList.toggle('hidden',!basic)};authType.addEventListener('change',updateAuth);updateAuth();const credentials=()=>({token:get('token')||undefined,apiUsername:get('apiUsername')||undefined,apiPassword:get('apiPassword')||undefined,databasePassword:get('dbPassword')||undefined});const profile=()=>({name:get('name'),kind:get('kind'),baseUrl:get('baseUrl'),apiPath:get('apiPath'),authType:authType.value,...((get('dbHost'))?{database:{host:get('dbHost'),port:get('dbPort')||'1521',service:get('dbService'),user:get('dbUser')}}:{})});document.getElementById('cancel').addEventListener('click',()=>vscode.postMessage({type:'cancel'}));document.getElementById('form').addEventListener('submit',(event)=>{event.preventDefault();vscode.postMessage({type:'save',profile:profile(),credentials:credentials()})});const test=(type,id)=>{const status=document.getElementById(id);status.className='status';status.textContent='Testing...';vscode.postMessage({type,profile:profile(),credentials:credentials()})};document.getElementById('testApi').addEventListener('click',()=>test('testApi','apiStatus'));document.getElementById('testDatabase').addEventListener('click',()=>test('testDatabase','databaseStatus'));window.addEventListener('message',(event)=>{const message=event.data;if(message.type!=='testResult'){return}const status=document.getElementById(message.target==='testApi'?'apiStatus':'databaseStatus');status.className=message.success?'status success':'status failure';status.textContent=message.success?'Connection successful':'Connection failed: '+message.error});
		</script></body></html>`;
}

function escapeHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
