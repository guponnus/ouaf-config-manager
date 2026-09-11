import * as vscode from 'vscode';
import { ComponentSelection, componentTypes, Credentials, EnvironmentProfile, OuafClient, OuafStore, ProjectEnvironmentConfiguration, ServiceScript, ServiceScriptDataArea } from './ouaf';

interface EnvironmentMessage {
	type: 'cancel' | 'save' | 'testApi' | 'testDatabase';
	profile?: EnvironmentProfile;
	credentials?: Credentials;
}

interface SchemaEditorMessage {
	type: 'saveSchema' | 'copyXPath';
	content: string;
	xpath?: string;
}

interface ComponentTypeItem extends ComponentSelection {
	isComponentType: true;
	environmentName: string;
	label: string;
}

interface ServiceScriptItem extends ServiceScript {
	environmentName: string;
	isLocal: boolean;
	isStepsDifferent: boolean;
	isSchemaDifferent: boolean;
}

type ScriptSection = 'steps' | 'dataArea' | 'schema';

interface ServiceScriptSectionItem {
	type: 'serviceScriptSection';
	section: ScriptSection;
	label: string;
	script: ServiceScriptItem;
}

interface ServiceScriptDataAreaItem {
	type: 'serviceScriptDataArea';
	dataArea: ServiceScriptDataArea;
	script: ServiceScriptItem;
}

type ExplorerItem = EnvironmentProfile | ComponentTypeItem | ServiceScriptItem | ServiceScriptSectionItem | ServiceScriptDataAreaItem;
type ServiceScriptCheckoutItem = ServiceScriptItem | ServiceScriptSectionItem;

class CompareDocumentProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private nextId = 0;

	public provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	public document(content: string, language: string): vscode.Uri {
		const uri = vscode.Uri.parse(`ouaf-compare:/${this.nextId++}.${language}`);
		this.contents.set(uri.toString(), content);
		return uri;
	}
}

const schemaEditorFiles = new WeakMap<vscode.WebviewPanel, vscode.Uri>();

class OuafTreeDataProvider implements vscode.TreeDataProvider<ExplorerItem> {
	private readonly changed = new vscode.EventEmitter<void>();
	private readonly serviceScripts = new Map<string, ServiceScript[]>();
	private readonly loadingServiceScripts = new Set<string>();
	private readonly serviceScriptFilters = new Map<string, string>();
	private readonly localOnlyFilters = new Set<string>();
	public readonly onDidChangeTreeData = this.changed.event;
	public constructor(private readonly store: OuafStore, private readonly client: OuafClient, private readonly state: vscode.Memento) {
		const filters = state.get<Record<string, string>>('ouaf.explorer.filters', {});
		for (const [environmentName, filter] of Object.entries(filters)) { this.serviceScriptFilters.set(environmentName, filter); }
		for (const environmentName of state.get<string[]>('ouaf.explorer.localOnly', [])) { this.localOnlyFilters.add(environmentName); }
	}

	public isConnected(environmentName: string): boolean {
		return this.store.connectedEnvironmentNames().includes(environmentName);
	}

	public async toggleConnection(environmentName: string): Promise<void> {
		await this.store.setEnvironmentConnected(environmentName, !this.isConnected(environmentName));
		this.changed.fire();
	}

	public refreshDisplay(environmentName?: string): void {
		if (environmentName) { this.serviceScripts.delete(environmentName); }
		this.changed.fire();
	}

	public async refresh(client: OuafClient): Promise<void> {
		for (const profile of this.store.profiles()) {
			this.serviceScripts.set(profile.name, await client.serviceScripts(profile));
		}
		this.changed.fire();
	}

	public filterServiceScripts(environmentName: string, filter: string): void {
		const value = filter.trim();
		if (value) {
			this.serviceScriptFilters.set(environmentName, value);
		} else {
			this.serviceScriptFilters.delete(environmentName);
		}
		void this.state.update('ouaf.explorer.filters', Object.fromEntries(this.serviceScriptFilters));
		this.changed.fire();
	}

	public clearServiceScriptFilter(environmentName: string): void {
		this.serviceScriptFilters.delete(environmentName);
		this.localOnlyFilters.delete(environmentName);
		void Promise.all([
			this.state.update('ouaf.explorer.filters', Object.fromEntries(this.serviceScriptFilters)),
			this.state.update('ouaf.explorer.localOnly', [...this.localOnlyFilters]),
		]);
		this.changed.fire();
	}

	public toggleLocalOnly(environmentName: string): void {
		if (this.localOnlyFilters.has(environmentName)) {
			this.localOnlyFilters.delete(environmentName);
		} else {
			this.localOnlyFilters.add(environmentName);
		}
		void this.state.update('ouaf.explorer.localOnly', [...this.localOnlyFilters]);
		this.changed.fire();
	}

	public async refreshServiceScripts(environmentName: string): Promise<void> {
		const profile = this.store.profiles().find((item) => item.name === environmentName);
		if (!profile) { return; }
		this.serviceScripts.delete(environmentName);
		await this.loadServiceScripts(environmentName);
		this.changed.fire();
	}

	public serviceScriptFilter(environmentName: string): string {
		return this.serviceScriptFilters.get(environmentName) ?? '';
	}

	public allServiceScripts(environmentName: string): ServiceScript[] {
		return this.serviceScripts.get(environmentName) ?? [];
	}

	public async filteredServiceScripts(environmentName: string): Promise<ServiceScriptItem[]> {
		const profile = this.store.profiles().find((item) => item.name === environmentName);
		if (!profile) { return []; }
		const scripts = await this.loadServiceScripts(environmentName, this.serviceScriptFilters.get(environmentName));
		return Promise.all(scripts.map(async (script) => ({
			...script,
			environmentName,
			isLocal: await isServiceScriptSaved(profile, script),
			isStepsDifferent: false,
			isSchemaDifferent: false,
		})));
	}

	public async allLocalServiceScripts(environmentName: string): Promise<ServiceScriptItem[]> {
		const profile = this.store.profiles().find((item) => item.name === environmentName);
		if (!profile) { return []; }
		const scripts = await this.loadServiceScripts(environmentName);
		return (await Promise.all(scripts.map(async (script) => await isServiceScriptSaved(profile, script) ? {
			...script,
			environmentName,
			isLocal: true,
			isStepsDifferent: false,
			isSchemaDifferent: false,
		} : undefined))).filter((script): script is ServiceScriptItem => script !== undefined);
	}

	public getTreeItem(item: ExplorerItem): vscode.TreeItem {
		if ('kind' in item) {
			return this.environmentTreeItem(item);
		}
		if (item.type === 'serviceScriptSection') {
			return this.serviceScriptSectionTreeItem(item);
		}
		if (item.type === 'serviceScriptDataArea') {
			const treeItem = new vscode.TreeItem(`${item.dataArea.schemaTypeFlag} - ${item.dataArea.daName}`);
			treeItem.id = `${item.script.environmentName}:${item.script.name}:dataArea:${item.dataArea.daName}`;
			treeItem.contextValue = 'serviceScript.dataArea';
			treeItem.command = { command: 'ouaf-config-manager.openServiceScriptDataArea', title: 'Open Service Script Data Area', arguments: [item] };
			return treeItem;
		}
		return this.componentTreeItem(item);
	}

