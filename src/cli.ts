#!/usr/bin/env node
import { Pool } from 'pg';
import { PoolManager } from './core/pool-manager';
import { config } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as packageJson from '../package.json';
import { SqlExecutor } from './core/sql-executor';
import { BackupOptions } from './types/backup';
import { logger } from './utils/logger';

interface Constraint {
  constraint_type: string;
  constraint_name: string;
  column_name: string;
}

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

// Load .env from the package root (handles both root and subdirectory execution)
const envPath = resolve(__dirname, '../.env');
config({ path: envPath });

// CLI output helpers that maintain console output but also log
const cliOutput = {
  log: (message: string) => {
    console.log(message);
    logger.debug('CLI output:', { message });
  },
  error: (message: string) => {
    console.error(message);
    logger.error('CLI error:', { message });
  },
  table: (data: any) => {
    console.table(data);
    logger.debug('CLI table output:', { rowCount: Array.isArray(data) ? data.length : 'N/A' });
  },
  json: (data: any) => {
    const json = JSON.stringify(data);
    console.log(json);
    logger.debug('CLI JSON output:', { data });
  },
};

export function handleVersion(jsonMode: boolean): string {
  if (jsonMode) {
    return JSON.stringify({ version: packageJson.version });
  } else {
    return `sequelae-mcp v${packageJson.version}`;
  }
}

export function handleHelp(jsonMode: boolean): string {
  if (jsonMode) {
    return JSON.stringify({
      usage: [
        'sequelae exec "SQL query"         Execute a SQL query',
        'sequelae file path/to/query.sql   Execute SQL from file',
        'sequelae schema                   Show all tables in public schema',
        'sequelae schema [tables]          Show specific table(s) - comma separated',
        'sequelae schema --all             Show all schemas including system tables',
        'sequelae backup                   Create a database backup',
        'sequelae exit                     Exit sequelae',
        'sequelae --json                   Output results in JSON format',
      ],
      examples: [
        'sequelae exec "SELECT * FROM users"',
        'sequelae exec "CREATE TABLE posts (id serial primary key, title text)"',
        'sequelae file migrations/001_init.sql',
        'sequelae schema',
        'sequelae schema users,posts',
        'sequelae backup --output db_backup.sql',
        'sequelae backup --tables users,posts --format custom',
        'sequelae --json exec "SELECT * FROM users"',
      ],
    });
  } else {
    return `
Usage:
  sequelae exec "SQL query"         Execute a SQL query
  sequelae file path/to/query.sql   Execute SQL from file
  sequelae schema                   Show all tables in public schema
  sequelae schema [tables]          Show specific table(s) - comma separated
  sequelae schema --all             Show all schemas including system tables
  sequelae backup                   Create a database backup
  sequelae exit                     Exit sequelae
  sequelae --json                   Output results in JSON format
  sequelae --no-transaction         Disable automatic transactions
  sequelae --timeout <ms>           Set query timeout in milliseconds
  
Examples:
  sequelae exec "SELECT * FROM users"
  sequelae exec "CREATE TABLE posts (id serial primary key, title text)"
  sequelae file migrations/001_init.sql
  sequelae schema
  sequelae schema users,posts
  sequelae backup --output db_backup.sql
  sequelae backup --tables users,posts --format custom
  sequelae --json exec "SELECT * FROM users"
    `;
  }
}

export function formatError(error: string, jsonMode: boolean, hint?: string): string {
  if (jsonMode) {
    return JSON.stringify({ error, ...(hint && { hint }) });
  } else {
    let output = `Error: ${error}`;
    if (hint) {
      output += `\n${hint}`;
    }
    return output;
  }
}

export function handleExit(jsonMode: boolean): string {
  if (jsonMode) {
    return JSON.stringify({ message: 'Goodbye!' });
  } else {
    return 'Goodbye!';
  }
}

export interface ParsedArguments {
  jsonMode: boolean;
  allSchemas: boolean;
  noTransaction: boolean;
  timeout?: number;
  filteredArgs: string[];
}

