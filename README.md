# OUAF Configuration Manager

OUAF Configuration Manager helps teams inspect and maintain Oracle Utilities Application Framework configuration from VS Code.

## Features

- Register Development, UAT, and Production environments with an API URL and optional API token.
- Choose `None`, Bearer token, or Basic authentication for each API environment.
- Capture API username/password and database username/password; all passwords are stored in VS Code Secret Storage.
- Capture database host, port, service, and user metadata per environment; credentials stay outside workspace state.
- Test API and database connectivity directly from the environment form.
- Browse Scripts from connected environments.
- Filter Scripts by code or description and select multiple Scripts in the explorer.
- Preserve Script filters and the "show only checked-out items" setting across refreshes and extension reloads.
- Check out one or more Scripts, or all Scripts matching the active filter, including Steps and Schema.
- Open local Steps files when checked out; otherwise load them from the server.
- Open Schema in a two-tab View/Edit panel. View shows a syntax-highlighted XML tree, including non-selectable closing elements; Edit provides an editable XML surface.
- Select an XML element to display its case-sensitive XPath, focus and select the XPath field, and copy the XPath automatically to the clipboard. List elements use a `[1]` XPath suffix.
- Save Schema edits with the normal editor save shortcut; switching back to View reflects the current XML content.
- Compare Steps or Schema from a local copy or server copy to a same-environment or target-environment server copy using VS Code's native diff editor.
- Replace local Steps from another environment without changing the local Schema.
- Check in by timestamping and removing active local copies, returning the Script to its server state.
- Show local and changed status indicators in the explorer.
- Connect or disconnect environments and collapse the explorer tree.
- Refresh or check out snapshots into `.ouaf/<environment>/<component-type>/`, ready for Git versioning.
- Keep tokens in VS Code Secret Storage; environment metadata is stored in workspace state.

The extension uses this REST adapter endpoint for non-Service Script API component operations:

`<baseUrl>/<apiPath>/<componentType>/<componentName>`

For example, a service script named `C1-DEMO` is requested as:

`https://ouaf.example.com/api/ouaf/config/serviceScript/C1-DEMO`

Service Script configuration uses the SOAP XAI endpoint `<baseUrl>/<apiPath>/CmScriptAsTextViewer`. The extension sends the script code and an `option` element:

- Blank option: returns both `schemaDefinition` and `editDataArea`.
- `s`: returns Steps in `editDataArea`.
- `x`: returns Schema in `schemaDefinition`.

Schema content is formatted before display, saving, and comparison. Server content used for comparison is kept in memory and is not saved locally. The OUAF adapter must accept the selected authentication. Database operations use the Oracle Node.js driver directly in thin mode.

The API test sends `GET <baseUrl>/<apiPath>` with the selected authentication. The database test opens an Oracle connection using the configured host, port, service, user, and password, then closes it. Refresh loads service scripts with `SELECT SCR_CD, DESCR254 FROM CI_SCR_L WHERE OWNER_FLG='CM' AND LANGUAGE_CD='ENG' ORDER BY DESCR254`.

## Requirements

An OUAF API adapter and Oracle database access are required. The `oracledb` driver uses thin mode and does not require an Oracle Client installation for supported database versions.

To try it:

1. Run `npm install` and press `F5`.
2. Run **OUAF: Add Environment** for each environment.
3. Connect an environment, expand **Script**, and filter the available Scripts.
4. Filter Scripts or enable **Show Local Service Scripts**; these explorer choices are retained across refreshes and reloads.
5. Select one or more Scripts and use **Checkout Service Scripts**, or use it on the Script group to check out all filtered results. Checkout saves Steps and Schema without opening the files.
6. Open Schema to inspect the XML tree in **View** or edit it in **Edit**. Select an element to copy its XPath, then save changes with the normal editor save shortcut.
7. Use the Steps or Schema actions to choose **Working copy vs Source**, **Working copy vs Target Environment**, or **Source vs Target Environment**, or replace Steps from another environment.
8. Commit generated `.ouaf` and `.xml` files with the normal Git integration in VS Code.

## Extension Settings

- `ouaf-config-manager.defaultApiPath`: Default API path for new environments. Defaults to `/api/ouaf/config`.

## Local Files

Checked-out files are stored under `.ouaf/<environment>/serviceScript/` unless an environment-specific local directory is configured. Steps use `.ouaf`; Schema uses `.xml`. Filenames are based on the Script code, with unsupported characters sanitized and trailing underscores removed.

Check-in does not publish changes to OUAF. It archives active local files with a timestamped `.bak` suffix and removes the active local copies, allowing the explorer to return to the server state.

## Release Notes

### 0.1.0

Added environment profiles, OUAF component comparison, refresh, checkout, and local versioning workflow.
