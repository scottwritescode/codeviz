/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers
 * debounced sync operations to keep CodeViz up-to-date.
 *
 * Uses Node.js native fs.watch with one watcher per directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CodeVizConfig } from '../types';
import { shouldIncludeFile } from '../extraction';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';

/**
 * Options for the file watcher
 */
export interface WatchOptions {
  /**
   * Debounce delay in milliseconds.
   * After the last file change, wait this long before triggering sync.
   * Default: 2000ms
   */
  debounceMs?: number;

  /**
   * Callback when a sync completes (for logging/diagnostics).
   */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;

  /**
   * Callback when a sync errors (for logging/diagnostics).
   */
  onSyncError?: (error: Error) => void;
}

/**
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Minimal resource usage (native OS file events, no polling)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters against CodeViz include/exclude patterns
 * - Ignores .codeviz/ directory changes
 */
export class FileWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fileSnapshot = new Map<string, number>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hasChanges = false;
  private syncing = false;
  private stopped = false;

  private readonly projectRoot: string;
  private readonly config: CodeVizConfig;
  private readonly debounceMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];

  constructor(
    projectRoot: string,
    config: CodeVizConfig,
    syncFn: () => Promise<{ filesChanged: number; durationMs: number }>,
    options: WatchOptions = {}
  ) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.syncFn = syncFn;
    this.debounceMs = options.debounceMs ?? 2000;
    this.onSyncComplete = options.onSyncComplete;
    this.onSyncError = options.onSyncError;
  }

  /**
   * Start watching for file changes.
   * Returns true if watching started successfully, false otherwise.
   */
  start(): boolean {
    if (this.watchers.size > 0 || this.pollTimer) return true; // Already watching
    this.stopped = false;

    if (this.shouldUsePolling()) {
      this.startPolling();
      logDebug('File watcher started with polling', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
      return true;
    }

    const started = this.watchDirectoryRecursive(this.projectRoot);

    if (started) {
      logDebug('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
    }
    return started;
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    this.stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.fileSnapshot.clear();

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    this.hasChanges = false;
    logDebug('File watcher stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isActive(): boolean {
    return (this.watchers.size > 0 || this.pollTimer !== null) && !this.stopped;
  }

  private shouldUsePolling(): boolean {
    const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    return nodeMajor === 25;
  }

  private startPolling(): void {
    this.fileSnapshot = this.scanFiles();
    this.pollTimer = setInterval(() => this.pollForChanges(), 100);
  }

  private pollForChanges(): void {
    if (this.stopped) return;

    const nextSnapshot = this.scanFiles();
    let changedPath: string | undefined;

    for (const [filePath, mtimeMs] of nextSnapshot) {
      if (this.fileSnapshot.get(filePath) !== mtimeMs) {
        changedPath = filePath;
        break;
      }
    }

    if (!changedPath) {
      for (const filePath of this.fileSnapshot.keys()) {
        if (!nextSnapshot.has(filePath)) {
          changedPath = filePath;
          break;
        }
      }
    }

    this.fileSnapshot = nextSnapshot;

    if (changedPath) {
      this.markChange(changedPath);
    }
  }

  private scanFiles(): Map<string, number> {
    const files = new Map<string, number>();
    const visit = (dir: string) => {
      if (this.shouldIgnoreDirectory(dir)) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }

        const relative = normalizePath(path.relative(this.projectRoot, fullPath));
        if (!shouldIncludeFile(relative, this.config)) {
          continue;
        }

        try {
          files.set(relative, fs.statSync(fullPath).mtimeMs);
        } catch {
          // The file may have disappeared during the scan.
        }
      }
    };

    visit(this.projectRoot);
    return files;
  }

  private watchDirectoryRecursive(dir: string): boolean {
    let started = false;
    const visit = (currentDir: string) => {
      if (this.stopped || this.watchers.has(currentDir) || this.shouldIgnoreDirectory(currentDir)) {
        return;
      }

      try {
        const watcher = fs.watch(currentDir, (_eventType, filename) => {
          if (!filename || this.stopped) return;

          const fullPath = path.join(currentDir, filename.toString());
          if (fs.existsSync(fullPath)) {
            try {
              if (fs.statSync(fullPath).isDirectory()) {
                this.watchDirectoryRecursive(fullPath);
              }
            } catch {
              // The path may have disappeared between the event and stat.
            }
          }

          this.handleChange(fullPath);
        });

        watcher.on('error', (err) => {
          logWarn('File watcher error', { error: String(err) });
          this.watchers.delete(currentDir);
        });

        this.watchers.set(currentDir, watcher);
        started = true;
      } catch (err) {
        logWarn('Could not start file watcher for directory', { directory: currentDir, error: String(err) });
        return;
      }

      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          visit(path.join(currentDir, entry.name));
        }
      }
    };

    visit(dir);
    return started;
  }

  private shouldIgnoreDirectory(dir: string): boolean {
    const relative = normalizePath(path.relative(this.projectRoot, dir));
    if (!relative) return false;
    if (relative === '.codeviz' || relative.startsWith('.codeviz/')) return true;
    return !shouldIncludeFile(`${relative}/__codeviz_watch__.ts`, this.config);
  }

  private markChange(normalized: string): void {
    // Ignore .codeviz/ directory changes (our own DB writes)
    if (
      normalized === '.codeviz' ||
      normalized.startsWith('.codeviz/') ||
      normalized.startsWith('.codeviz\\')
    ) {
      return;
    }

    // Filter against include/exclude patterns
    if (!shouldIncludeFile(normalized, this.config)) {
      return;
    }

    logDebug('File change detected', { file: normalized });
    this.hasChanges = true;
    this.scheduleSync();
  }

  private handleChange(fullPath: string): void {
    this.markChange(normalizePath(path.relative(this.projectRoot, fullPath)));
  }

  /**
   * Schedule a debounced sync.
   */
  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  /**
   * Flush pending changes by running sync.
   */
  private async flush(): Promise<void> {
    // If already syncing, the post-sync check will re-trigger
    if (this.syncing || this.stopped) return;

    this.hasChanges = false;
    this.syncing = true;

    try {
      const result = await this.syncFn();
      this.onSyncComplete?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logWarn('Watch sync failed', { error: error.message });
      this.onSyncError?.(error);
    } finally {
      this.syncing = false;

      // If new changes arrived during sync, schedule another
      if (this.hasChanges && !this.stopped) {
        this.scheduleSync();
      }
    }
  }
}
