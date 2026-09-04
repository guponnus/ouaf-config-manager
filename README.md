# OUAF Configuration Manager

OUAF Configuration Manager helps teams inspect and maintain Oracle Utilities Application Framework configuration from VS Code.

## Features

- Register Development, UAT, and Production environments with an API URL and optional API token.
- Choose `None`, Bearer token, or Basic authentication for each API environment.
- Capture API username/password and database username/password; all passwords are stored in VS Code Secret Storage.
- Capture database host, port, service, and user metadata per environment; credentials stay outside workspace state.
- Test API and database connectivity directly from the environment form.
- Browse service scripts, business objects, business services, and zones.
- Compare a component from two environments using VS Code's native diff editor.
- Refresh or check out snapshots into `.ouaf/<environment>/<component-type>/`, ready for Git versioning.
- Keep tokens in VS Code Secret Storage; environment metadata is stored in workspace state.

The extension uses this REST adapter endpoint:

`<baseUrl>/<apiPath>/<componentType>/<componentName>`

For example, a service script named `C1-DEMO` is requested as:

`https://ouaf.example.com/api/ouaf/config/serviceScript/C1-DEMO`

The OUAF adapter must return the component body as JSON or text and accept an optional Bearer token. The adapter can own database connections and deployment-specific OUAF details, so database credentials are not stored as plaintext in VS Code.

The API test sends `GET <baseUrl>/<apiPath>` with the selected authentication. The database test sends `POST <baseUrl>/<apiPath>/database/test` with `{ "database": { ... }, "databasePassword": "..." }` and the selected API authentication. A successful 2xx response is shown as a successful connection.

## Requirements

An OUAF API adapter is required. The extension does not assume a specific OUAF deployment URL or database driver.

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
