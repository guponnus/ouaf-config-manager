declare module 'oracledb' {
	export interface Connection {
		execute<T>(sql: string, binds?: unknown[] | Record<string, string>, options?: { outFormat?: number; fetchInfo?: Record<string, { type: number }> }): Promise<{ rows?: T[] }>;
		close(): Promise<void>;
	}

	export interface ConnectionAttributes {
		user: string;
		password: string;
		connectString: string;
	}

	export const OUT_FORMAT_OBJECT: number;
	export const STRING: number;
	export function getConnection(attributes: ConnectionAttributes): Promise<Connection>;
}