/**
 * Directory Management
 *
 * Manages the .codeviz/ directory structure for CodeViz data.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * CodeViz directory name
 */
export const CODEVIZ_DIR = '.codeviz';

/**
 * Get the .codeviz directory path for a project
 */
export function getCodeVizDir(projectRoot: string): string {
  return path.join(projectRoot, CODEVIZ_DIR);
}

/**
 * Check if a project has been initialized with CodeViz
 * Requires both .codeviz/ directory AND codeviz.db to exist
 */
export function isInitialized(projectRoot: string): boolean {
  const codevizDir = getCodeVizDir(projectRoot);
  if (!fs.existsSync(codevizDir) || !fs.statSync(codevizDir).isDirectory()) {
    return false;
  }
  // Must have codeviz.db, not just .codeviz folder
  const dbPath = path.join(codevizDir, 'codeviz.db');
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .codeviz/
 *
 * Walks up from the given path to find a CodeViz-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .codeviz/, or null if not found
 */
export function findNearestCodeVizRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/**
 * Create the .codeviz directory structure
 * Note: Only throws if codeviz.db already exists, not just if .codeviz/ exists.
 */
export function createDirectory(projectRoot: string): void {
  const codevizDir = getCodeVizDir(projectRoot);
  const dbPath = path.join(codevizDir, 'codeviz.db');

  // Only throw if CodeViz is actually initialized (db exists)
  // .codeviz/ folder alone is fine
  if (fs.existsSync(dbPath)) {
    throw new Error(`CodeViz already initialized in ${projectRoot}`);
  }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(codevizDir, { recursive: true });

  // Create .gitignore inside .codeviz (if it doesn't exist)
  const gitignorePath = path.join(codevizDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    const gitignoreContent = `# CodeViz data files
# These are local to each machine and should not be committed

# Database
*.db
*.db-wal
*.db-shm

# Cache
cache/

# Logs
*.log

# Hook markers
.dirty
`;

    fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
  }
}

/**
 * Remove the .codeviz directory
 */
export function removeDirectory(projectRoot: string): void {
  const codevizDir = getCodeVizDir(projectRoot);

  if (!fs.existsSync(codevizDir)) {
    return;
  }

  // Verify .codeviz is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(codevizDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(codevizDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(codevizDir);
    return;
  }

  // Recursively remove directory
  fs.rmSync(codevizDir, { recursive: true, force: true });
}

/**
 * Get all files in the .codeviz directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const codevizDir = getCodeVizDir(projectRoot);

  if (!fs.existsSync(codevizDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .codeviz
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(codevizDir);
  return files;
}

/**
 * Get the total size of the .codeviz directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const codevizDir = getCodeVizDir(projectRoot);

  if (!fs.existsSync(codevizDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .codeviz
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(codevizDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .codeviz
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeVizDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .codeviz directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const codevizDir = getCodeVizDir(projectRoot);

  if (!fs.existsSync(codevizDir)) {
    errors.push('CodeViz directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codevizDir).isDirectory()) {
    errors.push('.codeviz exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair missing .gitignore (non-critical file)
  const gitignorePath = path.join(codevizDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    try {
      const gitignoreContent = `# CodeViz data files\n# These are local to each machine and should not be committed\n\n# Database\n*.db\n*.db-wal\n*.db-shm\n\n# Cache\ncache/\n\n# Logs\n*.log\n\n# Hook markers\n.dirty\n`;
      fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
    } catch {
      // Non-fatal: warn but don't block
      errors.push('.gitignore missing in .codeviz directory and could not be created');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
