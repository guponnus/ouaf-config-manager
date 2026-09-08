# OUAF Configuration Manager

OUAF Configuration Manager helps teams inspect and maintain Oracle Utilities Application Framework configuration from VS Code.

## Features.

- Register Development, UAT, and Production environments with an API URL and optional API token.
- Choose `None`, Bearer token, or Basic authentication for each API environment.
- Capture API username/password and database username/password; all passwords are stored in VS Code Secret Storage.
- Capture database host, port, service, and user metadata per environment; credentials stay outside workspace state.
- Test API and database connectivity directly from the environment form.
- Browse service scripts, business objects, business services, and zones.
- Compare a component from two environments using VS Code's native diff editor.
- Refresh or check out snapshots into `.ouaf/<environment>/<component-type>/`, ready for Git versioning.
- Keep tokens in VS Code Secret Storage; environment metadata is stored in workspace state.

The extension uses this REST adapter endpoint for non-Service Script API component operations:

`<baseUrl>/<apiPath>/<componentType>/<componentName>`

For example, a service script named `C1-DEMO` is requested as:

`https://ouaf.example.com/api/ouaf/config/serviceScript/C1-DEMO`

Service Script configuration uses the SOAP XAI endpoint `<baseUrl>/<apiPath>/CmScriptAsTextViewer`. The extension sends the script code in the `script` element and loads the returned `editDataArea` as the local script content. The OUAF adapter must accept the selected authentication. Database operations use the Oracle Node.js driver directly in thin mode.

The API test sends `GET <baseUrl>/<apiPath>` with the selected authentication. The database test opens an Oracle connection using the configured host, port, service, user, and password, then closes it. Refresh loads service scripts with `SELECT SCR_CD, DESCR254 FROM CI_SCR_L WHERE OWNER_FLG='CM' AND LANGUAGE_CD='ENG' ORDER BY DESCR254`.

## Requirements

An OUAF API adapter and Oracle database access are required. The `oracledb` driver uses thin mode and does not require an Oracle Client installation for supported database versions.

To try it:

1. Run `npm install` and press `F5`.
2. Run **OUAF: Add Environment** for each environment.
3. Run **OUAF: Compare Component** or **OUAF: Checkout Component** from the Command Palette.
4. Commit generated `.ouaf` files with the normal Git integration in VS Code.

## Extension Settings

- `ouaf-config-manager.defaultApiPath`: Default API path for new environments. Defaults to `/api/ouaf/config`.

## Known Limitations

The current release implements read and local versioning workflows. Check-in saves the active local file; publishing requires the OUAF adapter's PUT contract and is intentionally not sent yet.

## Release Notes

### 0.1.0

Added environment profiles, OUAF component comparison, refresh, checkout, and local versioning workflow.
