import { Pool } from 'pg';
import { SqlExecutor } from '../src/core/sql-executor';
// Import main is not needed - we'll test through process.argv
// import { readFileSync } from 'fs'; - not needed with mocks

// Mock dependencies
jest.mock('pg');
jest.mock('../src/core/sql-executor');
jest.mock('fs');

const mockPool = {
  connect: jest.fn(),
  end: jest.fn(),
};

const mockExecutor = {
  executeQuery: jest.fn(),
  executeFile: jest.fn(),
  getSchema: jest.fn(),
  createBackup: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

// Mock console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleTable = console.table;
const originalProcessExit = process.exit;

describe('CLI File Command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.log = jest.fn();
    console.error = jest.fn();
    console.table = jest.fn();
    process.exit = jest.fn() as never;

    (Pool as jest.MockedClass<typeof Pool>).mockImplementation(() => mockPool as any);
    (SqlExecutor as jest.MockedClass<typeof SqlExecutor>).mockImplementation(
      () => mockExecutor as any
    );

    // Setup environment
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.table = originalConsoleTable;
    process.exit = originalProcessExit;
  });

  describe('file command', () => {
    test('should execute SQL from valid file', async () => {
      const mockResult = {
        success: true,
        results: [
          {
            success: true,
            command: 'CREATE',
            rowCount: 0,
            rows: [],
            fields: [],
            duration: 50,
          },
          {
            success: true,
            command: 'INSERT',
            rowCount: 2,
            rows: [],
            fields: [],
            duration: 30,
          },
        ],
        totalDuration: 80,
      };

      mockExecutor.executeFile.mockResolvedValue(mockResult);

      process.argv = ['node', 'sequelae', 'file', 'migrations/001_init.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(mockExecutor.executeFile).toHaveBeenCalledWith('migrations/001_init.sql', true);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('CREATE OK'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('INSERT 2'));
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    test('should execute SQL file in JSON mode', async () => {
      const mockResult = {
        success: true,
        results: [
          {
            success: true,
            command: 'SELECT',
            rowCount: 5,
            rows: [
              /* ... */
            ],
            fields: [],
            duration: 40,
          },
        ],
        totalDuration: 40,
      };

      mockExecutor.executeFile.mockResolvedValue(mockResult);

      process.argv = ['node', 'sequelae', '--json', 'file', 'query.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(console.log).toHaveBeenCalledWith(JSON.stringify(mockResult));
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    test('should handle non-existent file', async () => {
      mockExecutor.executeFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      process.argv = ['node', 'sequelae', 'file', 'nonexistent.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('no such file'));
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    test('should handle empty file', async () => {
      const mockResult = {
        success: true,
        results: [],
        totalDuration: 0,
      };

      mockExecutor.executeFile.mockResolvedValue(mockResult);

      process.argv = ['node', 'sequelae', 'file', 'empty.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No SQL statements found'));
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    test('should require file path argument', async () => {
      process.argv = ['node', 'sequelae', 'file'];
      const { main } = require('../src/cli');
      await main();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('File path is required'));
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    test('should handle file with SQL errors', async () => {
      const mockResult = {
        success: false,
        results: [
          {
            success: true,
            command: 'CREATE',
            rowCount: 0,
            rows: [],
            fields: [],
            duration: 30,
          },
          {
            success: false,
            error: 'relation "users" already exists',
            duration: 10,
          },
        ],
        totalDuration: 40,
      };

      mockExecutor.executeFile.mockResolvedValue(mockResult);

      process.argv = ['node', 'sequelae', 'file', 'migration.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('CREATE OK'));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
      // Should exit with error due to failed statement
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    test('should handle file with timeout', async () => {
      const mockResult = {
        success: true,
        results: [
          {
            success: true,
            command: 'SELECT',
            rowCount: 100,
            rows: [],
            fields: [],
            duration: 4500,
          },
        ],
        totalDuration: 4500,
      };

      mockExecutor.executeFile.mockResolvedValue(mockResult);

      process.argv = ['node', 'sequelae', '--timeout', '5000', 'file', 'slow_query.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(mockExecutor.executeFile).toHaveBeenCalledWith('slow_query.sql', true);
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    test('should handle file with no-transaction flag', async () => {
      const mockResult = {
        success: true,
        results: [
          {
            success: true,
            command: 'VACUUM',
            rowCount: 0,
            rows: [],
            fields: [],
            duration: 100,
          },
        ],
        totalDuration: 100,
      };

      mockExecutor.executeFile.mockResolvedValue(mockResult);

      process.argv = ['node', 'sequelae', '--no-transaction', 'file', 'maintenance.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(mockExecutor.executeFile).toHaveBeenCalledWith('maintenance.sql', false);
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    test('should handle permission error on file', async () => {
      mockExecutor.executeFile.mockRejectedValue(new Error('EACCES: permission denied'));

      process.argv = ['node', 'sequelae', 'file', 'protected.sql'];
      const { main } = require('../src/cli');
      await main();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