export function parseArguments(args: string[]): ParsedArguments {
  const jsonMode = args.includes('--json');
  const allSchemas = args.includes('--all');
  const noTransaction = args.includes('--no-transaction');

  // Extract timeout value
  let timeout: number | undefined;
  let timeoutValueIndex: number | undefined;
  const timeoutIndex = args.indexOf('--timeout');
  if (timeoutIndex !== -1 && timeoutIndex + 1 < args.length) {
    const possibleValue = args[timeoutIndex + 1];
    // Only treat as timeout value if it's a valid number and not another flag/command
    if (!possibleValue.startsWith('-')) {
      const timeoutValue = parseInt(possibleValue);
      if (!isNaN(timeoutValue) && timeoutValue > 0) {
        timeout = timeoutValue;
      }
      // Always mark the next value for removal if it doesn't start with '-'
      timeoutValueIndex = timeoutIndex + 1;
    }
  }

  const filteredArgs = args.filter((arg, index) => {
    // Remove flags
    if (arg === '--json' || arg === '--all' || arg === '--no-transaction') {
      return false;
    }
    // Remove --timeout and its value
    if (arg === '--timeout') {
      return false;
    }
    if (timeoutValueIndex !== undefined && index === timeoutValueIndex) {
      return false;
    }
    return true;
  });

  return {
    jsonMode,
    allSchemas,
    noTransaction,
    timeout,
    filteredArgs,
  };
}

export function validateDatabaseUrl(
  databaseUrl: string | undefined,
  jsonMode: boolean
): string | null {
  if (!databaseUrl) {
    return formatError(
      'DATABASE_URL environment variable is not set',
      jsonMode,
      'Make sure you have a .env file with DATABASE_URL from your Supabase project'
    );
  }
  return null;
}

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
}

export interface CommandInfo {
  command: string;
  needsArgument: boolean;
  argumentName?: string;
}

export function getCommandInfo(command: string): CommandInfo | null {
  const commands: Record<string, CommandInfo> = {
    exec: { command: 'exec', needsArgument: true, argumentName: 'SQL query' },
    file: { command: 'file', needsArgument: true, argumentName: 'file path' },
    schema: { command: 'schema', needsArgument: false },
  };

  return commands[command] || null;
}

export function validateCommandArgument(
  commandInfo: CommandInfo,
  argument: string | undefined,
  jsonMode: boolean
): string | null {
  if (commandInfo.needsArgument && !argument) {
    return formatError(`No ${commandInfo.argumentName} provided`, jsonMode);
  }
  return null;
}

export function validateFile(filepath: string, jsonMode: boolean): string | null {
  if (!existsSync(filepath)) {
    return formatError(`File not found: ${filepath}`, jsonMode);
  }
  return null;
}

export function readSqlFile(filepath: string): string {
  return readFileSync(filepath, 'utf8');
}

export interface QueryResult {
  command?: string;
  rowCount?: number;
  rows?: Record<string, unknown>[];
  duration?: number;
}

export function formatQueryResultsJson(result: QueryResult, duration: number): string {
  const output = {
    success: true,
    command: result.command || 'Query executed',
    rowCount: result.rowCount || 0,
    rows: result.rows || [],
    duration: duration,
  };
  return JSON.stringify(output);
}

export interface SqlError extends Error {
  position?: number;
}

export class SqlAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = 'SqlAgentError';
  }
}

export function createNoCommandError(): SqlAgentError {
  return new SqlAgentError(
    'No command provided',
    'NO_COMMAND',
    'Run sequelae --help for usage information'
  );
}

export function createNoSqlQueryError(): SqlAgentError {
  return new SqlAgentError('No SQL query provided', 'NO_SQL_QUERY');
}

export function createNoFilePathError(): SqlAgentError {
  return new SqlAgentError('No file path provided', 'NO_FILE_PATH');
}

export function createFileNotFoundError(filepath: string): SqlAgentError {
  return new SqlAgentError(`File not found: ${filepath}`, 'FILE_NOT_FOUND');
}

export function formatSqlError(error: SqlError, jsonMode: boolean): string {
  if (jsonMode) {
    const errorOutput = {
      success: false,
      error: error.message,
      position: error.position,
    };
    return JSON.stringify(errorOutput);
  } else {
    let output = `\nError: ${error.message}`;
    if (error.position) {
      output += `\nPosition: ${error.position}`;
    }
    return output;
  }
}

export function formatCommandResult(
  command: string,
  rowCount: number | null,
  duration: number
): string {
  const commandText = command || 'Query executed';
  const rowCountText = rowCount ? `(${rowCount} rows)` : '';
  return `\n✓ ${commandText} ${rowCountText} - ${duration}ms`;
}

export function buildSchemaCondition(allSchemas: boolean): string {
  return allSchemas
    ? "table_schema NOT IN ('pg_catalog', 'information_schema')"
    : "table_schema = 'public'";
}

