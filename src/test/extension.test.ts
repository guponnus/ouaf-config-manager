import * as assert from 'assert';

import * as vscode from 'vscode';
import { buildFilteredServiceScriptQuery } from '../ouaf';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('filtered service scripts match code or description', () => {
		const query = buildFilteredServiceScriptQuery();
		assert.ok(query.toLowerCase().includes('lower(scr_cd) like lower(:filter_cd)'));
		assert.ok(query.toLowerCase().includes('lower(descr254) like lower(:filter_cd)'));
		assert.ok(query.toLowerCase().includes('or'));
	});
});