	public async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
		if (!item) { return this.store.profiles(); }
		if ('kind' in item) {
			if (!this.isConnected(item.name)) { return []; }
			return componentTypes.map((type) => ({
				type: type.type,
				name: `Select ${type.label.toLowerCase()}...`,
				label: type.label,
				isComponentType: true,
				environmentName: item.name,
			}));
		}
		if (item.type === 'serviceScriptSection') {
			if (item.section !== 'dataArea') { return []; }
			const profile = this.store.profiles().find((environment) => environment.name === item.script.environmentName);
			if (!profile) { return []; }
			try {
				return (await this.client.serviceScriptDataAreas(profile, item.script.name)).map((dataArea) => ({ type: 'serviceScriptDataArea', dataArea, script: item.script }));
			} catch (error) {
				showError(error);
				return [];
			}
		}
		if (item.type === 'serviceScriptDataArea') { return []; }
		if (isComponentTypeItem(item) && item.type === 'serviceScript') {
			const filter = this.serviceScriptFilters.get(item.environmentName);
			const scripts = await this.loadServiceScripts(item.environmentName, filter);
			const profile = this.store.profiles().find((environment) => environment.name === item.environmentName);
			if (!profile) { return []; }
			const localScripts = await Promise.all(scripts.map(async (script) => ({
				...script,
				environmentName: item.environmentName,
				isLocal: await isServiceScriptSaved(profile, script),
				...(await compareLocalScriptContent(this.client, profile, script)),
			})));
			return this.localOnlyFilters.has(item.environmentName)
				? localScripts.filter((script) => script.isLocal)
				: localScripts;
		}
		if (isServiceScriptItem(item)) {
			return serviceScriptSections(item);
		}
		return [];
	}

	private async loadServiceScripts(environmentName: string, filter?: string): Promise<ServiceScript[]> {
		if (!filter && this.serviceScripts.has(environmentName)) { return this.allServiceScripts(environmentName); }
		if (this.loadingServiceScripts.has(environmentName)) { return []; }
		const profile = this.store.profiles().find((item) => item.name === environmentName);
		if (!profile) { return []; }
		this.loadingServiceScripts.add(environmentName);
		try {
			const scripts = await this.client.serviceScripts(profile, filter);
			if (!filter) { this.serviceScripts.set(environmentName, scripts); }
			return scripts;
		} catch (error) {
			showError(error);
			return [];
		} finally {
			this.loadingServiceScripts.delete(environmentName);
		}
	}

	private environmentTreeItem(profile: EnvironmentProfile): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(`${profile.name} (${profile.kind.toUpperCase()})`, vscode.TreeItemCollapsibleState.Expanded);
		treeItem.description = profile.baseUrl;
		treeItem.iconPath = new vscode.ThemeIcon(this.isConnected(profile.name) ? environmentIcon(profile.kind) : 'circle-slash');
		treeItem.contextValue = this.isConnected(profile.name) ? 'environmentConnected' : 'environmentDisconnected';
		treeItem.id = profile.name;
		treeItem.command = {
			command: 'ouaf-config-manager.editEnvironment',
			title: 'Edit OUAF Environment',
			arguments: [profile],
		};
		return treeItem;
	}

	private componentTreeItem(component: ComponentTypeItem | ServiceScriptItem): vscode.TreeItem {
		const isTypeItem = isComponentTypeItem(component);
		const treeItem = new vscode.TreeItem(
			isTypeItem ? component.label : component.name,
			(isTypeItem && component.type === 'serviceScript') || (!isTypeItem && component.type === 'serviceScript')
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		treeItem.id = isTypeItem ? `${component.environmentName}:${component.type}:type` : `${component.environmentName}:${component.type}:${component.name}`;
		if ('description' in component) {
			treeItem.description = component.description;
		}
		if (!isTypeItem && component.isLocal) {
			treeItem.iconPath = component.isStepsDifferent || component.isSchemaDifferent
				? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
				: new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
		} else {
			treeItem.iconPath = new vscode.ThemeIcon(componentIcon(component.type));
		}
		treeItem.contextValue = isTypeItem ? `${component.type}Type` : component.type;
		if (isTypeItem && component.type === 'serviceScript') {
			treeItem.contextValue = 'serviceScriptType';
		} else if (isTypeItem && component.type !== 'serviceScript') {
			treeItem.command = { command: 'ouaf-config-manager.compare', title: 'Compare OUAF Component', arguments: [component] };
		}
		return treeItem;
	}

	private serviceScriptSectionTreeItem(section: ServiceScriptSectionItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(section.label, section.section === 'dataArea' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		treeItem.id = `${section.script.environmentName}:${section.script.name}:${section.section}`;
		treeItem.contextValue = `serviceScript.${section.section}`;
		const isDifferent = section.section === 'steps' ? section.script.isStepsDifferent : section.section === 'schema' && section.script.isSchemaDifferent;
		treeItem.iconPath = section.section === 'schema'
			? new vscode.ThemeIcon('file-code')
			: isDifferent
			? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
			: new vscode.ThemeIcon(section.section === 'steps' ? 'play' : 'symbol-field');
		if (isDifferent) {
			treeItem.description = 'Different from server';
		}
		if (section.section === 'steps') {
			treeItem.command = {
				command: 'ouaf-config-manager.openServiceScript',
				title: 'Open Service Script Steps',
				arguments: [section],
			};
		} else if (section.section === 'schema') {
			treeItem.command = {
				command: 'ouaf-config-manager.openServiceScriptSchema',
				title: 'Open Service Script Schema',
				arguments: [section],
			};
		}
		return treeItem;
	}
}

function isComponentTypeItem(item: ComponentTypeItem | ServiceScriptItem): item is ComponentTypeItem {
	return 'isComponentType' in item;
}

function isServiceScriptItem(item: ExplorerItem): item is ServiceScriptItem {
	return 'type' in item && item.type === 'serviceScript' && 'environmentName' in item;
}

function isEnvironmentProfile(item: EnvironmentProfile | ServiceScriptItem | ServiceScriptSectionItem | ServiceScriptItem[] | undefined): item is EnvironmentProfile {
	return !!item && !Array.isArray(item) && 'kind' in item && 'baseUrl' in item;
}

function serviceScriptSections(script: ServiceScriptItem): ServiceScriptSectionItem[] {
	return [
		{ type: 'serviceScriptSection', section: 'steps', label: 'Steps', script },
		{ type: 'serviceScriptSection', section: 'dataArea', label: 'Data Area', script },
		{ type: 'serviceScriptSection', section: 'schema', label: 'Schema', script },
	];
}

function environmentIcon(kind: EnvironmentProfile['kind']): string {
	return kind === 'prod' ? 'shield' : kind === 'uat' ? 'testing-passed-icon' : 'code-oss';
}

function componentIcon(type: ComponentSelection['type']): string {
	return type === 'serviceScript' ? 'symbol-method' : type === 'businessObject' ? 'symbol-class' : type === 'businessService' ? 'server' : 'layout';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const store = new OuafStore(context.workspaceState, context.secrets);
	try {
		await loadProjectConfiguration(store);
	} catch (error) {
		showError(new Error(`Could not load the project configuration. ${error instanceof Error ? error.message : String(error)}`));
	}
	const client = new OuafClient(store);
	const compareDocuments = new CompareDocumentProvider();
	const provider = new OuafTreeDataProvider(store, client, context.workspaceState);
	const treeView = vscode.window.createTreeView('ouaf-config-manager.explorer', { treeDataProvider: provider, canSelectMany: true });
	const dataAreaPanels = new Map<string, vscode.WebviewPanel>();
	context.subscriptions.push(treeView);
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ouaf-compare', compareDocuments));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.addEnvironment', () => openEnvironmentPanel(context, store, client, provider)));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.editEnvironment', (argument?: string | EnvironmentProfile | vscode.TreeItem) => {
		const profileName = getEnvironmentName(argument);
		openEnvironmentPanel(context, store, client, provider, profileName);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.removeEnvironment', async (argument?: string | EnvironmentProfile | vscode.TreeItem) => {
		const profileName = getEnvironmentName(argument);
		if (!profileName) { return; }
		const confirmation = await vscode.window.showWarningMessage(`Remove OUAF environment ${profileName}?`, { modal: true }, 'Remove');
		if (confirmation !== 'Remove') { return; }
		await store.removeProfile(profileName);
		await saveProjectConfiguration(store);
		provider.refreshDisplay(profileName);
		vscode.window.showInformationMessage(`Removed OUAF environment ${profileName}.`);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.relocateLocalDirectory', async (argument?: string | EnvironmentProfile | vscode.TreeItem) => {
		const profileName = getEnvironmentName(argument);
		const profile = profileName ? store.profiles().find((item) => item.name === profileName) : undefined;
		if (!profile) { return; }
		const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use Checkout Directory' });
		if (!selected?.[0]) { return; }
		await store.saveProfile({ ...profile, localDirectory: selected[0].fsPath });
		await saveProjectConfiguration(store);
		vscode.window.showInformationMessage(`Checkout directory for ${profile.name} updated.`);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.refresh', async () => {
		try { await provider.refresh(client); } catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.connectEnvironment', async (profile?: EnvironmentProfile) => {
		if (profile && !provider.isConnected(profile.name)) {
			await provider.toggleConnection(profile.name);
			await saveProjectConfiguration(store);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.disconnectEnvironment', async (profile?: EnvironmentProfile) => {
		if (profile && provider.isConnected(profile.name)) {
			await provider.toggleConnection(profile.name);
			await saveProjectConfiguration(store);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.collapseAll', () => {
		void vscode.commands.executeCommand('workbench.actions.treeView.ouaf-config-manager.explorer.collapseAll');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.compare', async (component?: ComponentSelection) => {
		const picked = component?.name.startsWith('Select ') ? await pickComponent() : component ?? await pickComponent();
		if (!picked) { return; }
		const profiles = store.profiles();
		if (profiles.length < 2) { vscode.window.showWarningMessage('Add at least two OUAF environments before comparing.'); return; }
		const sourcePick = await profilePick(store, 'Source environment');
		const targetPick = await profilePick(store, 'Target environment', sourcePick?.name);
		if (sourcePick && targetPick) { await compare(client, compareDocuments, sourcePick, targetPick, picked); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.openServiceScript', async (item?: ServiceScriptItem | ServiceScriptSectionItem) => {
		const script = item && 'section' in item ? item.script : item;
		if (!script) { return; }
		const profile = store.profiles().find((environment) => environment.name === script.environmentName);
		if (!profile) { return; }
		try {
			const localFile = serviceScriptFile(profile, script);
			const localContent = await readLocalServiceScript(localFile);
			const isStepsSection = item && 'section' in item && item.section === 'steps';
			const document = isStepsSection && localContent !== undefined
				? await vscode.workspace.openTextDocument(localFile)
				: localContent === undefined || isStepsSection
				? await vscode.workspace.openTextDocument({ language: 'groovy', content: await client.serviceScriptSteps(profile, script.name) })
				: await vscode.workspace.openTextDocument(localFile);
			if (localContent !== undefined) { await vscode.languages.setTextDocumentLanguage(document, 'groovy'); }
			await vscode.window.showTextDocument(document, { preview: false });
		} catch (error) {
			showError(error);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.refreshServiceScript', async (section?: ServiceScriptSectionItem) => {
		const script = section?.script;
		if (!script || section.section !== 'steps') { return; }
		const profile = store.profiles().find((environment) => environment.name === script.environmentName);
		if (!profile) { return; }
		try {
			await writeSnapshot(profile, script, await client.serviceScriptSteps(profile, script.name));
			provider.refreshDisplay();
		} catch (error) {
			showError(error);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.refreshServiceScriptDataArea', async (item?: ServiceScriptSectionItem | ServiceScriptDataAreaItem) => {
		const script = item && 'section' in item ? item.section === 'dataArea' ? item.script : undefined : item?.script;
		if (!script) { return; }
		try {
			provider.refreshDisplay(script.environmentName);
			vscode.window.showInformationMessage(`Refreshed data areas for ${script.name}.`);
		} catch (error) {
			showError(error);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.openServiceScriptSchema', async (section?: ServiceScriptSectionItem) => {
		const script = section?.script;
		if (!script || section.section !== 'schema') { return; }
		const profile = store.profiles().find((environment) => environment.name === script.environmentName);
		if (!profile) { return; }
		try {
			const file = serviceScriptSchemaFile(profile, script);
			const localContent = await readLocalServiceScript(file);
			const schema = localContent === undefined
				? await client.serviceScriptSchema(profile, script.name)
				: Buffer.from(localContent).toString('utf8');
			openSchemaEditor(context, script.name, file, schema);
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.openServiceScriptDataArea', async (item?: ServiceScriptDataAreaItem) => {
		if (!item || item.type !== 'serviceScriptDataArea') { return; }
		const profile = store.profiles().find((environment) => environment.name === item.script.environmentName);
		if (!profile) { return; }
		try {
			const content = await client.serviceScriptDataArea(profile, item.script.name, item.dataArea.schemaName, item.dataArea.daName);
			const panelKey = `${item.script.environmentName}:${item.script.name}`;
			const existingPanel = dataAreaPanels.get(panelKey);
			const panel = openSchemaEditor(context, `${item.script.name} ${item.dataArea.daName}`, serviceScriptSchemaFile(profile, item.script), content, true, false, existingPanel);
			dataAreaPanels.set(panelKey, panel);
			panel.onDidDispose(() => {
				if (dataAreaPanels.get(panelKey) === panel) { dataAreaPanels.delete(panelKey); }
			}, undefined, context.subscriptions);
			panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One, true);
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.compareServiceScript', async (item?: ServiceScriptSectionItem | ServiceScriptItem) => {
		const script = getScriptFromSteps(item);
		if (!script) { return; }
		const source = store.profiles().find((profile) => profile.name === script.environmentName);
		if (!source) { return; }
		const target = await pickServiceScriptCompareTarget(store, source);
		if (target) { await compareServiceScript(client, compareDocuments, source, target, script); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.replaceServiceScriptSteps', async (item?: ServiceScriptSectionItem | ServiceScriptItem) => {
		const script = getScriptFromSteps(item);
		if (!script) { return; }
		const source = store.profiles().find((profile) => profile.name === script.environmentName);
		if (!source) { return; }
		const target = await profilePick(store, 'Replace Steps from environment', source.name);
		if (!target) { return; }
		try {
			await writeSnapshot(source, script, await client.serviceScriptSteps(target, script.name));
			provider.refreshDisplay(source.name);
		} catch (error) {
			showError(error);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.compareServiceScriptSchema', async (item?: ServiceScriptSectionItem | ServiceScriptItem) => {
		const script = item && 'section' in item ? item.section === 'schema' ? item.script : undefined : item;
		if (!script) { return; }
		const source = store.profiles().find((profile) => profile.name === script.environmentName);
		if (!source) { return; }
		const target = await pickServiceScriptCompareTarget(store, source);
		if (target) { await compareServiceScriptSchema(client, compareDocuments, source, target, script); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.filterServiceScripts', async (item?: ComponentTypeItem) => {
		if (!item) { return; }
		const filter = await vscode.window.showInputBox({
			prompt: 'Filter service scripts by code or description',
			value: provider.serviceScriptFilter(item.environmentName),
		});
		if (filter !== undefined) { provider.filterServiceScripts(item.environmentName, filter); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.clearServiceScriptFilter', (item?: ComponentTypeItem) => {
		if (item) { provider.clearServiceScriptFilter(item.environmentName); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.toggleLocalServiceScripts', (item?: ComponentTypeItem) => {
		if (item) { provider.toggleLocalOnly(item.environmentName); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.refreshServiceScripts', async (item?: ComponentTypeItem) => {
		if (!item) { return; }
		try {
			await provider.refreshServiceScripts(item.environmentName);
		} catch (error) {
			showError(error);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.checkoutServiceScript', async (item?: ComponentTypeItem | ServiceScriptItem | ServiceScriptSectionItem | ServiceScriptItem[]) => {
		if (!item || (!Array.isArray(item) && 'isComponentType' in item)) {
			const componentType = item && !Array.isArray(item) && 'isComponentType' in item ? item : undefined;
			if (componentType?.type === 'serviceScript') {
				await checkoutSelectedScripts(client, provider, store, await provider.filteredServiceScripts(componentType.environmentName));
			}
			return;
		}
		const selected = Array.isArray(item) ? item : item ? [item] : [];
		const scripts = selected.filter((selectedItem): selectedItem is ServiceScriptCheckoutItem => !('section' in selectedItem) || selectedItem.section === 'steps' || selectedItem.section === 'schema');
		if (!scripts.length) { return; }
		const firstScript = 'section' in scripts[0] ? scripts[0].script : scripts[0];
		const profile = store.profiles().find((environment) => environment.name === firstScript.environmentName);
		if (!profile || scripts.some((item) => ('section' in item ? item.script : item).environmentName !== profile.name)) { return; }
		try {
			await checkoutSelectedScripts(client, provider, store, scripts);
		} catch (error) {
			showError(error);
		}
	}));
	for (const command of ['refreshComponent', 'checkout'] as const) {
		context.subscriptions.push(vscode.commands.registerCommand(`ouaf-config-manager.${command}`, async () => {
			const component = await pickComponent();
			const profile = await pickProfile(store, command === 'checkout' ? 'Checkout from environment' : 'Refresh from environment');
			if (!component || !profile) { return; }
			try {
				if (command === 'checkout' && component.type === 'serviceScript') {
					await checkoutServiceScript(client, profile, component);
					provider.refreshDisplay();
				} else {
					await writeSnapshot(profile, component, await client.fetch(profile, component));
				}
			} catch (error) { showError(error); }
		}));
	}
	context.subscriptions.push(vscode.commands.registerCommand('ouaf-config-manager.checkin', async (item?: EnvironmentProfile | ServiceScriptItem | ServiceScriptSectionItem | ServiceScriptItem[]) => {
		try {
			if (isEnvironmentProfile(item)) {
					const scripts = await provider.allLocalServiceScripts(item.name);
					await checkinServiceScripts(item, scripts);
			} else {
				const selected = Array.isArray(item) ? item : item ? [item] : treeView.selection;
				const scripts = selected.map((selectedItem) => 'section' in selectedItem ? selectedItem.script : selectedItem).filter(isServiceScriptItem);
				const profile = scripts.length ? store.profiles().find((environment) => environment.name === scripts[0].environmentName) : await pickProfile(store, 'Check in to environment');
				if (profile && scripts.length) {
					await checkinServiceScripts(profile, scripts);
					provider.refreshDisplay(profile.name);
				}
			}
			provider.refreshDisplay();
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.uri.scheme !== 'file' || !document.uri.path.toLowerCase().endsWith('.ouaf')) { return; }
		provider.refreshDisplay();
	}));
}

async function checkoutSelectedScripts(client: OuafClient, provider: OuafTreeDataProvider, store: OuafStore, scripts: ServiceScriptCheckoutItem[]): Promise<void> {
	const uniqueScripts = [...new Map(scripts.map((item) => {
		const script = 'section' in item ? item.script : item;
		const scope: 'all' | 'steps' | 'schema' = 'section' in item && item.section !== 'dataArea' ? item.section : 'all';
		return [`${script.name}:${scope}`, { script, scope }];
	})).values()];
	if (!uniqueScripts.length) { vscode.window.showWarningMessage('No service scripts selected.'); return; }
	const profile = store.profiles().find((item) => item.name === uniqueScripts[0].script.environmentName);
	if (!profile || uniqueScripts.some(({ script }) => script.environmentName !== profile.name)) { return; }
	await Promise.all(uniqueScripts.map(({ script, scope }) => checkoutServiceScript(client, profile, script, scope)));
	provider.refreshDisplay(profile.name);
	vscode.window.showInformationMessage(`Checked out ${uniqueScripts.length} service script part${uniqueScripts.length === 1 ? '' : 's'}.`);
}

function openSchemaEditor(context: vscode.ExtensionContext, scriptCode: string, file: vscode.Uri, schema: string, showView = true, showEditor = true, existingPanel?: vscode.WebviewPanel): vscode.WebviewPanel {
	const panel = existingPanel ?? vscode.window.createWebviewPanel(
		'ouafSchemaEditor',
		`${scriptCode} Schema`,
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	schemaEditorFiles.set(panel, file);
	panel.title = `${scriptCode} Schema`;
	panel.webview.html = schemaEditorHtml(panel.webview, scriptCode, formatXml(schema), showView, showEditor);
	if (!existingPanel) { panel.webview.onDidReceiveMessage(async (message: SchemaEditorMessage) => {
		if (message.type === 'copyXPath' && message.xpath) {
			await vscode.env.clipboard.writeText(message.xpath);
			return;
		}
		if (message.type !== 'saveSchema') { return; }
		try {
			const currentFile = schemaEditorFiles.get(panel);
			if (!currentFile) { return; }
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(currentFile, '..'));
			await vscode.workspace.fs.writeFile(currentFile, Buffer.from(formatXml(message.content), 'utf8'));
		} catch (error) {
			showError(error);
		}
	}, undefined, context.subscriptions); }
	return panel;
}

function schemaEditorHtml(webview: vscode.Webview, scriptCode: string, schema: string, showView: boolean, showEditor: boolean): string {
	const nonce = getNonce();
	const escapedSchema = JSON.stringify(schema).replace(/</g, '\\u003c');
	const tabs = showView && showEditor ? '<button class="tab active" data-tab="view">View</button><button class="tab" data-tab="editor">Edit</button>' : showView ? '<button class="tab active" data-tab="view">View</button>' : '<button class="tab active" data-tab="editor">Edit</button>';
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(scriptCode)} Schema</title>
<style>
:root { color-scheme: light dark; }
body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.toolbar { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
label { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
input { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); font: inherit; padding: 5px 7px; }
#tree { flex: 1; overflow: auto; padding: 8px 12px; font-family: var(--vscode-editor-font-family); }
.node { cursor: pointer; padding: 3px 6px; white-space: pre; }
.node:hover, .node.selected { background: var(--vscode-list-hoverBackground); }
.children { margin-left: 18px; }
.editor-wrap { position: relative; flex: 1; min-height: 0; overflow: hidden; }
#highlight, #editor { box-sizing: border-box; margin: 0; border: 0; white-space: pre; tab-size: 2; }
#highlight { position: absolute; inset: 0; pointer-events: none; overflow: auto; }
#editor { position: absolute; inset: 0; resize: none; background: transparent; color: transparent; caret-color: var(--vscode-editor-foreground); outline: none; }
.xml-tag { color: var(--vscode-symbolIcon-classForeground); }
.xml-attribute { color: var(--vscode-symbolIcon-propertyForeground); }
.xml-string { color: var(--vscode-debugTokenExpression-string); }
.tabs { display: flex; order: 3; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-tab-inactiveBackground); }
.tab { border: 0; border-right: 1px solid var(--vscode-panel-border); padding: 8px 14px; color: var(--vscode-tab-inactiveForeground); background: transparent; cursor: pointer; }
.tab.active { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-activeBackground); border-top: 2px solid var(--vscode-focusBorder); }
.content { min-height: 0; flex: 1; display: flex; flex-direction: column; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 12px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div class="toolbar"><label for="xpath">Selected element XPath</label><input id="xpath" readonly placeholder="Select an XML element in View"></div>
<div class="content"><div id="tree"${showView ? '' : ' hidden'}></div><div class="editor-wrap"${showView ? ' hidden' : ''}><pre id="highlight" aria-hidden="true"></pre><textarea id="editor" spellcheck="false"></textarea></div></div>
<div class="tabs">${tabs}</div>
<script nonce="${nonce}">
let schemaText = ${escapedSchema};
const vscode = acquireVsCodeApi();
const tree = document.getElementById('tree');
const xpath = document.getElementById('xpath');
const editorWrap = document.querySelector('.editor-wrap');
const editor = document.getElementById('editor');
const highlight = document.getElementById('highlight');
editor.value = schemaText;

function escapeMarkup(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function highlightXml(value) {
	return escapeMarkup(value).replace(/(&lt;\\/?[\\w:.-]+)(.*?)(\\/?&gt;)/g, (match, name, attributes, end) => {
		const styledAttributes = attributes.replace(/([\\w:.-]+)(=)(&quot;.*?&quot;)/g, '<span class="xml-attribute">$1</span>$2<span class="xml-string">$3</span>');
		return '<span class="xml-tag">' + name + '</span>' + styledAttributes + '<span class="xml-tag">' + end + '</span>';
	});
}
function refreshHighlight() { highlight.innerHTML = highlightXml(editor.value) + '\\n'; }

function nodePath(node) {
	const parts = [];
	while (node && node.nodeType === Node.ELEMENT_NODE) {
		const suffix = node.getAttribute('type') === 'list' ? '[1]' : '';
		parts.unshift(node.tagName + suffix);
		node = node.parentElement;
	}
	parts.shift();
	return parts.join('/');
}

function renderTree() {
	tree.replaceChildren();
	try {
		schemaText = editor.value;
		const xmlDocument = new DOMParser().parseFromString(schemaText, 'application/xml');
		const error = xmlDocument.querySelector('parsererror');
		if (error) { tree.textContent = 'Unable to parse XML: ' + error.textContent; return; }
		function renderElement(element, parent) {
			const children = Array.from(element.children);
			const row = window.document.createElement('div');
			row.className = 'node';
			const attributes = Array.from(element.attributes).map((attribute) => ' ' + attribute.name + '=\"' + attribute.value + '\"').join('');
			row.innerHTML = highlightXml('<' + element.tagName + attributes + (children.length ? '>' : '/>'));
			const selectElement = () => {
				window.document.querySelectorAll('.selected').forEach((item) => item.classList.remove('selected'));
				row.classList.add('selected');
				const selectedPath = nodePath(element);
				xpath.value = selectedPath;
				xpath.focus();
				xpath.select();
				vscode.postMessage({ type: 'copyXPath', xpath: selectedPath });
			};
			row.addEventListener('click', selectElement);
			parent.appendChild(row);
			if (children.length) {
				const group = window.document.createElement('div');
				group.className = 'children';
				parent.appendChild(group);
				children.forEach((child) => renderElement(child, group));
			}
			if (children.length) {
				const endRow = window.document.createElement('div');
				endRow.className = 'node end-element';
				endRow.innerHTML = highlightXml('</' + element.tagName + '>');
				endRow.addEventListener('click', selectElement);
				parent.appendChild(endRow);
			}
		}
		if (xmlDocument.documentElement) { renderElement(xmlDocument.documentElement, tree); }
	} catch (error) { tree.textContent = String(error); }
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
	const isEditor = tab.dataset.tab === 'editor';
	document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
	tree.hidden = isEditor;
	editorWrap.hidden = !isEditor;
	if (isEditor) { editor.focus(); refreshHighlight(); }
	else { renderTree(); }
}));
editor.addEventListener('input', refreshHighlight);
editor.addEventListener('scroll', () => { highlight.scrollTop = editor.scrollTop; highlight.scrollLeft = editor.scrollLeft; });
editor.addEventListener('keydown', (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
		event.preventDefault();
		vscode.postMessage({ type: 'saveSchema', content: editor.value });
	}
});
refreshHighlight();
if (${showView}) { renderTree(); }
</script>
</body>
</html>`;
}

function getNonce(): string {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let index = 0; index < 32; index++) { result += characters.charAt(Math.floor(Math.random() * characters.length)); }
	return result;
}

function getEnvironmentName(argument?: string | EnvironmentProfile | vscode.TreeItem): string | undefined {
	if (typeof argument === 'string') { return argument; }
	if (argument && 'name' in argument && typeof argument.name === 'string') { return argument.name; }
	if (argument && 'id' in argument && typeof argument.id === 'string') { return argument.id; }
	return undefined;
}

function getScriptFromSteps(item?: ServiceScriptSectionItem | ServiceScriptItem): ServiceScriptItem | undefined {
	if (!item) { return undefined; }
	if ('section' in item) { return item.section === 'steps' ? item.script : undefined; }
	return item;
}

async function isServiceScriptSaved(profile: EnvironmentProfile, script: ServiceScript): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(serviceScriptFile(profile, script));
		return true;
	} catch {
		return false;
	}
}

async function compareLocalScriptContent(client: OuafClient, profile: EnvironmentProfile, script: ServiceScript): Promise<{ isStepsDifferent: boolean; isSchemaDifferent: boolean }> {
	const stepsFile = serviceScriptFile(profile, script);
	const schemaFile = serviceScriptSchemaFile(profile, script);
	const openStepsDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === stepsFile.toString());
	const [localSteps, localSchema] = await Promise.all([openStepsDocument?.getText() ?? readLocalServiceScript(stepsFile), readLocalServiceScript(schemaFile)]);
	const [serverSteps, serverSchema] = await Promise.all([
		localSteps === undefined ? Promise.resolve(undefined) : client.serviceScriptSteps(profile, script.name).catch(() => undefined),
		localSchema === undefined ? Promise.resolve(undefined) : client.serviceScriptSchema(profile, script.name).catch(() => undefined),
	]);
	return {
		isStepsDifferent: localSteps !== undefined && serverSteps !== undefined && normalizeContent(localSteps) !== normalizeContent(serverSteps),
		isSchemaDifferent: localSchema !== undefined && serverSchema !== undefined && normalizeSchemaContent(localSchema) !== normalizeSchemaContent(serverSchema),
	};
}

function normalizeContent(content: Uint8Array | string): string {
	const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
	return text.replace(/\r\n/g, '\n').trim();
}

function normalizeSchemaContent(content: Uint8Array | string): string {
	const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
	return formatXml(text).replace(/\r\n/g, '\n').trim();
}

function serviceScriptFile(profile: EnvironmentProfile, script: ComponentSelection): vscode.Uri {
	const directory = profile.localDirectory ? vscode.Uri.file(profile.localDirectory) : getWorkspaceScriptDirectory(profile, script);
	return vscode.Uri.joinPath(directory, `${serviceScriptFileName(script.name)}.ouaf`);
}

function serviceScriptSchemaFile(profile: EnvironmentProfile, script: ComponentSelection): vscode.Uri {
	return vscode.Uri.joinPath(serviceScriptSchemaDirectory(profile, script), `${serviceScriptFileName(script.name)}.xml`);
}

function serviceScriptFileName(scriptName: string): string {
	return scriptName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+$/, '');
}

function serviceScriptSchemaDirectory(profile: EnvironmentProfile, script: ComponentSelection): vscode.Uri {
	return profile.localDirectory ? vscode.Uri.file(profile.localDirectory) : getWorkspaceScriptDirectory(profile, script);
}

async function writeServiceScriptSchema(profile: EnvironmentProfile, script: ComponentSelection, content: string): Promise<void> {
	const file = serviceScriptSchemaFile(profile, script);
	await vscode.workspace.fs.createDirectory(serviceScriptSchemaDirectory(profile, script));
	await vscode.workspace.fs.writeFile(file, Buffer.from(formatXml(content), 'utf8'));
}

async function checkoutServiceScript(client: OuafClient, profile: EnvironmentProfile, script: ComponentSelection, scope: 'all' | 'steps' | 'schema' = 'all'): Promise<void> {
	if (scope === 'steps') {
		const content = await client.serviceScriptSteps(profile, script.name);
		await writeSnapshot(profile, script, content);
		await replaceOpenStepsDocument(profile, script, content);
		return;
	}
	if (scope === 'schema') {
		await writeServiceScriptSchema(profile, script, await client.serviceScriptSchema(profile, script.name));
		return;
	}
	const [steps, schema] = await Promise.all([client.serviceScriptSteps(profile, script.name), client.serviceScriptSchema(profile, script.name)]);
	await writeSnapshot(profile, script, steps);
	await replaceOpenStepsDocument(profile, script, steps);
	await writeServiceScriptSchema(profile, script, schema);
}

async function replaceOpenStepsDocument(profile: EnvironmentProfile, script: ComponentSelection, content: string): Promise<void> {
	const file = serviceScriptFile(profile, script);
	const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === file.toString());
	if (!document) { return; }
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
	if (await vscode.workspace.applyEdit(edit)) { await document.save(); }
}

async function checkinServiceScripts(profile: EnvironmentProfile, scripts: ServiceScriptItem[]): Promise<void> {
	for (const script of scripts) {
		await archiveLocalServiceScriptFiles(profile, script);
	}
	if (scripts.length) {
		vscode.window.showInformationMessage(`Reloaded ${scripts.length} service script${scripts.length === 1 ? '' : 's'} from ${profile.name}.`);
	}
}

async function archiveLocalServiceScriptFiles(profile: EnvironmentProfile, script: ComponentSelection): Promise<void> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	for (const file of [serviceScriptFile(profile, script), serviceScriptSchemaFile(profile, script)]) {
		try {
			await vscode.workspace.fs.rename(file, vscode.Uri.parse(`${file.toString()}.${timestamp}.bak`));
		} catch {
			// A missing local part does not prevent the server reload.
		}
	}
}

function formatXml(content: string): string {
	const tokens = content.trim().replace(/>\s*</g, '><').match(/<[^>]+>|[^<]+/g) ?? [];
	let indentation = 0;
	const lines: string[] = [];
	for (const token of tokens) {
		const value = token.trim();
		if (!value) { continue; }
		if (value.startsWith('</')) { indentation = Math.max(0, indentation - 1); }
		lines.push(`${'\t'.repeat(indentation)}${value}`);
		if (value.startsWith('<') && !value.startsWith('</') && !value.startsWith('<?') && !value.startsWith('<!') && !value.endsWith('/>') && !value.includes('</')) {
			indentation++;
		}
	}
	return lines.join('\n');
}

async function readLocalServiceScript(file: vscode.Uri): Promise<Uint8Array | undefined> {
	try {
		return await vscode.workspace.fs.readFile(file);
	} catch {
		return undefined;
	}
}

function getWorkspaceScriptDirectory(profile: EnvironmentProfile, script: ComponentSelection): vscode.Uri {
	const workspace = vscode.workspace.workspaceFolders?.[0];
	if (!workspace) { throw new Error('Open a workspace or configure a local script directory.'); }
	return vscode.Uri.joinPath(workspace.uri, '.ouaf', profile.name, script.type);
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

async function pickServiceScriptCompareTarget(store: OuafStore, source: EnvironmentProfile): Promise<{ profile: EnvironmentProfile; useLocal: boolean } | undefined> {
	const choice = await vscode.window.showQuickPick([
		'Working copy vs Source',
		'Source vs Target Environment',
		'Working copy vs Target Environment',
	], { placeHolder: 'Compare with' });
	if (!choice) { return undefined; }
	if (choice === 'Working copy vs Source') { return { profile: source, useLocal: true }; }
	const target = await profilePick(store, 'Target environment', source.name);
	return target ? { profile: target, useLocal: choice === 'Working copy vs Target Environment' } : undefined;
}

async function compare(client: OuafClient, documents: CompareDocumentProvider, source: EnvironmentProfile, target: EnvironmentProfile, component: ComponentSelection): Promise<void> {
	try {
		const [sourceContent, targetContent] = await Promise.all([client.fetch(source, component), client.fetch(target, component)]);
		const left = documents.document(sourceContent, 'json');
		const right = documents.document(targetContent, 'json');
		await vscode.commands.executeCommand('vscode.diff', left, right, `${component.name}: ${source.name} <-> ${target.name}`);
	} catch (error) { showError(error); }
}

async function compareServiceScript(client: OuafClient, documents: CompareDocumentProvider, source: EnvironmentProfile, target: { profile: EnvironmentProfile; useLocal: boolean }, script: ServiceScriptItem): Promise<void> {
	try {
		const isSourceLocal = target.useLocal;
		const localContent = isSourceLocal ? await readLocalServiceScript(serviceScriptFile(source, script)) : undefined;
		if (isSourceLocal && localContent === undefined) {
			vscode.window.showWarningMessage(`No local Steps copy exists for ${script.name} in ${source.name}. Check out the script before comparing.`);
			return;
		}
		const leftContent = isSourceLocal
			? Buffer.from(localContent as Uint8Array).toString('utf8')
			: await fetchForCompare(client, source, script);
		const rightContent = await fetchForCompare(client, target.profile, script);
		const left = documents.document(leftContent, 'groovy');
		const right = documents.document(rightContent, 'groovy');
		const leftName = isSourceLocal ? 'local' : `${source.name} server`;
		const rightName = `${target.profile.name} server`;
		await vscode.commands.executeCommand('vscode.diff', left, right, `${script.name}: ${leftName} <-> ${rightName}`);
	} catch (error) {
		showError(error);
	}
}

async function compareServiceScriptSchema(client: OuafClient, documents: CompareDocumentProvider, source: EnvironmentProfile, target: { profile: EnvironmentProfile; useLocal: boolean }, script: ServiceScriptItem): Promise<void> {
	try {
		const isSourceLocal = target.useLocal;
		const localContent = isSourceLocal ? await readLocalServiceScript(serviceScriptSchemaFile(source, script)) : undefined;
		if (isSourceLocal && localContent === undefined) {
			vscode.window.showWarningMessage(`No local Schema copy exists for ${script.name} in ${source.name}. Check out the script before comparing.`);
			return;
		}
		const leftText = formatXml(isSourceLocal
			? Buffer.from(localContent as Uint8Array).toString('utf8')
			: await client.serviceScriptSchema(source, script.name));
		const rightText = formatXml(await client.serviceScriptSchema(target.profile, script.name));
		const left = documents.document(leftText, 'xml');
		const right = documents.document(rightText, 'xml');
		const leftName = isSourceLocal ? 'local' : `${source.name} server`;
		const rightName = `${target.profile.name} server`;
		await vscode.commands.executeCommand('vscode.diff', left, right, `${script.name} schema: ${leftName} <-> ${rightName}`);
	} catch (error) {
		showError(error);
	}
}

async function readLocalCompareContent(file: vscode.Uri, section: string, scriptName: string, environmentName: string): Promise<string> {
	const content = await readLocalServiceScript(file);
	if (content === undefined) {
		throw new Error(`No local ${section} copy exists for ${scriptName} in ${environmentName}. Check out the script before comparing.`);
	}
	return Buffer.from(content).toString('utf8');
}

async function fetchForCompare(client: OuafClient, profile: EnvironmentProfile, script: ServiceScriptItem): Promise<string> {
	try {
		return await client.fetch(profile, script);
	} catch (error) {
		throw new Error(`${profile.name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function writeSnapshot(profile: EnvironmentProfile, component: ComponentSelection, content: string): Promise<void> {
	const directory = getSnapshotDirectory(profile, component);
	if (!directory) { return; }
	await vscode.workspace.fs.createDirectory(directory);
	const extension = component.type === 'serviceScript' ? 'ouaf' : 'json';
	const file = vscode.Uri.joinPath(directory, `${component.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.${extension}`);
	await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));
	const document = await vscode.workspace.openTextDocument(file);
	if (component.type === 'serviceScript') {
		await vscode.languages.setTextDocumentLanguage(document, 'groovy');
	}
	await vscode.window.showTextDocument(document);
	vscode.window.showInformationMessage(`Saved ${component.name} from ${profile.name} to ${vscode.workspace.asRelativePath(file)}.`);
}

function getSnapshotDirectory(profile: EnvironmentProfile, component: ComponentSelection): vscode.Uri | undefined {
	if (component.type === 'serviceScript' && profile.localDirectory) {
		return vscode.Uri.file(profile.localDirectory);
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('Open a workspace or configure a local script directory.');
		return undefined;
	}
	return vscode.Uri.joinPath(folder.uri, '.ouaf', profile.name, component.type);
}

function showError(error: unknown): void { vscode.window.showErrorMessage(`OUAF operation failed: ${error instanceof Error ? error.message : String(error)}`); }

export function deactivate(): void {}

async function openEnvironmentPanel(context: vscode.ExtensionContext, store: OuafStore, client: OuafClient, provider: OuafTreeDataProvider, profileName?: string): Promise<void> {
		const existing = store.profiles().find((profile) => profile.name === profileName);
		const credentials = existing ? await store.apiCredentialsFor(existing.name) : undefined;
		const panel = vscode.window.createWebviewPanel('ouafEnvironment', existing ? 'Edit OUAF Environment' : 'Add OUAF Environment', vscode.ViewColumn.One, { enableScripts: true });
		panel.webview.html = environmentForm(panel.webview, existing, vscode.workspace.getConfiguration('ouaf-config-manager').get<string>('defaultApiPath', '/api/ouaf/config'), credentials?.username);
		panel.webview.onDidReceiveMessage(async (message: EnvironmentMessage) => {
			await handleEnvironmentMessage(message, panel, store, client, provider);
		}, undefined, context.subscriptions);
}

async function handleEnvironmentMessage(message: EnvironmentMessage, panel: vscode.WebviewPanel, store: OuafStore, client: OuafClient, provider: OuafTreeDataProvider): Promise<void> {
	if (message.type === 'cancel') {
		panel.dispose();
		return;
	}
	if (message.type === 'testApi' || message.type === 'testDatabase') {
		await testEnvironmentConnection(message, panel, client);
		return;
	}
	if (message.type === 'save' && message.profile) {
		await saveEnvironment(message, panel, store, client, provider);
	}
}

async function testEnvironmentConnection(message: EnvironmentMessage, panel: vscode.WebviewPanel, client: OuafClient): Promise<void> {
	if (!message.profile) { return; }
	try {
		if (message.type === 'testApi') {
			await client.testApi(message.profile, message.credentials);
		} else {
			await client.testDatabase(message.profile, message.credentials);
		}
		panel.webview.postMessage({ type: 'testResult', success: true, target: message.type });
	} catch (error) {
		panel.webview.postMessage({
			type: 'testResult',
			success: false,
			target: message.type,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function saveEnvironment(message: EnvironmentMessage, panel: vscode.WebviewPanel, store: OuafStore, client: OuafClient, provider: OuafTreeDataProvider): Promise<void> {
	try {
		await store.saveProfile(message.profile!, message.credentials);
		await saveProjectConfiguration(store);
		await provider.refresh(client);
		vscode.window.showInformationMessage(`Saved OUAF environment ${message.profile!.name}.`);
		panel.dispose();
	} catch (error) {
		showError(error);
	}
}

const projectConfigurationFile = '.ouaf/environments.json';

async function loadProjectConfiguration(store: OuafStore): Promise<void> {
	const workspace = vscode.workspace.workspaceFolders?.[0];
	if (!workspace) { return; }
	const file = vscode.Uri.joinPath(workspace.uri, projectConfigurationFile);
	try {
		const content = await vscode.workspace.fs.readFile(file);
		const configuration = JSON.parse(Buffer.from(content).toString('utf8')) as ProjectEnvironmentConfiguration;
		if (!Array.isArray(configuration.profiles)) { throw new Error('profiles must be an array.'); }
		const profiles = configuration.profiles.map((profile) => ({
			...profile,
			localDirectory: profile.localDirectory && !isAbsolutePath(profile.localDirectory)
				? vscode.Uri.joinPath(workspace.uri, profile.localDirectory).fsPath
				: profile.localDirectory,
		}));
		await store.replaceProfiles(profiles, configuration.connectedEnvironments);
	} catch (error) {
		if ((error as vscode.FileSystemError).code === 'FileNotFound') { return; }
		throw error;
	}
}

async function saveProjectConfiguration(store: OuafStore): Promise<void> {
	const workspace = vscode.workspace.workspaceFolders?.[0];
	if (!workspace) { return; }
	const profiles = store.profiles().map((profile) => ({
		...profile,
		localDirectory: profile.localDirectory ? portableLocalDirectory(workspace.uri, profile.localDirectory) : undefined,
	}));
	const configuration: ProjectEnvironmentConfiguration = { profiles, connectedEnvironments: store.connectedEnvironmentNames() };
	const file = vscode.Uri.joinPath(workspace.uri, projectConfigurationFile);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspace.uri, '.ouaf'));
	await vscode.workspace.fs.writeFile(file, Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`, 'utf8'));
}

function isAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('/');
}

function portableLocalDirectory(root: vscode.Uri, directory: string): string {
	const relative = vscode.workspace.asRelativePath(vscode.Uri.file(directory), false);
	return relative.startsWith('..') || isAbsolutePath(relative) ? directory : relative;
}

function environmentForm(webview: vscode.Webview, profile: EnvironmentProfile | undefined, defaultApiPath: string, apiUsername?: string): string {
	const value = (input: string | undefined): string => escapeHtml(input || '');
	const database = profile?.database;
	const authType = profile?.authType || 'bearer';
	const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>OUAF Environment</title><style>
		:root{color-scheme:light dark}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:860px;margin:auto}h1{font-size:22px;font-weight:600;margin:0 0 6px}p{color:var(--vscode-descriptionForeground);margin:0 0 24px}.section{border-top:1px solid var(--vscode-panel-border);padding:20px 0}.section h2{font-size:15px;margin:0 0 14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px}.field{display:flex;flex-direction:column;gap:6px}.wide{grid-column:1/-1}label{font-size:12px;color:var(--vscode-descriptionForeground)}input,select{box-sizing:border-box;width:100%;padding:8px 9px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}input:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}.actions{display:flex;justify-content:flex-end;gap:8px;padding-top:22px}button{padding:8px 16px;border:1px solid var(--vscode-button-border);border-radius:3px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button.secondary{background:transparent;color:var(--vscode-foreground)}button.test{justify-self:start;padding:6px 12px}.status{font-size:12px;min-height:18px;color:var(--vscode-descriptionForeground)}.success{color:var(--vscode-testing-iconPassed)}.failure{color:var(--vscode-testing-iconFailed)}.hidden{display:none}@media(max-width:600px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}}
		</style></head><body><h1>${profile ? 'Edit' : 'Add'} OUAF environment</h1><p>Store connection metadata once, then use it for compare, refresh, and checkout operations.</p><form id="form">
		<div class="section"><h2>Environment</h2><div class="grid"><div class="field"><label for="name">Name</label><input id="name" required value="${value(profile?.name)}" placeholder="Development"></div><div class="field"><label for="kind">Type</label><select id="kind"><option value="dev" ${profile?.kind === 'dev' ? 'selected' : ''}>Development</option><option value="uat" ${profile?.kind === 'uat' ? 'selected' : ''}>UAT</option><option value="prod" ${profile?.kind === 'prod' ? 'selected' : ''}>Production</option></select></div></div></div>
		<div class="section"><h2>OUAF API</h2><div class="grid"><div class="field wide"><label for="baseUrl">Base URL</label><input id="baseUrl" type="url" required value="${value(profile?.baseUrl)}" placeholder="https://ouaf.example.com"></div><div class="field wide"><label for="apiPath">Configuration API path</label><input id="apiPath" required value="${value(profile?.apiPath || defaultApiPath)}" placeholder="/api/ouaf/config"></div><div class="field"><label for="authType">Authentication</label><select id="authType"><option value="none" ${authType === 'none' ? 'selected' : ''}>None</option><option value="bearer" ${authType === 'bearer' ? 'selected' : ''}>Bearer token</option><option value="basic" ${authType === 'basic' ? 'selected' : ''}>Basic authentication</option></select></div><div class="field" id="tokenField"><label for="token">Bearer token</label><input id="token" type="password" placeholder="Leave blank to keep existing"></div><div class="field hidden" id="basicUsernameField"><label for="apiUsername">API username</label><input id="apiUsername" value="${value(apiUsername)}"></div><div class="field hidden" id="basicPasswordField"><label for="apiPassword">API password</label><input id="apiPassword" type="password" placeholder="Leave blank to keep existing"></div><button type="button" class="test" id="testApi">Test API connection</button><div class="status wide" id="apiStatus"></div></div></div>
		<div class="section"><h2>Local script files</h2><div class="grid"><div class="field wide"><label for="localDirectory">Checkout directory</label><input id="localDirectory" value="${value(profile?.localDirectory)}" placeholder="C:\\ouaf-scripts"></div></div></div>
		<div class="section"><h2>Oracle database</h2><div class="grid"><div class="field"><label for="dbHost">Host</label><input id="dbHost" value="${value(database?.host)}" placeholder="db.example.com"></div><div class="field"><label for="dbPort">Port</label><input id="dbPort" value="${value(database?.port || '1521')}" placeholder="1521"></div><div class="field"><label for="dbService">Service name / SID</label><input id="dbService" value="${value(database?.service)}"></div><div class="field"><label for="dbUser">Database user</label><input id="dbUser" value="${value(database?.user)}"></div><div class="field"><label for="dbPassword">Database password</label><input id="dbPassword" type="password" placeholder="Leave blank to keep existing"></div><button type="button" class="test" id="testDatabase">Test database connection</button><div class="status wide" id="databaseStatus"></div></div></div>
		<div class="actions"><button type="button" class="secondary" id="cancel">Cancel</button><button type="submit">Save environment</button></div></form><script nonce="${nonce}">
		const vscode=acquireVsCodeApi();const get=(id)=>document.getElementById(id).value.trim();const authType=document.getElementById('authType');const updateAuth=()=>{const basic=authType.value==='basic';document.getElementById('tokenField').classList.toggle('hidden',basic||authType.value==='none');document.getElementById('basicUsernameField').classList.toggle('hidden',!basic);document.getElementById('basicPasswordField').classList.toggle('hidden',!basic)};authType.addEventListener('change',updateAuth);updateAuth();const credentials=()=>({token:get('token')||undefined,apiUsername:get('apiUsername')||undefined,apiPassword:get('apiPassword')||undefined,databasePassword:get('dbPassword')||undefined});const profile=()=>({name:get('name'),kind:get('kind'),baseUrl:get('baseUrl'),apiPath:get('apiPath'),authType:authType.value,localDirectory:get('localDirectory')||undefined,...((get('dbHost'))?{database:{host:get('dbHost'),port:get('dbPort')||'1521',service:get('dbService'),user:get('dbUser')}}:{})});document.getElementById('cancel').addEventListener('click',()=>vscode.postMessage({type:'cancel'}));document.getElementById('form').addEventListener('submit',(event)=>{event.preventDefault();vscode.postMessage({type:'save',profile:profile(),credentials:credentials()})});const test=(type,id)=>{const status=document.getElementById(id);status.className='status';status.textContent='Testing...';vscode.postMessage({type,profile:profile(),credentials:credentials()})};document.getElementById('testApi').addEventListener('click',()=>test('testApi','apiStatus'));document.getElementById('testDatabase').addEventListener('click',()=>test('testDatabase','databaseStatus'));window.addEventListener('message',(event)=>{const message=event.data;if(message.type!=='testResult'){return}const status=document.getElementById(message.target==='testApi'?'apiStatus':'databaseStatus');status.className=message.success?'status success':'status failure';status.textContent=message.success?'Connection successful':'Connection failed: '+message.error});
		</script></body></html>`;
}

function escapeHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
