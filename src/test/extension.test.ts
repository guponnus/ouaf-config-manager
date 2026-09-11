import * as assert from 'assert';

import * as vscode from 'vscode';
import { buildFilteredServiceScriptQuery, extractSoapFaultMessage } from '../ouaf';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('filtered service scripts match code or description', () => {
		const query = buildFilteredServiceScriptQuery();
		assert.ok(query.toLowerCase().includes('lower(scr_cd) like lower(:filter_cd)'));
		assert.ok(query.toLowerCase().includes('lower(descr254) like lower(:filter_cd)'));
		assert.ok(query.toLowerCase().includes('or'));
	});

	test('SOAP faults expose the Text message', () => {
		assert.strictEqual(
			extractSoapFaultMessage('<soap:Fault><detail><ns:Text>CM-FSAXLMNT is invalid.</ns:Text></detail></soap:Fault>'),
			'CM-FSAXLMNT is invalid.',
		);
		assert.strictEqual(extractSoapFaultMessage('<Fault><Text><![CDATA[Invalid script]]></Text></Fault>'), 'Invalid script');
		assert.strictEqual(extractSoapFaultMessage('<response><message>Not a fault</message></response>'), undefined);
	});
});