async function cleanupPool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch (error) {
    cliOutput.error(`Error closing database pool: ${error}`);
  }
}

// Cleanup function for shared pool
// Currently not used as the pool is shared across all SqlExecutor instances
// and will be cleaned up when the process exits
async function _cleanupSharedPool(): Promise<void> {
  const poolManager = PoolManager.getInstance();
  await poolManager.close();
}

export function buildTableList(tables: string): string[] {
  return tables
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

export function isDirectSqlCommand(command: string): boolean {
  const sqlKeywords = [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'DROP',
    'ALTER',
    'TRUNCATE',
  ];
  const upperCommand = command.toUpperCase();
  return sqlKeywords.some(keyword => upperCommand.startsWith(keyword));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  const { jsonMode, allSchemas, noTransaction, timeout, filteredArgs } = parseArguments(args);

  // Skip header when running in Jest or JSON mode
  if (typeof jest === 'undefined' && !jsonMode) {
    cliOutput.log('🔗 sequelae-mcp - PostgreSQL SQL executor\n');
  }

  // Handle no arguments
  if (filteredArgs.length === 0) {
    const error = createNoCommandError();
    const output = formatError(error.message, jsonMode, error.hint);
    if (jsonMode) {
      cliOutput.json(JSON.parse(output));
    } else {
      cliOutput.error(output);
    }
    process.exit(1);
  }

  // Handle help
  if (filteredArgs[0] === '--help' || filteredArgs[0] === '-h') {
    const output = handleHelp(jsonMode);
    if (jsonMode) {
      cliOutput.json(JSON.parse(output));
    } else {
      cliOutput.log(output);
    }
    process.exit(0);
  }

  // Handle version
  if (filteredArgs[0] === '--version' || filteredArgs[0] === '-v') {
    const output = handleVersion(jsonMode);
    if (jsonMode) {
      cliOutput.json(JSON.parse(output));
    } else {
      cliOutput.log(output);
    }
    process.exit(0);
  }

  // Handle exit command
  if (filteredArgs[0] === 'exit' || filteredArgs[0] === 'quit') {
    const output = handleExit(jsonMode);
    if (jsonMode) {
      cliOutput.json(JSON.parse(output));
    } else {
      cliOutput.log(output);
    }
    process.exit(0);
  }

  const databaseUrl = process.env.DATABASE_URL;

  // Set timeout environment variable if provided
  if (timeout) {
    process.env.POSTGRES_STATEMENT_TIMEOUT = timeout.toString();
  }

  const dbError = validateDatabaseUrl(databaseUrl, jsonMode);
  if (dbError) {
    if (jsonMode) {
      cliOutput.json(JSON.parse(dbError));
    } else {
      cliOutput.error(dbError);
    }
    process.exit(1);
  }

  // At this point, databaseUrl is guaranteed to be defined
  const pool = createPool(databaseUrl as string);

  try {
    let sql: string;

    if (filteredArgs[0] === 'exec') {
      if (!filteredArgs[1]) {
        const error = createNoSqlQueryError();
        const output = formatError(error.message, jsonMode, error.hint);
        if (jsonMode) {
          cliOutput.json(JSON.parse(output));
        } else {
          cliOutput.error(output);
        }
        await cleanupPool(pool);
        process.exit(1);
      }
      sql = filteredArgs[1];
    } else if (filteredArgs[0] === 'file') {
      if (!filteredArgs[1]) {
        const error = createNoFilePathError();
        const output = formatError(error.message, jsonMode, error.hint);
        if (jsonMode) {
          cliOutput.json(JSON.parse(output));
        } else {
          cliOutput.error(output);
        }
        await cleanupPool(pool);
        process.exit(1);
      }
      const filepath = resolve(process.cwd(), filteredArgs[1]);

      // Check if file exists
      if (!existsSync(filepath)) {
        const error = createFileNotFoundError(filepath);
        const output = formatError(error.message, jsonMode, error.hint);
        if (jsonMode) {
          cliOutput.json(JSON.parse(output));
        } else {
          cliOutput.error(output);
        }
        await cleanupPool(pool);
        process.exit(1);
      }

      sql = readFileSync(filepath, 'utf8');
    } else if (filteredArgs[0] === 'schema') {
      // Schema command - show database structure
      // Join all remaining arguments as they might be space-separated table names
      const specificTables = filteredArgs.slice(1).join(' '); // Could be comma-separated list

      if (specificTables) {
        // Schema for specific tables
        const tableList = specificTables
          .split(',')
          .map(t => t.trim())
          .filter(t => t.length > 0); // Remove empty strings

        if (tableList.length === 0) {
          if (jsonMode) {
            cliOutput.json({ error: 'No table names provided' });
          } else {
            cliOutput.error('Error: No table names provided');
          }
          await cleanupPool(pool);
          process.exit(1);
        }

        const tableCondition = tableList.map(t => `'${t}'`).join(',');

        sql = `
        WITH requested_tables AS (
          SELECT unnest(ARRAY[${tableCondition}]) as table_name
        ),
        existing_tables AS (
          SELECT table_schema, table_name 
          FROM information_schema.tables 
          WHERE table_type = 'BASE TABLE' 
            AND ${allSchemas ? "table_schema NOT IN ('pg_catalog', 'information_schema')" : "table_schema = 'public'"}
        ),
        table_info AS (
          SELECT 
            t.table_schema,
            t.table_name,
            json_agg(
              json_build_object(
                'column_name', c.column_name,
                'data_type', c.data_type,
                'is_nullable', c.is_nullable,
                'column_default', c.column_default,
                'character_maximum_length', c.character_maximum_length
              ) ORDER BY c.ordinal_position
            )::text as columns
          FROM information_schema.tables t
          JOIN information_schema.columns c 
            ON t.table_schema = c.table_schema 
            AND t.table_name = c.table_name
          JOIN requested_tables rt ON t.table_name = rt.table_name
          WHERE ${allSchemas ? "t.table_schema NOT IN ('pg_catalog', 'information_schema')" : "t.table_schema = 'public'"}
            AND t.table_type = 'BASE TABLE'
          GROUP BY t.table_schema, t.table_name
        ),
        constraint_info AS (
          SELECT 
            tc.table_schema,
            tc.table_name,
            json_agg(
              json_build_object(
                'constraint_name', tc.constraint_name,
                'constraint_type', tc.constraint_type,
                'column_name', kcu.column_name
              )
            )::text as constraints
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN requested_tables rt ON tc.table_name = rt.table_name
          WHERE ${allSchemas ? "tc.table_schema NOT IN ('pg_catalog', 'information_schema')" : "tc.table_schema = 'public'"}
          GROUP BY tc.table_schema, tc.table_name
        ),
        missing_tables AS (
          SELECT rt.table_name as missing_table,
                 string_agg(et.table_name, ', ') as suggestions
          FROM requested_tables rt
          LEFT JOIN existing_tables et ON rt.table_name = et.table_name
          WHERE et.table_name IS NULL
          GROUP BY rt.table_name
        )
        SELECT 
          'found' as type,
          ti.table_schema,
          ti.table_name,
          ti.columns,
          COALESCE(ci.constraints, '[]') as constraints,
          NULL as missing_table,
          NULL as suggestions
        FROM table_info ti
        LEFT JOIN constraint_info ci
          ON ti.table_schema = ci.table_schema
          AND ti.table_name = ci.table_name
        UNION ALL
        SELECT 
          'missing' as type,
          NULL as table_schema,
          NULL as table_name,
          NULL as columns,
          NULL as constraints,
          mt.missing_table,
          (SELECT string_agg(tn, ', ') FROM (
             SELECT table_name as tn
             FROM existing_tables
             WHERE LOWER(table_name) LIKE LOWER(LEFT(mt.missing_table, 3) || '%')
                OR LOWER(table_name) LIKE '%' || LOWER(LEFT(mt.missing_table, 3)) || '%'
             ORDER BY 
               CASE WHEN LOWER(table_name) LIKE LOWER(LEFT(mt.missing_table, 3) || '%') THEN 0 ELSE 1 END,
               LENGTH(table_name)
             LIMIT 3
           ) s) as suggestions
        FROM missing_tables mt
        ORDER BY type, table_schema, table_name;
        `;
      } else {
        // Show all tables
        sql = `
        WITH table_info AS (
          SELECT 
            t.table_schema,
            t.table_name,
            json_agg(
              json_build_object(
                'column_name', c.column_name,
                'data_type', c.data_type,
                'is_nullable', c.is_nullable,
                'column_default', c.column_default,
                'character_maximum_length', c.character_maximum_length
              ) ORDER BY c.ordinal_position
            )::text as columns
          FROM information_schema.tables t
          JOIN information_schema.columns c 
            ON t.table_schema = c.table_schema 
            AND t.table_name = c.table_name
          WHERE ${allSchemas ? "t.table_schema NOT IN ('pg_catalog', 'information_schema')" : "t.table_schema = 'public'"}
            AND t.table_type = 'BASE TABLE'
          GROUP BY t.table_schema, t.table_name
        ),
        constraint_info AS (
          SELECT 
            tc.table_schema,
            tc.table_name,
            json_agg(
              json_build_object(
                'constraint_name', tc.constraint_name,
                'constraint_type', tc.constraint_type,
                'column_name', kcu.column_name
              )
            )::text as constraints
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE ${allSchemas ? "tc.table_schema NOT IN ('pg_catalog', 'information_schema')" : "tc.table_schema = 'public'"}
          GROUP BY tc.table_schema, tc.table_name
        )
        SELECT 
          'found' as type,
          ti.table_schema,
          ti.table_name,
          ti.columns,
          COALESCE(ci.constraints, '[]') as constraints,
          NULL as missing_table,
          NULL as suggestions
        FROM table_info ti
        LEFT JOIN constraint_info ci
          ON ti.table_schema = ci.table_schema
          AND ti.table_name = ci.table_name
        ORDER BY ti.table_schema, ti.table_name;
        `;
      }
    } else if (filteredArgs[0] === 'exec' || filteredArgs[0] === 'file') {
      // Command recognized but missing argument
      if (jsonMode) {
        cliOutput.json({ error: `Missing argument for ${filteredArgs[0]} command` });
      } else {
        cliOutput.error(`Error: Missing argument for ${filteredArgs[0]} command`);
      }
      await cleanupPool(pool);
      process.exit(1);
    } else {
      // Check if it looks like a SQL command
      const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER'];
      const firstWord = filteredArgs[0].toUpperCase();

      if (sqlKeywords.includes(firstWord)) {
        // Direct SQL command
        sql = filteredArgs.join(' ');
      } else if (filteredArgs[0] === 'backup') {
        // Handle backup command
        const executor = new SqlExecutor(databaseUrl as string);
        try {
          // Parse backup options
          const options: BackupOptions = {};

          for (let i = 1; i < filteredArgs.length; i++) {
            const arg = filteredArgs[i];
            if (arg === '--format' && i + 1 < filteredArgs.length) {
              options.format = filteredArgs[++i] as 'plain' | 'custom' | 'directory' | 'tar';
            } else if (arg === '--tables' && i + 1 < filteredArgs.length) {
              options.tables = filteredArgs[++i].split(',').map(t => t.trim());
            } else if (arg === '--schemas' && i + 1 < filteredArgs.length) {
              options.schemas = filteredArgs[++i].split(',').map(s => s.trim());
            } else if (arg === '--output' && i + 1 < filteredArgs.length) {
              options.outputPath = filteredArgs[++i];
            } else if (arg === '--data-only') {
              options.dataOnly = true;
            } else if (arg === '--schema-only') {
              options.schemaOnly = true;
            } else if (arg === '--compress') {
              options.compress = true;
            }
          }

          // Show progress
          if (!jsonMode) {
            cliOutput.log('Creating backup...');
          }

          const result = await executor.backup(options);

          if (result.success) {
            if (jsonMode) {
              cliOutput.json({
                success: true,
                outputPath: result.outputPath,
                size: result.size,
                duration: result.duration,
              });
            } else {
              cliOutput.log(`\n✅ Backup completed successfully!`);
              cliOutput.log(`📁 Output: ${result.outputPath}`);
              if (result.size) {
                cliOutput.log(`📊 Size: ${(result.size / 1024 / 1024).toFixed(2)} MB`);
              }
              cliOutput.log(`⏱️  Duration: ${(result.duration / 1000).toFixed(2)}s`);
            }
            await cleanupPool(pool);
            process.exit(0);
          } else {
            if (jsonMode) {
              cliOutput.json({
                success: false,
                error: result.error,
              });
            } else {
              cliOutput.error(`\n❌ Backup failed: ${result.error}`);
            }
            await cleanupPool(pool);
            process.exit(1);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (jsonMode) {
            cliOutput.json({ error: errorMessage });
          } else {
            cliOutput.error(`Error: ${errorMessage}`);
          }
          await cleanupPool(pool);
          process.exit(1);
        } finally {
          await executor.close();
        }
      } else {
        // Unknown command
        if (jsonMode) {
          cliOutput.json({ error: `Unknown command: ${filteredArgs[0]}` });
        } else {
          cliOutput.error(`Error: Unknown command: ${filteredArgs[0]}`);
          cliOutput.error('Run sequelae --help for usage information');
        }
        await cleanupPool(pool);
        process.exit(1);
      }
    }

    // Execute the query using SqlExecutor
    const executor = new SqlExecutor(databaseUrl as string);
    let result: QueryResult;

    try {
      if (filteredArgs[0] === 'file') {
        result = await executor.executeFile(filteredArgs[1], !noTransaction, timeout);
      } else {
        result = await executor.executeQuery(sql, !noTransaction, timeout);
      }
    } finally {
      await executor.close();
    }

    // Display results
    if (jsonMode) {
      const output = {
        success: true,
        command: result.command || 'Query executed',
        rowCount: result.rowCount || 0,
        rows: result.rows || [],
        duration: result.duration || 0,
      };
      cliOutput.json(output);
    } else {
      // Special handling for schema command
      if (filteredArgs[0] === 'schema' && result.rows && result.rows.length > 0) {
        cliOutput.log('DATABASE SCHEMA:\n');

        // Separate found and missing tables
        const foundTables = result.rows.filter(r => r.type === 'found');
        const missingTables = result.rows.filter(r => r.type === 'missing');

        // Display found tables
        for (const table of foundTables) {
          cliOutput.log(`📋 ${table.table_schema}.${table.table_name}`);

          // Display columns
          const columns: Column[] = JSON.parse(table.columns as string);
          cliOutput.log('  Columns:');
          for (const col of columns) {
            const nullable = col.is_nullable === 'YES' ? ' (nullable)' : '';
            const dataType = col.character_maximum_length
              ? `${col.data_type}(${col.character_maximum_length})`
              : col.data_type;
            const defaultVal = col.column_default ? ` DEFAULT ${col.column_default}` : '';
            cliOutput.log(`    - ${col.column_name}: ${dataType}${nullable}${defaultVal}`);
          }

          // Display constraints
          const constraints: Constraint[] = JSON.parse(table.constraints as string);
          if (constraints.length > 0) {
            cliOutput.log('  Constraints:');
            const constraintsByType = constraints.reduce(
              (acc: Record<string, Constraint[]>, c: Constraint) => {
                if (!acc[c.constraint_type]) acc[c.constraint_type] = [];
                acc[c.constraint_type].push(c);
                return acc;
              },
              {}
            );

            for (const [type, consts] of Object.entries(constraintsByType)) {
              const columns = consts.map(c => c.column_name).join(', ');
              cliOutput.log(`    - ${type}: ${columns}`);
            }
          }
          cliOutput.log('');
        }

        // Display missing tables with suggestions
        if (missingTables.length > 0) {
          cliOutput.log('❌ TABLES NOT FOUND:\n');
          for (const missing of missingTables) {
            cliOutput.log(`  - "${missing.missing_table}"`);
            if (missing.suggestions) {
              cliOutput.log(`    Did you mean: ${missing.suggestions}?`);
            }
          }
          cliOutput.log('');
        }
      } else if (result.rows && result.rows.length > 0) {
        cliOutput.table(result.rows);
      }

      // Show execution info
      const command = result.command || 'Query executed';
      cliOutput.log(
        `\n✓ ${command} ${result.rowCount ? `(${result.rowCount} rows)` : ''} - ${result.duration}ms`
      );
    }
  } catch (error) {
    const err = error as Error & { position?: number };
    if (jsonMode) {
      const errorOutput = {
        success: false,
        error: err.message,
        position: err.position,
      };
      cliOutput.json(errorOutput);
    } else {
      cliOutput.error(`\nError: ${err.message}`);
      if (err.position) {
        cliOutput.error(`Position: ${err.position}`);
      }
    }
    await pool.end();
    process.exit(1);
  }

  // Success - close pool and exit cleanly
  try {
    await pool.end();
  } catch (error) {
    cliOutput.error(`Error closing database pool: ${error}`);
  }
  process.exit(0);
}

// Export main for programmatic use
export { main };

// Only run if this module is executed directly
if (require.main === module) {
  // Run main and handle unhandled errors
  main().catch(async error => {
    cliOutput.error(String(error));
    process.exit(1);
  });

  // Handle process errors properly
  process.on('unhandledRejection', (reason, promise) => {
    cliOutput.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
  });

  process.on('uncaughtException', error => {
    cliOutput.error(`Uncaught Exception: ${error}`);
    process.exit(1);
  });
}
